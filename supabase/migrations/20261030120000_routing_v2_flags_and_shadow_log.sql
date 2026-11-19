-- SMS reply routing v2, PR-A: flags (all off) + a separate shadow decision log.
--
-- Additive only, no data step, idempotent. Nothing changes for any org until an owner
-- sets routing_v2_flags.shadow = true; with every flag false the live engine runs exactly
-- as before. A missing column reads as "all off" in code.
--
-- The shadow log is NOT read by /jev/review or any live path (it is not
-- sms_classification_runs), so shadow rows never mix with live decisions. Service role only.
--
-- Rollback note: set routing_v2_flags = default (all false) to stop shadow writes.
-- Full removal (safe, nothing live reads either object):
--   drop table if exists public.routing_v2_shadow_decisions;
--   alter table public.ai_responder_configs drop constraint if exists ai_responder_configs_routing_v2_flags_check;
--   alter table public.ai_responder_configs drop column if exists routing_v2_flags;
begin;
set local lock_timeout = '5s';

alter table public.ai_responder_configs
  add column if not exists routing_v2_flags jsonb not null default jsonb_build_object(
    'shadow', false,
    'questions_live', false,
    'replies', false,
    'drips', false,
    'haiku', false,
    'price_check', false,
    'alert_on_time_only', false,
    'wrong_number_all', false,
    'model_stop_suppression', false,
    'canary_property_ids', jsonb_build_array(),
    'canary_percent', 0
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_responder_configs_routing_v2_flags_check'
  ) then
    alter table public.ai_responder_configs
      add constraint ai_responder_configs_routing_v2_flags_check
      check (jsonb_typeof(routing_v2_flags) = 'object');
  end if;
end $$;

comment on column public.ai_responder_configs.routing_v2_flags is
  'SMS reply routing v2 slice flags (booleans, all default false) plus canary_property_ids and canary_percent. PR-A reads only "shadow".';

create table if not exists public.routing_v2_shadow_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  conversation_id uuid,
  inbound_message_id uuid,
  status text not null check (status in ('decided', 'failed')),
  road text,
  provenance jsonb,
  haiku_eligibility text,
  opportunity_alert boolean,
  probabilities jsonb,
  property_type jsonb,
  failure_reason text,
  model text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create unique index if not exists routing_v2_shadow_decisions_inbound_uidx
  on public.routing_v2_shadow_decisions (inbound_message_id)
  where inbound_message_id is not null;
create index if not exists routing_v2_shadow_decisions_org_created_idx
  on public.routing_v2_shadow_decisions (org_id, created_at desc);

alter table public.routing_v2_shadow_decisions enable row level security;
revoke all on public.routing_v2_shadow_decisions from public, anon, authenticated;
grant select, insert on public.routing_v2_shadow_decisions to service_role;

comment on table public.routing_v2_shadow_decisions is
  'Routing v2 shadow decisions (PR-A). Record only: never read by /jev/review or the live engine.';

commit;
