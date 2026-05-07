-- ============================================================================
-- Stage 1 — Memberships foundation + RLS rewrite
--
-- Adds the user-to-org link table and replaces tenant-table authenticated-all
-- policies with membership-scoped policies. CI-only: applied by
-- .github/workflows/db-migrate.yml after merge.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. memberships
-- ----------------------------------------------------------------------------
create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  unique (user_id, org_id)
);

create index if not exists idx_memberships_user_id
  on public.memberships (user_id);

create index if not exists idx_memberships_org_id
  on public.memberships (org_id);

alter table public.memberships enable row level security;

drop policy if exists memberships_self_select on public.memberships;
create policy memberships_self_select on public.memberships
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists memberships_owner_select on public.memberships;
create policy memberships_owner_select on public.memberships
  for select
  to authenticated
  using (
    org_id in (
      select m.org_id
      from public.memberships m
      where m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

drop policy if exists memberships_owner_write on public.memberships;
create policy memberships_owner_write on public.memberships
  for all
  to authenticated
  using (
    org_id in (
      select m.org_id
      from public.memberships m
      where m.user_id = auth.uid()
        and m.role = 'owner'
    )
  )
  with check (
    org_id in (
      select m.org_id
      from public.memberships m
      where m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- ----------------------------------------------------------------------------
-- 2. webhook_consumers tenant scope
-- ----------------------------------------------------------------------------
alter table public.webhook_consumers
  add column if not exists org_id uuid not null
    default '00000000-0000-0000-0000-000000000bbb'::uuid
    references public.organizations(id);

create index if not exists idx_webhook_consumers_org_id
  on public.webhook_consumers (org_id);

-- ----------------------------------------------------------------------------
-- 3. Drop broad authenticated-all policies
-- ----------------------------------------------------------------------------
drop policy if exists organizations_authenticated_all on public.organizations;
drop policy if exists contacts_authenticated_all on public.contacts;
drop policy if exists homeowner_details_authenticated_all on public.homeowner_details;
drop policy if exists agent_details_authenticated_all on public.agent_details;
drop policy if exists properties_authenticated_all on public.properties;
drop policy if exists messages_authenticated_all on public.messages;
drop policy if exists csv_imports_authenticated_all on public.csv_imports;
drop policy if exists cass_cache_authenticated_all on public.cass_cache;
drop policy if exists jobs_authenticated_all on public.jobs;
drop policy if exists job_items_authenticated_all on public.job_items;
drop policy if exists property_merges_authenticated_all on public.property_merges;
drop policy if exists notifications_authenticated_all on public.notifications;
drop policy if exists lead_notes_authenticated_all on public.lead_notes;
drop policy if exists lists_authenticated_all on public.lists;
drop policy if exists property_lists_authenticated_all on public.property_lists;
drop policy if exists tags_authenticated_all on public.tags;
drop policy if exists property_tags_authenticated_all on public.property_tags;
drop policy if exists sms_templates_authenticated_all on public.sms_templates;
drop policy if exists consent_events_authenticated_all on public.consent_events;
drop policy if exists sequences_authenticated_all on public.sequences;
drop policy if exists sequence_steps_authenticated_all on public.sequence_steps;
drop policy if exists sequence_enrollments_authenticated_all on public.sequence_enrollments;
drop policy if exists sequence_step_runs_authenticated_all on public.sequence_step_runs;
drop policy if exists tasks_authenticated_all on public.tasks;
drop policy if exists ai_responder_configs_authenticated_all on public.ai_responder_configs;
drop policy if exists test_sms_log_authenticated_all on public.test_sms_log;
drop policy if exists "admins can read webhook_consumers" on public.webhook_consumers;
drop policy if exists "admins can insert webhook_consumers" on public.webhook_consumers;
drop policy if exists "admins can update webhook_consumers" on public.webhook_consumers;
drop policy if exists webhook_consumers_authenticated_all on public.webhook_consumers;
drop policy if exists "csv_imports_authenticated_all" on storage.objects;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select * from (values
      ('organizations'::text, 'organizations_org_select'::text),
      ('organizations', 'organizations_org_insert'),
      ('organizations', 'organizations_org_update'),
      ('organizations', 'organizations_org_delete'),
      ('contacts', 'contacts_org_select'),
      ('contacts', 'contacts_org_insert'),
      ('contacts', 'contacts_org_update'),
      ('contacts', 'contacts_org_delete'),
      ('homeowner_details', 'homeowner_details_org_select'),
      ('homeowner_details', 'homeowner_details_org_insert'),
      ('homeowner_details', 'homeowner_details_org_update'),
      ('homeowner_details', 'homeowner_details_org_delete'),
      ('agent_details', 'agent_details_org_select'),
      ('agent_details', 'agent_details_org_insert'),
      ('agent_details', 'agent_details_org_update'),
      ('agent_details', 'agent_details_org_delete'),
      ('properties', 'properties_org_select'),
      ('properties', 'properties_org_insert'),
      ('properties', 'properties_org_update'),
      ('properties', 'properties_org_delete'),
      ('messages', 'messages_org_select'),
      ('messages', 'messages_org_insert'),
      ('messages', 'messages_org_update'),
      ('messages', 'messages_org_delete'),
      ('csv_imports', 'csv_imports_org_select'),
      ('csv_imports', 'csv_imports_org_insert'),
      ('csv_imports', 'csv_imports_org_update'),
      ('csv_imports', 'csv_imports_org_delete'),
      ('cass_cache', 'cass_cache_org_select'),
      ('cass_cache', 'cass_cache_org_insert'),
      ('cass_cache', 'cass_cache_org_update'),
      ('cass_cache', 'cass_cache_org_delete'),
      ('jobs', 'jobs_org_select'),
      ('jobs', 'jobs_org_insert'),
      ('jobs', 'jobs_org_update'),
      ('jobs', 'jobs_org_delete'),
      ('property_merges', 'property_merges_org_select'),
      ('property_merges', 'property_merges_org_insert'),
      ('property_merges', 'property_merges_org_update'),
      ('property_merges', 'property_merges_org_delete'),
      ('notifications', 'notifications_org_select'),
      ('notifications', 'notifications_org_insert'),
      ('notifications', 'notifications_org_update'),
      ('notifications', 'notifications_org_delete'),
      ('lead_notes', 'lead_notes_org_select'),
      ('lead_notes', 'lead_notes_org_insert'),
      ('lead_notes', 'lead_notes_org_update'),
      ('lead_notes', 'lead_notes_org_delete'),
      ('lists', 'lists_org_select'),
      ('lists', 'lists_org_insert'),
      ('lists', 'lists_org_update'),
      ('lists', 'lists_org_delete'),
      ('tags', 'tags_org_select'),
      ('tags', 'tags_org_insert'),
      ('tags', 'tags_org_update'),
      ('tags', 'tags_org_delete'),
      ('sms_templates', 'sms_templates_org_select'),
      ('sms_templates', 'sms_templates_org_insert'),
      ('sms_templates', 'sms_templates_org_update'),
      ('sms_templates', 'sms_templates_org_delete'),
      ('consent_events', 'consent_events_org_select'),
      ('consent_events', 'consent_events_org_insert'),
      ('consent_events', 'consent_events_org_update'),
      ('consent_events', 'consent_events_org_delete'),
      ('sequences', 'sequences_org_select'),
      ('sequences', 'sequences_org_insert'),
      ('sequences', 'sequences_org_update'),
      ('sequences', 'sequences_org_delete'),
      ('sequence_enrollments', 'sequence_enrollments_org_select'),
      ('sequence_enrollments', 'sequence_enrollments_org_insert'),
      ('sequence_enrollments', 'sequence_enrollments_org_update'),
      ('sequence_enrollments', 'sequence_enrollments_org_delete'),
      ('tasks', 'tasks_org_select'),
      ('tasks', 'tasks_org_insert'),
      ('tasks', 'tasks_org_update'),
      ('tasks', 'tasks_org_delete'),
      ('ai_responder_configs', 'ai_responder_configs_org_select'),
      ('ai_responder_configs', 'ai_responder_configs_org_insert'),
      ('ai_responder_configs', 'ai_responder_configs_org_update'),
      ('ai_responder_configs', 'ai_responder_configs_org_delete'),
      ('test_sms_log', 'test_sms_log_org_select'),
      ('test_sms_log', 'test_sms_log_org_insert'),
      ('test_sms_log', 'test_sms_log_org_update'),
      ('test_sms_log', 'test_sms_log_org_delete'),
      ('job_items', 'job_items_org_select'),
      ('job_items', 'job_items_org_insert'),
      ('job_items', 'job_items_org_update'),
      ('job_items', 'job_items_org_delete'),
      ('sequence_steps', 'sequence_steps_org_select'),
      ('sequence_steps', 'sequence_steps_org_insert'),
      ('sequence_steps', 'sequence_steps_org_update'),
      ('sequence_steps', 'sequence_steps_org_delete'),
      ('sequence_step_runs', 'sequence_step_runs_org_select'),
      ('sequence_step_runs', 'sequence_step_runs_org_insert'),
      ('sequence_step_runs', 'sequence_step_runs_org_update'),
      ('sequence_step_runs', 'sequence_step_runs_org_delete'),
      ('property_lists', 'property_lists_org_select'),
      ('property_lists', 'property_lists_org_insert'),
      ('property_lists', 'property_lists_org_update'),
      ('property_lists', 'property_lists_org_delete'),
      ('property_tags', 'property_tags_org_select'),
      ('property_tags', 'property_tags_org_insert'),
      ('property_tags', 'property_tags_org_update'),
      ('property_tags', 'property_tags_org_delete'),
      ('counties', 'counties_authenticated_select'),
      ('counties', 'counties_service_insert'),
      ('counties', 'counties_service_update'),
      ('counties', 'counties_service_delete'),
      ('webhook_consumers', 'webhook_consumers_org_select'),
      ('webhook_consumers', 'webhook_consumers_org_insert'),
      ('webhook_consumers', 'webhook_consumers_org_update'),
      ('webhook_consumers', 'webhook_consumers_org_delete')
    ) as policies(table_name, policy_name)
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      policy_row.policy_name,
      policy_row.table_name
    );
  end loop;
end;
$$;

drop policy if exists "csv_imports_org_scoped" on storage.objects;

-- ----------------------------------------------------------------------------
-- 4. Direct org membership policies
-- ----------------------------------------------------------------------------
create policy organizations_org_select on public.organizations
  for select to authenticated
  using (id in (select org_id from public.memberships where user_id = auth.uid()));
create policy organizations_org_insert on public.organizations
  for insert to authenticated
  with check (id in (select org_id from public.memberships where user_id = auth.uid()));
create policy organizations_org_update on public.organizations
  for update to authenticated
  using (id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (id in (select org_id from public.memberships where user_id = auth.uid()));
create policy organizations_org_delete on public.organizations
  for delete to authenticated
  using (id in (select org_id from public.memberships where user_id = auth.uid()));

create policy contacts_org_select on public.contacts for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy contacts_org_insert on public.contacts for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy contacts_org_update on public.contacts for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy contacts_org_delete on public.contacts for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy homeowner_details_org_select on public.homeowner_details for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy homeowner_details_org_insert on public.homeowner_details for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy homeowner_details_org_update on public.homeowner_details for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy homeowner_details_org_delete on public.homeowner_details for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy agent_details_org_select on public.agent_details for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy agent_details_org_insert on public.agent_details for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy agent_details_org_update on public.agent_details for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy agent_details_org_delete on public.agent_details for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy properties_org_select on public.properties for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy properties_org_insert on public.properties for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy properties_org_update on public.properties for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy properties_org_delete on public.properties for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy messages_org_select on public.messages for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy messages_org_insert on public.messages for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy messages_org_update on public.messages for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy messages_org_delete on public.messages for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy csv_imports_org_select on public.csv_imports for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy csv_imports_org_insert on public.csv_imports for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy csv_imports_org_update on public.csv_imports for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy csv_imports_org_delete on public.csv_imports for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy cass_cache_org_select on public.cass_cache for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy cass_cache_org_insert on public.cass_cache for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy cass_cache_org_update on public.cass_cache for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy cass_cache_org_delete on public.cass_cache for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy jobs_org_select on public.jobs for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy jobs_org_insert on public.jobs for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy jobs_org_update on public.jobs for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy jobs_org_delete on public.jobs for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy property_merges_org_select on public.property_merges for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy property_merges_org_insert on public.property_merges for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy property_merges_org_update on public.property_merges for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy property_merges_org_delete on public.property_merges for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy notifications_org_select on public.notifications for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy notifications_org_insert on public.notifications for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy notifications_org_update on public.notifications for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy notifications_org_delete on public.notifications for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy lead_notes_org_select on public.lead_notes for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lead_notes_org_insert on public.lead_notes for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lead_notes_org_update on public.lead_notes for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lead_notes_org_delete on public.lead_notes for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy lists_org_select on public.lists for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lists_org_insert on public.lists for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lists_org_update on public.lists for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy lists_org_delete on public.lists for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy tags_org_select on public.tags for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tags_org_insert on public.tags for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tags_org_update on public.tags for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tags_org_delete on public.tags for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy sms_templates_org_select on public.sms_templates for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sms_templates_org_insert on public.sms_templates for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sms_templates_org_update on public.sms_templates for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sms_templates_org_delete on public.sms_templates for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy consent_events_org_select on public.consent_events for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy consent_events_org_insert on public.consent_events for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy consent_events_org_update on public.consent_events for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy consent_events_org_delete on public.consent_events for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy sequences_org_select on public.sequences for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequences_org_insert on public.sequences for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequences_org_update on public.sequences for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequences_org_delete on public.sequences for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy sequence_enrollments_org_select on public.sequence_enrollments for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequence_enrollments_org_insert on public.sequence_enrollments for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequence_enrollments_org_update on public.sequence_enrollments for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy sequence_enrollments_org_delete on public.sequence_enrollments for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy tasks_org_select on public.tasks for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tasks_org_insert on public.tasks for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tasks_org_update on public.tasks for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy tasks_org_delete on public.tasks for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy ai_responder_configs_org_select on public.ai_responder_configs for select to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy ai_responder_configs_org_insert on public.ai_responder_configs for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy ai_responder_configs_org_update on public.ai_responder_configs for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy ai_responder_configs_org_delete on public.ai_responder_configs for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

-- test_sms_log: debug table with no org_id column. After dropping the
-- old test_sms_log_authenticated_all policy above, RLS stays enabled
-- with no client policies — service-role-only access. The Twilio test
-- receiver writes via service role (createAdminClient), so no
-- functionality is lost; debug reads from /admin tooling will need to
-- go through service role too.

-- ----------------------------------------------------------------------------
-- 5. Child-table policies via parent org
-- ----------------------------------------------------------------------------
create policy job_items_org_select on public.job_items for select to authenticated using (exists (select 1 from public.jobs where jobs.id = job_items.job_id and jobs.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy job_items_org_insert on public.job_items for insert to authenticated with check (exists (select 1 from public.jobs where jobs.id = job_items.job_id and jobs.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy job_items_org_update on public.job_items for update to authenticated using (exists (select 1 from public.jobs where jobs.id = job_items.job_id and jobs.org_id in (select org_id from public.memberships where user_id = auth.uid()))) with check (exists (select 1 from public.jobs where jobs.id = job_items.job_id and jobs.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy job_items_org_delete on public.job_items for delete to authenticated using (exists (select 1 from public.jobs where jobs.id = job_items.job_id and jobs.org_id in (select org_id from public.memberships where user_id = auth.uid())));

create policy sequence_steps_org_select on public.sequence_steps for select to authenticated using (exists (select 1 from public.sequences where sequences.id = sequence_steps.sequence_id and sequences.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_steps_org_insert on public.sequence_steps for insert to authenticated with check (exists (select 1 from public.sequences where sequences.id = sequence_steps.sequence_id and sequences.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_steps_org_update on public.sequence_steps for update to authenticated using (exists (select 1 from public.sequences where sequences.id = sequence_steps.sequence_id and sequences.org_id in (select org_id from public.memberships where user_id = auth.uid()))) with check (exists (select 1 from public.sequences where sequences.id = sequence_steps.sequence_id and sequences.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_steps_org_delete on public.sequence_steps for delete to authenticated using (exists (select 1 from public.sequences where sequences.id = sequence_steps.sequence_id and sequences.org_id in (select org_id from public.memberships where user_id = auth.uid())));

create policy sequence_step_runs_org_select on public.sequence_step_runs for select to authenticated using (exists (select 1 from public.sequence_enrollments where sequence_enrollments.id = sequence_step_runs.enrollment_id and sequence_enrollments.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_step_runs_org_insert on public.sequence_step_runs for insert to authenticated with check (exists (select 1 from public.sequence_enrollments where sequence_enrollments.id = sequence_step_runs.enrollment_id and sequence_enrollments.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_step_runs_org_update on public.sequence_step_runs for update to authenticated using (exists (select 1 from public.sequence_enrollments where sequence_enrollments.id = sequence_step_runs.enrollment_id and sequence_enrollments.org_id in (select org_id from public.memberships where user_id = auth.uid()))) with check (exists (select 1 from public.sequence_enrollments where sequence_enrollments.id = sequence_step_runs.enrollment_id and sequence_enrollments.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy sequence_step_runs_org_delete on public.sequence_step_runs for delete to authenticated using (exists (select 1 from public.sequence_enrollments where sequence_enrollments.id = sequence_step_runs.enrollment_id and sequence_enrollments.org_id in (select org_id from public.memberships where user_id = auth.uid())));

create policy property_lists_org_select on public.property_lists for select to authenticated using (exists (select 1 from public.properties where properties.id = property_lists.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_lists_org_insert on public.property_lists for insert to authenticated with check (exists (select 1 from public.properties where properties.id = property_lists.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_lists_org_update on public.property_lists for update to authenticated using (exists (select 1 from public.properties where properties.id = property_lists.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid()))) with check (exists (select 1 from public.properties where properties.id = property_lists.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_lists_org_delete on public.property_lists for delete to authenticated using (exists (select 1 from public.properties where properties.id = property_lists.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));

create policy property_tags_org_select on public.property_tags for select to authenticated using (exists (select 1 from public.properties where properties.id = property_tags.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_tags_org_insert on public.property_tags for insert to authenticated with check (exists (select 1 from public.properties where properties.id = property_tags.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_tags_org_update on public.property_tags for update to authenticated using (exists (select 1 from public.properties where properties.id = property_tags.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid()))) with check (exists (select 1 from public.properties where properties.id = property_tags.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));
create policy property_tags_org_delete on public.property_tags for delete to authenticated using (exists (select 1 from public.properties where properties.id = property_tags.property_id and properties.org_id in (select org_id from public.memberships where user_id = auth.uid())));

-- ----------------------------------------------------------------------------
-- 6. Reference data exception: counties
-- ----------------------------------------------------------------------------
drop policy if exists counties_authenticated_all on public.counties;
alter table public.counties
  drop column if exists org_id;

create policy counties_authenticated_select on public.counties
  for select
  to authenticated
  using (true);

create policy counties_service_insert on public.counties
  for insert
  to service_role
  with check (true);

create policy counties_service_update on public.counties
  for update
  to service_role
  using (true)
  with check (true);

create policy counties_service_delete on public.counties
  for delete
  to service_role
  using (true);

-- ----------------------------------------------------------------------------
-- 7. Storage bucket csv-imports
-- ----------------------------------------------------------------------------
create policy "csv_imports_org_scoped" on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'csv-imports'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[1]::uuid in (
      select org_id from public.memberships where user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'csv-imports'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[1]::uuid in (
      select org_id from public.memberships where user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- 8. webhook_consumers owner-only
-- ----------------------------------------------------------------------------
create policy webhook_consumers_org_select on public.webhook_consumers for select to authenticated using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.role = 'owner'));
create policy webhook_consumers_org_insert on public.webhook_consumers for insert to authenticated with check (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.role = 'owner'));
create policy webhook_consumers_org_update on public.webhook_consumers for update to authenticated using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.role = 'owner')) with check (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.role = 'owner'));
create policy webhook_consumers_org_delete on public.webhook_consumers for delete to authenticated using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.role = 'owner'));

-- ----------------------------------------------------------------------------
-- 8b. skip_trace_cache — read-only for tenants, service-role-only writes
-- ----------------------------------------------------------------------------
drop policy if exists skip_trace_cache_authenticated_all on public.skip_trace_cache;

create policy skip_trace_cache_authenticated_select on public.skip_trace_cache
  for select
  to authenticated
  using (true);

create policy skip_trace_cache_service_write on public.skip_trace_cache
  for all
  to service_role
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- 9. Test-reset helper preserves memberships
-- ----------------------------------------------------------------------------
create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.metric_snapshots,
    public.memberships,
    public.tasks,
    public.job_items,
    public.messages,
    public.consent_events,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;

  insert into public.memberships
  select * from _memberships_snapshot
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;

-- ----------------------------------------------------------------------------
-- 10. Backfill existing users into BMH as owners
-- ----------------------------------------------------------------------------
insert into public.memberships (user_id, org_id, role)
select id, '00000000-0000-0000-0000-000000000bbb'::uuid, 'owner'
from auth.users
on conflict (user_id, org_id) do nothing;

commit;
