-- ============================================================================
-- Feature 6 — AI SMS auto-responder
--
-- When a seller replies to a Sandra-driven SMS outside of business hours
-- (or anytime, if configured), a Claude-backed responder drafts a first
-- acknowledgment and either sends it via the existing SMS pipeline OR
-- escalates the thread to a human by flagging the property.
--
-- Hard rules:
--   · AI never quotes a price, offer, or dollar amount.
--   · AI never makes commitments about purchase / timeline / process.
--   · Every AI send routes through `sendSmsToContact`, so TCPA consent
--     + quiet-hours checks stay in the single-entry pipeline.
--
-- Escalation is triggered by:
--   · Keyword match on inbound body (4 tiers — handoff / price-offer
--     / legal-contract / distressed-seller).
--   · Claude returning `confidence < 0.70` in its structured output.
--   · Claude returning `sentiment = "frustrated" | "hostile"`.
--   · AI turn count in the thread hits `max_turns` (default 3).
--   · Org-wide daily send cap (default 100/day) exhausted.
--   · Per-property kill switch `properties.ai_responder_disabled`.
--
-- Schema is org-scoped. One active `ai_responder_configs` row per org
-- today; multiple-active-configs (e.g. per-campaign prompts) deferred.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ai_responder_configs — one active row per org
-- ----------------------------------------------------------------------------
create table ai_responder_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  active boolean not null default true,
  -- Versioned Claude model id. Default = Haiku 4.5, the sweet spot of
  -- SMS latency / cost ($0.001-0.002 per reply at our context sizes).
  model text not null default 'claude-haiku-4-5-20251001',
  -- System prompt — editable via `/settings/ai-responder`. Seeded at
  -- migration time with a BMH Group-aware first-touch prompt.
  system_prompt text not null,
  -- Maximum AI replies in one thread before forced escalation.
  max_turns integer not null default 3 check (max_turns >= 1 and max_turns <= 10),
  -- Force-escalate when confidence falls below this threshold.
  min_confidence numeric(3, 2) not null default 0.70
    check (min_confidence >= 0 and min_confidence <= 1),
  -- Keyword triggers, stored as a flat text array for easy edit. UI
  -- groups them into tiers but storage is unified.
  escalation_keywords text[] not null default array[
    -- Tier A — explicit handoff requests
    'human','real person','real human','real agent','speak to',
    'talk to a','talk to an','talk to someone','connect me','stop the bot',
    -- Tier B — price/offer (never commit a number)
    'price','offer','how much','your offer',
    -- Tier C — legal / contract (requires human judgment)
    'lawyer','attorney','legal','lawsuit','contract','earnest',
    'closing','escrow','title company',
    -- Tier D — distressed-seller signals (requires empathy + nuance)
    'died','deceased','passed away','probate','estate',
    'divorce','divorcing','bankruptcy','foreclosure'
  ],
  -- When true, AI only replies during the property's 08:00–21:00 local
  -- window (same gate as outbound sends). When false, AI can reply 24/7
  -- but still can't SEND outside quiet hours — the outbound pipeline
  -- blocks the send, and the AI-drafted reply escalates instead.
  business_hours_only boolean not null default true,
  -- Daily send cap across the whole org. Blocks the 1000-per-day
  -- runaway-webhook scenario at a known dollar ceiling.
  daily_send_cap integer not null default 100 check (daily_send_cap >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create unique index idx_ai_responder_configs_one_active_per_org
  on ai_responder_configs (org_id)
  where active = true;

alter table ai_responder_configs enable row level security;
create policy ai_responder_configs_authenticated_all on ai_responder_configs
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- properties — kill switch + needs-human banner flag
-- ----------------------------------------------------------------------------
alter table properties
  add column if not exists ai_responder_disabled boolean not null default false,
  add column if not exists needs_human_attention boolean not null default false;

-- Partial indexes — both flags are FALSE for most rows, so the true
-- rows are the ones worth indexing for the "show me leads needing
-- attention" query and the "did the VA disable AI here" audit.
create index idx_properties_needs_human_attention
  on properties (updated_at desc)
  where needs_human_attention = true;

create index idx_properties_ai_responder_disabled
  on properties (id)
  where ai_responder_disabled = true;

-- ----------------------------------------------------------------------------
-- Test-reset — add ai_responder_configs so integration tests start clean
-- ----------------------------------------------------------------------------
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    job_items,
    messages,
    consent_events,
    property_merges,
    jobs,
    csv_imports,
    webhook_events,
    notifications,
    lead_notes,
    sequence_step_runs,
    sequence_enrollments,
    sequence_steps,
    sequences,
    ai_responder_configs,
    property_lists,
    property_tags,
    tags,
    lists,
    test_sms_log,
    properties,
    homeowner_details,
    agent_details,
    contacts,
    cass_cache
  restart identity cascade;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;

-- ----------------------------------------------------------------------------
-- Seed one active config per existing org with the V1 system prompt.
-- ----------------------------------------------------------------------------
do $$
declare
  org_id_val uuid;
begin
  for org_id_val in select id from organizations loop
    insert into ai_responder_configs (org_id, system_prompt)
    values (
      org_id_val,
      'You are a real estate acquisition assistant for BMH Group, a wholesale ' ||
      'real-estate investor that buys distressed properties for cash. You text ' ||
      'with property owners who recently received our outreach.' || e'\n\n' ||
      'Your job is FIRST-TOUCH only: acknowledge the seller''s reply, gather ' ||
      'light qualifying info (motivation to sell, timeline, property ' ||
      'condition), and hand warm leads to a human teammate.' || e'\n\n' ||
      'You MUST NOT:' || e'\n' ||
      '- Quote any price, range, or offer. Ever. Not even a ballpark.' || e'\n' ||
      '- Make any commitment about purchase, timeline, or process.' || e'\n' ||
      '- Discuss legal, tax, or financial advice.' || e'\n' ||
      '- Promise anything — no "we will", no "we can", no "we''ll definitely".' || e'\n\n' ||
      'If the seller asks for a price, mentions a lawyer / attorney / contract / ' ||
      'closing / probate / divorce / bankruptcy / foreclosure, or sounds ' ||
      'frustrated or upset, ESCALATE by returning action="escalate" with a clear ' ||
      'escalation_reason.' || e'\n\n' ||
      'Keep replies under 160 characters. Sound like a friendly human, not a ' ||
      'corporate bot. No emojis. No exclamation marks unless the seller used one ' ||
      'first. Use the seller''s first name when known.' || e'\n\n' ||
      'Return structured output with: action ("send_reply" or "escalate"), body ' ||
      '(the reply text, required if action="send_reply"), confidence (0-1, how ' ||
      'sure you are that this reply is safe + on-topic), sentiment ("positive", ' ||
      '"neutral", "frustrated", or "hostile"), and escalation_reason (required ' ||
      'if action="escalate").'
    )
    on conflict do nothing;
  end loop;
end $$;
