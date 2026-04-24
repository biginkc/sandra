-- ============================================================================
-- Feature 6 polish — store the AI escalation reason
--
-- The AI dispatcher already flips `needs_human_attention=true` whenever a
-- gate fires (keyword match, model-side escalate, low confidence, hostile
-- sentiment, unsafe body, send blocked, generate error) — but until now
-- we threw the *reason* away. The VA could see "AI handed this off"
-- without any way to know whether to expect anger, a price ask, or a
-- legal question on the other side.
--
-- One row, latest-wins. We don't need a full audit trail today — the
-- escalation gets dismissed and the next escalation overwrites. If we
-- ever want history, fold this into a separate `ai_escalations` table.
-- ============================================================================

alter table properties
  add column if not exists last_ai_escalation_reason text,
  add column if not exists last_ai_escalation_at timestamptz;
