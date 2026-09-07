begin;
alter table public.call_activities add column call_purpose text not null default 'customer'
  check (call_purpose in ('customer', 'internal_training'));
alter table public.call_activities add constraint training_call_is_unlinked check (
  call_purpose <> 'internal_training' or (
    provider = 'sandra_softphone' and property_id is null and contact_id is null
    and dialer_batch_item_id is null and not do_not_call_requested and disposition is null
  )
);
-- A signed server start creates the record before the browser can connect.
-- Subsequent ordinary wrap-up and provider artifact updates retain its purpose.
create function public.guard_homeowner_training_call() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if new.call_purpose = 'internal_training' and coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Only the server may create training calls' using errcode = '42501';
    end if;
  elsif new.call_purpose is distinct from old.call_purpose then
    raise exception 'Call purpose is immutable' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and old.call_purpose = 'internal_training' and (
    new.org_id is distinct from old.org_id or new.provider is distinct from old.provider
    or new.jitter_attempt_id is distinct from old.jitter_attempt_id
    or (new.operator_user_id is not null and new.operator_user_id is distinct from old.operator_user_id)
    or new.phone_e164 is distinct from old.phone_e164
  ) then
    raise exception 'Training call identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_homeowner_training_call before insert or update on public.call_activities
for each row execute function public.guard_homeowner_training_call();
comment on column public.call_activities.call_purpose is 'Immutable server-assigned call purpose. Internal training never links customer records.';
commit;
