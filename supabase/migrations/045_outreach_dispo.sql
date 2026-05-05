-- ============================================================================
-- Feature — Prospect Outreach Disposition (migration 045)
--
-- Adds `outreach_dispo` as a third tracking axis on properties, alongside
-- `status` (pipeline position) and `motivation_level` (seller temperature).
-- Records what happened when we tried to reach the prospect:
--
--   wrong_number       — number doesn't belong to the owner; need re-skip-trace
--   bad_number         — disconnected / non-working
--   not_interested     — verbal decline; nurture drip may still continue
--   opted_out          — STOP keyword or explicit legal opt-out (mirrors consent_events)
--   dnc                — conversational "do not call me" (TCPA-relevant suppression)
--   nurture            — "follow up later"; follow_up_at must be set
--   callback_requested — owner asked for a call at a specific time; follow_up_at must be set
--
-- `follow_up_at` is nullable and meaningful only when dispo = nurture or
-- callback_requested; all other values leave it null.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml to both
--   - prod (copflsklaefwzipsrjqz)
--   - test (ncsngxlcyxylaeskiteu)
-- ============================================================================

alter table properties
  add column outreach_dispo text
    check (outreach_dispo is null or outreach_dispo in (
      'wrong_number',
      'bad_number',
      'not_interested',
      'opted_out',
      'dnc',
      'nurture',
      'callback_requested'
    ));

alter table properties
  add column follow_up_at timestamptz;

-- Sparse index — only the minority of rows with a dispo set are interesting
-- for "show me all opted-out prospects" queries.
create index idx_properties_outreach_dispo
  on properties (outreach_dispo)
  where outreach_dispo is not null;
