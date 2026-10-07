-- Rollback for 20261008140200_jev_ai_disposition_review_correction.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_correct_ai_disposition_review(uuid, text, text);

-- Tables / columns / constraints
alter table if exists public.ai_disposition_reviews
  drop constraint if exists ai_disposition_reviews_correction_tuple_check,
  drop constraint if exists ai_disposition_reviews_corrected_disposition_check,
  drop column if exists corrected_disposition,
  drop column if exists corrected_at,
  drop column if exists corrected_by,
  drop column if exists correction_reason;

commit;
