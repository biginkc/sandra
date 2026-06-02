-- 068_institute_course_outcomes.sql
--
-- Point-to-point v1 receiver for BMH Institute course completions.
-- BMH Institute owns course/learner semantics; Sandra stores the auditable
-- org-scoped outcome so cross-app v1 completion can be proven and replayed.

begin;

create table public.institute_course_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  institute_user_id text not null,
  learner_email text,
  learner_name text,
  course_id text not null,
  course_title text,
  status text not null default 'completed' check (status in ('completed')),
  completed_at timestamptz not null,
  certificate_number text,
  certificate_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, institute_user_id, course_id)
);

create index institute_course_outcomes_org_created_idx
  on public.institute_course_outcomes (org_id, created_at desc);

create index institute_course_outcomes_learner_created_idx
  on public.institute_course_outcomes (org_id, learner_email, created_at desc)
  where learner_email is not null;

alter table public.institute_course_outcomes enable row level security;

create policy institute_course_outcomes_org_select on public.institute_course_outcomes for select to authenticated
  using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid()));

alter publication supabase_realtime add table public.institute_course_outcomes;

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array['lead', 'provider', 'jitter_writeback', 'closer_practice', 'bmh_institute_course']));

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in ('provider', 'jitter_writeback', 'closer_practice', 'bmh_institute_course') and default_source is null)
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
    institute_course_outcomes,
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
