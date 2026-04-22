-- ============================================================================
-- Consent events — TCPA proof log (Risk #5).
--
-- Replaces the binary `contacts.sms_opted_out` boolean as the source of
-- truth with an append-only event stream. The boolean stays as a
-- fast-path cache; app code maintains it from the event log.
--
-- Distinguishes TCPA's two consent tiers:
--  * opt_in_marketing_written  — prior express WRITTEN consent. Required
--    for any promotional / solicitation message ("we'll buy your house").
--    Proof: signed form / digital checkbox with record.
--  * opt_in_informational      — prior express consent. Sufficient for
--    informational messages only (appointment reminder, delivery status).
--
-- HELP events are logged but don't mutate state — they're informational.
-- ============================================================================

create table consent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  contact_id uuid not null references contacts(id) on delete cascade,
  channel text not null check (channel in ('sms','email','voice')),
  event_type text not null check (event_type in (
    'opt_in_marketing_written',
    'opt_in_informational',
    'opt_in_confirmed',
    'opt_out',
    'help_request',
    'provider_auto_opt_out'
  )),
  source text,
  source_detail jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Latest-state lookup: "what's the current consent for this contact+channel?"
-- Query: order by (contact_id, channel, occurred_at desc) limit 1.
create index idx_consent_events_lookup
  on consent_events (contact_id, channel, occurred_at desc);
create index idx_consent_events_org on consent_events (org_id);

alter table consent_events enable row level security;

create policy consent_events_authenticated_all on consent_events
  for all to authenticated using (true) with check (true);
