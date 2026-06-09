-- 064_closer_practice_duration_constraint.sql
--
-- Test already received 063 before the non-negative duration check was added.
-- Keep production and test aligned without replaying an edited migration.

begin;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'closer_practice_outcomes_duration_seconds_nonnegative'
      and conrelid = 'public.closer_practice_outcomes'::regclass
  ) then
    alter table public.closer_practice_outcomes
      add constraint closer_practice_outcomes_duration_seconds_nonnegative
      check (duration_seconds is null or duration_seconds >= 0);
  end if;
end;
$$;

commit;
