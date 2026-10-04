-- Roll back 20261005110000. Narrows the outcome check back, but ONLY when no row uses
-- the new values. If this raises, first run
-- fn_my_leads_housekeeping_rollback(<close_attempts run>) and resolve any voicemail rows.
begin;

do $$
begin
  if exists (
    select 1 from public.acquisition_attempts
    where outcome in ('voicemail', 'not_logged')
  ) then
    raise exception 'ROLLBACK_BLOCKED: acquisition_attempts rows use voicemail/not_logged';
  end if;
end $$;

alter table public.acquisition_attempts drop constraint if exists acquisition_attempts_outcome_check;
alter table public.acquisition_attempts
  add constraint acquisition_attempts_outcome_check
  check (outcome in ('no_answer', 'reached', 'wrong_number'));

commit;
