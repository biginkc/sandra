-- ============================================================================
-- Testing infrastructure Tier 1 — append-only log of SMS delivered to our
-- Twilio test-receiver numbers.
--
-- Purpose: close the "did the carrier actually deliver this?" gap in the
-- test pyramid. E2E tests send via Dialpad → Twilio test number →
-- Twilio fires /api/webhooks/test-receiver → we persist here → test
-- polls this table and asserts body/timing match.
--
-- Dev / staging ONLY in practice. Prod code writes nothing here; if a
-- stray webhook hit prod it'd still work but the row would be orphan
-- data. RLS matches other tenant tables (authenticated-all) so future
-- admin tooling can surface a live deliverability view if desired.
-- ============================================================================

create table test_sms_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'twilio',
  -- Provider-assigned id (Twilio MessageSid). Nullable to tolerate
  -- malformed payloads we want to still persist for debugging.
  external_id text,
  -- Our Twilio test number that received the message.
  to_number text not null,
  -- Sender as reported by Twilio (typically the Dialpad number that sent).
  from_number text not null,
  body text not null,
  received_at timestamptz not null default now(),
  signature_verified boolean not null default false,
  -- Raw form-encoded payload from Twilio, stored for audit/debug.
  raw_payload jsonb not null
);

-- Fast lookup by recipient for the most common test query: "show me the
-- last N messages that hit +1xxx".
create index idx_test_sms_log_to_received
  on test_sms_log (to_number, received_at desc);

-- Uniqueness of (provider, external_id) prevents double-insert on
-- Twilio retries. Partial so rows missing external_id still land.
create unique index idx_test_sms_log_external_unique
  on test_sms_log (provider, external_id)
  where external_id is not null;

alter table test_sms_log enable row level security;

-- Same pattern as consent_events / lead_notes / notifications — authed
-- users see everything in their org. Service role (webhook inserts)
-- bypasses RLS regardless. Per-user narrowing deferred to Risk #14.
create policy test_sms_log_authenticated_all on test_sms_log
  for all
  to authenticated
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- Add test_sms_log to the integration-test reset function. Matches the
-- pattern established in migration 016 — every new tenant table gets
-- listed explicitly so tests start from a clean slate.
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
