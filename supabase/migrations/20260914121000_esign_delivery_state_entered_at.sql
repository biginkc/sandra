-- Keep operational age independent of unrelated edits to an eSign request.
alter table public.esign_requests
  add column delivery_state_entered_at timestamptz;

-- Existing rows have no transition history. updated_at is the conservative
-- estimate for their current state's entry time; new transitions are exact.
update public.esign_requests
set delivery_state_entered_at = updated_at;

alter table public.esign_requests
  alter column delivery_state_entered_at set not null,
  alter column delivery_state_entered_at set default now();

create or replace function public.set_esign_delivery_state_entered_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.delivery_state_entered_at := coalesce(new.created_at, pg_catalog.now());
  elsif new.delivery_state is distinct from old.delivery_state then
    new.delivery_state_entered_at := pg_catalog.now();
  else
    new.delivery_state_entered_at := old.delivery_state_entered_at;
  end if;
  return new;
end;
$$;

create trigger set_esign_delivery_state_entered_at
before insert or update on public.esign_requests
for each row execute function public.set_esign_delivery_state_entered_at();

create index esign_requests_delivery_state_age_observer_idx
  on public.esign_requests (delivery_state, delivery_state_entered_at, id)
  where sign_request_id is null
    and delivery_state in ('sending', 'send_unknown');

-- Exclude rows already in the anomaly ledger. Those are checked separately
-- for recovery; this query can therefore find new incidents without a
-- perpetually active oldest row starving the capped scan.
create or replace function public.list_unobserved_esign_sentry_anomalies(
  p_limit integer default 10
)
returns table (request_id uuid, state public.esign_delivery_state)
language sql
security definer
set search_path = ''
as $$
  select request.id, request.delivery_state
  from public.esign_requests request
  where request.sign_request_id is null
    and (
      (request.delivery_state = 'sending'
       and request.delivery_state_entered_at < pg_catalog.now() - interval '15 minutes')
      or
      (request.delivery_state = 'send_unknown'
       and request.delivery_state_entered_at < pg_catalog.now() - interval '60 minutes')
    )
    and not exists (
      select 1 from public.sentry_anomaly_ledger ledger
      where ledger.source_id = request.id::text
        and ledger.signal_kind = case request.delivery_state
          when 'sending' then 'esign_sending_stale'
          else 'esign_send_unknown_stale'
        end
        and ledger.is_active
    )
  order by request.delivery_state_entered_at, request.id
  limit least(greatest(p_limit, 1), 10);
$$;

revoke all on function public.list_unobserved_esign_sentry_anomalies(integer)
  from public, anon, authenticated;
grant execute on function public.list_unobserved_esign_sentry_anomalies(integer)
  to service_role;
