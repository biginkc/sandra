-- 084: drop ai_responder_configs.daily_send_cap
--
-- Jarrad's standing rule (2026-06-12): no client-side volume caps,
-- anywhere — provider/API credits are the only cap. The AI responder's
-- org-wide 24h send ceiling is removed along with the bulk-SMS dailyCap.
-- Per-thread max_turns stays (conversation-quality escalation gate,
-- not a volume cap).
--
-- DEPLOY ORDER: apply AFTER the app deploy that removes all reads of
-- this column (same PR) — the old build selects daily_send_cap by name
-- and would 500 if the column disappears first.

alter table ai_responder_configs
  drop column if exists daily_send_cap;
