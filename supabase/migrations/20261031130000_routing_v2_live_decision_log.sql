-- Cutover decision evidence is separate from shadow. No flags change and no backfill.
begin;
set local lock_timeout = '5s';
create table if not exists public.routing_v2_live_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  conversation_id uuid,
  inbound_message_id uuid not null unique,
  status text not null check (status in ('decided', 'failed')),
  -- road is the actionable result after Haiku and repairs/price handling. The original
  -- Jev road and provenance stay separate so they cannot impersonate a Haiku verdict.
  road text,
  jev_road text,
  provenance jsonb,
  haiku_eligibility text,
  haiku jsonb,
  opportunity_alert boolean,
  probabilities jsonb,
  property_type jsonb,
  action jsonb,
  expected_revision bigint not null check (expected_revision >= 0),
  price_outcome text,
  failure_reason text,
  model text,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists routing_v2_live_decisions_org_created_idx
  on public.routing_v2_live_decisions (org_id, created_at desc);
alter table public.routing_v2_live_decisions enable row level security;
revoke all on public.routing_v2_live_decisions from public, anon, authenticated, service_role;
grant select, insert on public.routing_v2_live_decisions to service_role;
comment on table public.routing_v2_live_decisions is
  'Immutable live routing-v2 evidence. Shadow rows can never authorize a live action. Service-role only.';
commit;
