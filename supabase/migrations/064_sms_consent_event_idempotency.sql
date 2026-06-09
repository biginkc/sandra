alter table public.consent_events
  add column if not exists source_external_id text
  generated always as ((source_detail ->> 'externalId')) stored;

create unique index if not exists idx_consent_events_external_idempotency
  on public.consent_events (contact_id, channel, event_type, source_external_id)
  where source_external_id is not null
    and event_type in ('opt_out', 'help_request');
