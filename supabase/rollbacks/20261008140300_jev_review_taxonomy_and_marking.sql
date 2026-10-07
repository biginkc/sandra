-- Rollback for 20261008140300_jev_review_taxonomy_and_marking.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_mark_ai_disposition_review_reviewed(uuid);
drop function if exists public.fn_mark_jev_lead_decision_reviewed(uuid);
drop function if exists public.fn_begin_ai_disposition_review_correction(uuid, text);
drop function if exists public.fn_record_ai_disposition_review_correction(uuid, text, text);
drop function if exists public.fn_begin_jev_lead_decision_correction(uuid, text);
drop function if exists public.fn_record_jev_lead_decision_correction(uuid, text, text);

-- Tables / columns / constraints
-- Columns.
alter table if exists public.ai_disposition_reviews
  drop column if exists human_reviewed_at,
  drop column if exists human_reviewed_by;
alter table if exists public.jev_lead_decisions
  drop column if exists human_reviewed_at,
  drop column if exists human_reviewed_by;

-- Constraints back to their pre-migration definitions. NOT VALID so rows that
-- already hold a widened value (dnc / opted_out / new_lead) cannot block a
-- rollback; new writes are still checked. Guarded so a repeated rollback after
-- the earlier rollbacks removed the column/table is a no-op.
do $$
begin
  if to_regclass('public.ai_disposition_reviews') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'ai_disposition_reviews' and column_name = 'corrected_disposition'
     ) then
    alter table public.ai_disposition_reviews
      drop constraint if exists ai_disposition_reviews_corrected_disposition_check;
    alter table public.ai_disposition_reviews
      add constraint ai_disposition_reviews_corrected_disposition_check
      check (corrected_disposition is null or corrected_disposition in
        ('wrong_number', 'not_interested', 'nurture')) not valid;
  end if;
end $$;
do $$
begin
  if to_regclass('public.jev_lead_decisions') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'jev_lead_decisions' and column_name = 'resolved_outcome'
     ) then
    alter table public.jev_lead_decisions
      drop constraint if exists jev_lead_decisions_resolved_outcome_check;
    alter table public.jev_lead_decisions
      add constraint jev_lead_decisions_resolved_outcome_check
      check (resolved_outcome is null or resolved_outcome in
        ('new_lead', 'nurture', 'wrong_number', 'not_interested')) not valid;
  end if;
end $$;

commit;
