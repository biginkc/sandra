-- ============================================================================
-- Skip-trace V2 polish — per-property kill switch
--
-- Mirrors the existing `ai_responder_disabled` pattern. When true, the
-- property is excluded from any skip-trace request — bulk requests
-- silently skip it, single-row requests refuse with a friendly error.
--
-- Use case: a VA marks a property as "do not skip-trace" because the
-- homeowner is on a do-not-contact list, the property is already under
-- contract elsewhere, or the team doesn't want to spend Tracerfy
-- credits on it. Survives bulk requests where someone forgot to
-- de-select it.
-- ============================================================================

alter table properties
  add column if not exists skip_trace_disabled boolean not null default false;
