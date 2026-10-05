-- Roll back 20261005120000_next_step_schema.
-- Run ONLY after the relabel data rollback (fn_my_leads_housekeeping_rollback for every
-- applied 'relabel' / 'offer_follow_up_backfill' run) and after later migrations that read
-- tasks.mode / tasks.next_step_kind are rolled back: rows carrying the new attribution
-- sources would violate the restored check, and any in-person appointment or relabeled
-- follow_up keeping a lead-next-action key would violate the restored task check.
-- MUST ship with a code revert (schemaReady() makes the app fall back to the legacy path
-- once the columns are gone, within its 30 second negative cache).
begin;

drop function if exists public.fn_my_leads_schema_probe(text[], text[]);
drop table if exists public.my_leads_feature_flags;

alter table public.acquisition_appointment_attribution
  drop constraint if exists acquisition_appointment_attribution_source_check;
alter table public.acquisition_appointment_attribution
  add constraint acquisition_appointment_attribution_source_check check (source = 'booking_insert');

alter table public.tasks drop constraint if exists tasks_lead_next_action_follow_up_check;
alter table public.tasks add constraint tasks_lead_next_action_follow_up_check
  check (lead_next_action_idempotency_key is null or type = 'follow_up');

alter table public.tasks
  drop constraint if exists tasks_location_check,
  drop constraint if exists tasks_in_person_appointment_check,
  drop constraint if exists tasks_mode_check;
alter table public.tasks
  drop column if exists next_step_kind,
  drop column if exists location,
  drop column if exists mode;

commit;
