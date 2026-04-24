-- ============================================================================
-- Skip-trace V1 — Tracerfy provider, request-and-approve flow
--
-- Adds:
--   · 'pending_approval' + 'denied' to jobs.status (for the VA→admin
--     approval gate on cost-bearing skip-trace runs)
--   · 'tracerfy' to jobs.provider
--   · skip_trace_cache table (per-provider per-address cache, 90d TTL
--     enforced at read time; mirrors `cass_cache`)
--   · skip_trace_cache to reset_tenant_tables() so integration tests
--     start clean
--
-- jobs.type already reserves 'skip_trace' (migration 001) — no change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- jobs.status — add 'pending_approval' + 'denied'
-- ----------------------------------------------------------------------------
alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check check (status = any (array[
  'pending_approval'::text,
  'queued'::text,
  'running'::text,
  'completed'::text,
  'failed'::text,
  'partial'::text,
  'canceled'::text,
  'denied'::text
]));

-- ----------------------------------------------------------------------------
-- jobs.provider — add 'tracerfy'
-- ----------------------------------------------------------------------------
alter table jobs drop constraint jobs_provider_check;
alter table jobs add constraint jobs_provider_check check (provider = any (array[
  'apify'::text,
  'smartystreets'::text,
  'lob'::text,
  'dialpad'::text,
  'twilio'::text,
  'resend'::text,
  'internal'::text,
  'mock'::text,
  'tracerfy'::text
]));

-- ----------------------------------------------------------------------------
-- skip_trace_cache — per-provider per-address cache, 90d TTL at read
-- ----------------------------------------------------------------------------
create table skip_trace_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  address_normalized text not null,
  result jsonb not null,
  match_count integer not null default 0,
  cost_credits integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index idx_skip_trace_cache_unique
  on skip_trace_cache (provider, address_normalized);
create index idx_skip_trace_cache_recent
  on skip_trace_cache (created_at desc);

alter table skip_trace_cache enable row level security;
create policy skip_trace_cache_authenticated_all on skip_trace_cache
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- reset_tenant_tables() — include skip_trace_cache so tests start clean
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
    cass_cache,
    skip_trace_cache
  restart identity cascade;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;

-- ----------------------------------------------------------------------------
-- notifications.event_type — add 'skip_trace_requested'
-- (VAs requesting skip-trace notify all admins via the existing bell)
-- ----------------------------------------------------------------------------
alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'owner_message_added'::text,
  'property_assigned'::text,
  'bulk_action_completed'::text,
  'skip_trace_requested'::text
]));
