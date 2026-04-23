-- ============================================================================
-- Make team-member offboarding safe.
--
-- Three tables reference `auth.users` to record who did something:
--   csv_imports.user_id        — who ran the import
--   jobs.created_by            — who kicked off the job
--   property_merges.merged_by  — who merged two property rows
--
-- All three were created with the default NO ACTION FK semantics, which
-- blocks deletion of the referenced auth.users row. That meant the
-- /admin/users "Remove" button errored with `REMOVE_FAILED` whenever the
-- target had any historical activity.
--
-- Historical rows should SURVIVE off-boarding (audit trail, compliance).
-- The fix is ON DELETE SET NULL — the user row goes away, the activity
-- rows stay with a null user reference. Matches how we already treat
-- `messages.contact_id` on contact deletion.
-- ============================================================================

alter table csv_imports drop constraint if exists csv_imports_user_id_fkey;
alter table csv_imports
  add constraint csv_imports_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

alter table jobs drop constraint if exists jobs_created_by_fkey;
alter table jobs
  add constraint jobs_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table property_merges drop constraint if exists property_merges_merged_by_fkey;
alter table property_merges
  add constraint property_merges_merged_by_fkey
  foreign key (merged_by) references auth.users(id) on delete set null;
