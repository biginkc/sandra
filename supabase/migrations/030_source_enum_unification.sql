-- 030_source_enum_unification.sql
--
-- Replaces the `properties.source` enum with the canonical, shared
-- vocabulary used by the import wizard, the lead-import webhook, the
-- manual entry form, and any future intake surface. The previous enum
-- conflated "vendor / tool" (where the data came from) with "channel /
-- activity" (how the lead originated) and tried to be both at once.
-- That muddled both surfaces; this migration replaces it with a single
-- list of marketing channels + the two vendors actually used today.
--
-- Final allowed values:
--   - dealmachine          (vendor — D4D app)
--   - propstream           (vendor — list-based)
--   - driving_for_dollars  (channel — manual D4D, not via app)
--   - referral             (channel)
--   - cold_call            (channel — VA dialing via Enzo or similar)
--   - sms                  (channel — inbound SMS marketing)
--   - web_form             (channel — public-facing site / PPC)
--   - direct_mail          (channel)
--
-- Removed values: mls, skip_trace, probate, pre_foreclosure, other.
-- These either belonged in a different field (skip_trace was an
-- enrichment, not a source) or are list types instead of channels
-- (probate, pre_foreclosure → pre-populated lists, see migration 031).
--
-- Backfill: per the operator (2026-04-29), the existing 1,382 rows
-- tagged source='other' all came from D4D imports, so they're moved
-- to 'driving_for_dollars'. The 1 row with source=NULL stays NULL —
-- truthful "we don't know."

begin;

-- 1. Move legacy 'other' rows to driving_for_dollars (per operator
--    confirmation: all current 'other' rows are D4D imports).
update properties
set source = 'driving_for_dollars'
where source = 'other';

-- Defensive: any row still on a removed value (probate, pre_foreclosure,
-- skip_trace, mls) gets moved to driving_for_dollars too. Today prod
-- has zero rows with these values, but the test project might.
update properties
set source = 'driving_for_dollars'
where source in ('mls', 'probate', 'pre_foreclosure', 'skip_trace');

-- 2. Replace the CHECK constraint with the new vocabulary.
alter table properties
  drop constraint if exists properties_source_check;

alter table properties
  add constraint properties_source_check
  check (
    source is null
    or source = any (array[
      'dealmachine',
      'propstream',
      'driving_for_dollars',
      'referral',
      'cold_call',
      'sms',
      'web_form',
      'direct_mail'
    ])
  );

commit;
