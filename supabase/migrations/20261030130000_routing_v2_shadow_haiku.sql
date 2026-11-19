-- SMS reply routing v2, PR-D: record Haiku's second opinion in the shadow log.
--
-- Additive only, idempotent, no data step. Written only when routing_v2_flags.shadow AND
-- routing_v2_flags.haiku are true (both default false). Record only: nothing live reads it.
-- Shape: {asked, option, confidence, failure_reason, latency_ms, attempts, input_tokens,
-- output_tokens, cost_usd, final_road, final_by, hold, alert}.
--
-- Rollback: alter table public.routing_v2_shadow_decisions drop column if exists haiku;
begin;
set local lock_timeout = '5s';

alter table public.routing_v2_shadow_decisions add column if not exists haiku jsonb;

comment on column public.routing_v2_shadow_decisions.haiku is
  'Routing v2 PR-D: Haiku second-opinion result and the policy''s final road (shadow only).';

commit;
