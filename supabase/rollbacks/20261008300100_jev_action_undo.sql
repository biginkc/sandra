-- Rollback for 20261008300100_jev_action_undo.
begin;
drop function if exists public.fn_undo_jev_action(uuid);
drop table if exists public.jev_action_undo;
update public.jev_lead_decisions set resolved_outcome = 'nurture' where resolved_outcome = 'undone';
alter table public.jev_lead_decisions
  drop constraint if exists jev_lead_decisions_resolved_outcome_check;
alter table public.jev_lead_decisions
  add constraint jev_lead_decisions_resolved_outcome_check
  check (resolved_outcome is null or resolved_outcome in
    ('new_lead', 'nurture', 'wrong_number', 'not_interested', 'opted_out', 'dnc'));
commit;
