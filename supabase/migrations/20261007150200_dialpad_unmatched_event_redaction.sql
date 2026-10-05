-- My Leads one-call close, P2 UI (2.10): redaction of unmatched Dialpad call payloads.
--
-- The user-scoped subscription delivers every call the rep makes or receives, personal ones included.
-- Those land as quarantined no_lead_match / no_binding rows whose payload (numbers, names, voicemail
-- transcript) the inbox guard makes immutable and undeletable. Approved by Jarrad (2026-10-04):
-- unmatched payloads are redacted after 30 days. Matched, ambiguous, DNC and conflict events are
-- ledger or compliance evidence and are never redacted. payload_sha256 is deliberately left as it
-- was, so a late redelivery of a redacted event is still recognised as an exact replay.
--
-- dialpad_cti_guard_event() is replaced in full. Base: 20260929120000_dialpad_cti_call_projection.sql
-- lines 45-77 (verified identical to the live definition); the only change is the redaction branch
-- (one new constant, one INSERT check, one `if` that excuses payload+redacted_at under the GUC).
--
-- NO data step: the migration redacts nothing. The service-only function runs from the event sweep
-- cron, gated by schemaReady('event_redaction') in TypeScript. Inert until that cron ships.
begin;

alter table public.dialpad_call_events add column if not exists redacted_at timestamptz;

create or replace function public.dialpad_cti_guard_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['disposition', 'disposition_reason', 'matched_intent_id', 'disposed_at',
    'projected_at', 'process_attempts', 'last_process_error'];
  v_bookkeeping constant text[] := array['projected_at', 'process_attempts', 'last_process_error'];
  v_redaction constant text[] := array['payload', 'redacted_at'];
  v_redacting boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_events are a durable inbox and cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.disposition not in ('received', 'conflict') or new.matched_intent_id is not null
       or new.projected_at is not null or new.process_attempts <> 0 or new.last_process_error is not null
       or new.redacted_at is not null then
      raise exception 'an inbox event must be inserted received or conflict' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Redaction: only the redaction function (which sets the GUC) may change payload, only once, only
  -- on an unmatched quarantined row, and it must stamp redacted_at in the same statement.
  if new.redacted_at is distinct from old.redacted_at or new.payload is distinct from old.payload then
    if old.redacted_at is null and new.redacted_at is not null
       and old.disposition = 'quarantined' and old.disposition_reason in ('no_lead_match', 'no_binding')
       and new.disposition = old.disposition and new.disposition_reason = old.disposition_reason
       and coalesce(current_setting('dialpad_cti.redact', true), '') = '1' then
      v_redacting := true;
    else
      raise exception 'inbox event payload is immutable outside redaction' using errcode = '42501';
    end if;
  end if;
  if (to_jsonb(new) - v_mutable - case when v_redacting then v_redaction else '{}'::text[] end)
     <> (to_jsonb(old) - v_mutable - case when v_redacting then v_redaction else '{}'::text[] end) then
    raise exception 'inbox event evidence is immutable' using errcode = '42501';
  end if;
  if old.projected_at is not null and new.projected_at is distinct from old.projected_at then
    raise exception 'projected_at is forward only' using errcode = '42501';
  end if;
  if old.disposition in ('matched', 'conflict')
     and (to_jsonb(new) - v_bookkeeping) <> (to_jsonb(old) - v_bookkeeping) then
    raise exception 'a % inbox event is terminal', old.disposition using errcode = '42501';
  end if;
  if new.disposition = 'received' and old.disposition <> 'received' then
    raise exception 'an inbox event cannot return to received' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.fn_redact_dialpad_unmatched_events(
  p_older_than interval default interval '30 days',
  p_limit integer default 500
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_older_than is null or p_older_than < interval '1 day' or p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform set_config('dialpad_cti.redact', '1', true);
  with victims as (
    select e.id from public.dialpad_call_events e
    where e.disposition = 'quarantined' and e.disposition_reason in ('no_lead_match', 'no_binding')
      and e.redacted_at is null and e.received_at < now() - p_older_than
    order by e.received_at, e.id
    limit p_limit
    for update skip locked
  )
  update public.dialpad_call_events e
  set payload = jsonb_build_object(
        'call_id', e.payload -> 'call_id', 'state', e.payload -> 'state', 'event_timestamp', e.payload -> 'event_timestamp',
        'direction', e.payload -> 'direction', 'redacted', true),
      redacted_at = now()
  from victims v
  where e.id = v.id;
  get diagnostics v_count = row_count;
  perform set_config('dialpad_cti.redact', '', true);
  return v_count;
end;
$$;
revoke all on function public.fn_redact_dialpad_unmatched_events(interval, integer) from public, anon, authenticated;
grant execute on function public.fn_redact_dialpad_unmatched_events(interval, integer) to service_role;

commit;
