-- 063_closer_practice_outcomes.sql
--
-- Point-to-point v1 receiver for Closer Lab practice outcomes.
-- This deliberately does not pretend every practice session maps to a Sandra
-- lead. Closer can include property/contact ids when it has them; otherwise the
-- outcome is org-scoped and still auditable/provable.

begin;

create table public.closer_practice_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  closer_attempt_id text not null,
  closer_user_id text,
  learner_email text,
  role_play_id text,
  role_play_title text,
  status text not null default 'ready' check (status in ('ready', 'failed', 'completed')),
  score integer check (score is null or (score >= 0 and score <= 100)),
  duration_seconds integer constraint closer_practice_outcomes_duration_seconds_nonnegative check (duration_seconds is null or duration_seconds >= 0),
  completed_at timestamptz,
  recording_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, closer_attempt_id)
);

create index closer_practice_outcomes_org_created_idx
  on public.closer_practice_outcomes (org_id, created_at desc);

create index closer_practice_outcomes_property_created_idx
  on public.closer_practice_outcomes (property_id, created_at desc)
  where property_id is not null;

create index closer_practice_outcomes_contact_created_idx
  on public.closer_practice_outcomes (contact_id, created_at desc)
  where contact_id is not null;

alter table public.closer_practice_outcomes enable row level security;

create policy closer_practice_outcomes_org_select on public.closer_practice_outcomes for select to authenticated
  using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid()));

alter publication supabase_realtime add table public.closer_practice_outcomes;

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array['lead', 'provider', 'jitter_writeback', 'closer_practice']));

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in ('provider', 'jitter_writeback', 'closer_practice') and default_source is null)
  );

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
    closer_practice_outcomes,
    notifications,
    lead_notes,
    property_lists,
    property_tags,
    tags,
    lists,
    call_transcripts,
    call_recordings,
    dialer_batch_items,
    dialer_batches,
    call_activities,
    user_integration_prefs,
    user_oauth_tokens,
    webhook_consumers,
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

commit;
