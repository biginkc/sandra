-- 065_closer_practice_tenancy_constraints.sql
--
-- Repair test/remote databases that received the first 063 draft before
-- review tightened Closer practice outcome tenancy boundaries.

begin;

drop policy if exists closer_practice_outcomes_org_insert on public.closer_practice_outcomes;
drop policy if exists closer_practice_outcomes_org_update on public.closer_practice_outcomes;
drop policy if exists closer_practice_outcomes_org_delete on public.closer_practice_outcomes;

alter table public.closer_practice_outcomes
  drop constraint if exists closer_practice_outcomes_closer_attempt_id_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'closer_practice_outcomes_org_id_closer_attempt_id_key'
      and conrelid = 'public.closer_practice_outcomes'::regclass
  ) then
    alter table public.closer_practice_outcomes
      add constraint closer_practice_outcomes_org_id_closer_attempt_id_key
      unique (org_id, closer_attempt_id);
  end if;
end;
$$;

commit;
