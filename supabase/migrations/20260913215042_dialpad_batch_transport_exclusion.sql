begin;
-- The batch contract has a creator but no verified active operator identity.
-- Until it does, any active batch in the organization excludes a Dialpad start.
-- These reciprocal guards share the softphone reservation lock; a read-only
-- preflight cannot exclude concurrent claims. Existing claim fencing is intact.
create function public.dialpad_exclude_active_batch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('prepared','initiation_unconfirmed','linked') then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text||':voice-transport',0));
    if exists(select 1 from public.dialer_batches b where b.org_id=new.org_id and b.status in ('claimed','in_progress')) then
      raise exception 'VOICE_BATCH_TRANSPORT_CONFLICT' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
-- Late authenticated evidence may reactivate an intent previously rejected.
-- Conflicting evidence remains in the durable inbox for reconciliation; it must
-- not silently bypass the active-transport invariant through an UPDATE.
create trigger dialpad_exclude_active_batch before insert or update of status on public.dialpad_voice_intents
for each row execute function public.dialpad_exclude_active_batch();

create function public.batch_exclude_active_dialpad() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('claimed','in_progress') then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text||':voice-transport',0));
    if exists(select 1 from public.dialpad_voice_intents i where i.org_id=new.org_id and i.status in ('prepared','initiation_unconfirmed','linked')) then
      raise exception 'VOICE_BATCH_TRANSPORT_CONFLICT' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger batch_exclude_active_dialpad before insert or update of status,org_id on public.dialer_batches
for each row execute function public.batch_exclude_active_dialpad();
revoke all on function public.dialpad_exclude_active_batch(),public.batch_exclude_active_dialpad() from public,anon,authenticated,service_role;
commit;
