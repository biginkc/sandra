-- ============================================================================
-- Add `needs_sequence` as a tag-only outreach disposition.
--
-- The original `outreach_dispo` CHECK was created inline on the column in
-- migration 045, so Postgres names it `properties_outreach_dispo_check`.
-- Keep all existing values and widen the set only.
-- ============================================================================

begin;

alter table properties
  drop constraint if exists properties_outreach_dispo_check;

alter table properties
  add constraint properties_outreach_dispo_check
  check (outreach_dispo is null or outreach_dispo in (
    'wrong_number',
    'bad_number',
    'not_interested',
    'opted_out',
    'dnc',
    'nurture',
    'callback_requested',
    'needs_sequence'
  ));

commit;
