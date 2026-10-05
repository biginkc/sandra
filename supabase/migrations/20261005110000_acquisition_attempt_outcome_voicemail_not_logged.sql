-- My Leads one-call close, P1e (1e.3): widen acquisition_attempts.outcome.
--
-- Adds 'voicemail' (user-selectable from P1c) and 'not_logged' (system-only, set by
-- fn_my_leads_housekeeping_close_attempts). Schema only; no data is touched here.
-- The check is located by definition rather than by name so a renamed constraint on
-- a long-lived database cannot silently leave the narrow check in place.
begin;

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.acquisition_attempts'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%no_answer%'
    and pg_get_constraintdef(c.oid) like '%wrong_number%'
    and pg_get_constraintdef(c.oid) not like '%provider_attempt_key%';
  if v_name is null then
    raise exception 'acquisition_attempts outcome check not found';
  end if;
  execute format('alter table public.acquisition_attempts drop constraint %I', v_name);
end $$;

alter table public.acquisition_attempts
  add constraint acquisition_attempts_outcome_check
  check (outcome is null or outcome in ('no_answer', 'reached', 'wrong_number', 'voicemail', 'not_logged'));

commit;
