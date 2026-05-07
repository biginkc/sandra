-- 053_lead_sources_for_format_helper.sql
--
-- Adds three vendor source values used by the import-wizard's
-- format-helper auto-detection (see PR for `feat/import-format-helper`):
--
--   - titlepro         (TitlePro / DataTree title-event exports —
--                       Death, Cash Purchase, Lis Pendens, Bankruptcy,
--                       Default. Subtype is recorded as a tag, not in
--                       the source field.)
--   - reisift          (REISift / DealMachine Skipped contact exports.
--                       Distinct from `dealmachine` so provenance is
--                       preserved when contacts come through the
--                       skip-trace pipeline rather than the raw D4D app.)
--   - agent_outreach   (BMH per-county agent-outreach Sheets imports.)
--
-- Mirror change in code: src/lib/leads/create.ts `LEAD_SOURCES` const.
-- Future surfaces that read sources should pull from there — the DB
-- CHECK constraint is the floor, not the registry.

begin;

alter table properties
  drop constraint if exists properties_source_check;

alter table properties
  add constraint properties_source_check
  check (
    source is null
    or source = any (array[
      'dealmachine',
      'propstream',
      'titlepro',
      'reisift',
      'agent_outreach',
      'driving_for_dollars',
      'referral',
      'cold_call',
      'sms',
      'web_form',
      'direct_mail'
    ])
  );

commit;
