-- Rollback for 20261007150200_dialpad_unmatched_event_redaction. Remove the cron call first.
-- Drops the redaction function and restores the pre-2.10 guard verbatim
-- (20260929120000_dialpad_cti_call_projection.sql:45-77). Rows already redacted stay redacted
-- (intentional: the payload is gone) and the nullable redacted_at column stays as their audit mark.
begin;
drop function if exists public.fn_redact_dialpad_unmatched_events(interval, integer);
create or replace function public.dialpad_cti_guard_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['disposition', 'disposition_reason', 'matched_intent_id', 'disposed_at',
    'projected_at', 'process_attempts', 'last_process_error'];
  v_bookkeeping constant text[] := array['projected_at', 'process_attempts', 'last_process_error'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_events are a durable inbox and cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.disposition not in ('received', 'conflict') or new.matched_intent_id is not null
       or new.projected_at is not null or new.process_attempts <> 0 or new.last_process_error is not null then
      raise exception 'an inbox event must be inserted received or conflict' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
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
commit;
