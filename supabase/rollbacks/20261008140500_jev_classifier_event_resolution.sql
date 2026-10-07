-- Rollback for 20261008140500_jev_classifier_event_resolution.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_promote_classifier_event_to_decision(uuid);

-- Tables / columns / constraints
-- proposed_outcome back to the 20261008140100 definition (NOT VALID: existing
-- promoted unclear/bad_number rows must not block the rollback).
do $$
begin
  if to_regclass('public.jev_lead_decisions') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'jev_lead_decisions' and column_name = 'proposed_outcome'
     ) then
    alter table public.jev_lead_decisions
      drop constraint if exists jev_lead_decisions_proposed_outcome_check;
    alter table public.jev_lead_decisions
      add constraint jev_lead_decisions_proposed_outcome_check
      check (proposed_outcome in ('new_lead', 'nurture')) not valid;
  end if;
end $$;

commit;
