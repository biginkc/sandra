-- ============================================================================
-- Migration: 058
-- Created: 2026-05-08
-- Purpose: Sandra-side foundation for Jitter dialer (Phase 1).
--   - 5 new tables: dialer_batches, dialer_batch_items, call_activities,
--     call_recordings, call_transcripts
--   - Membership-scoped RLS matching migration 054 patterns
--   - Realtime publication on call_activities only
--   - Widens webhook_consumers.consumer_type to include 'jitter_writeback'
--   - Fans child recording/transcript writes back to call_activities so the
--     Sandra lead widget can subscribe to one compact Realtime surface
--   - Adds dialer_batch_items.last_call_activity_id FK at the end to break the
--     mutual-FK cycle with call_activities
-- Owner: Jitter v1 Phase 1 (SANDRA-04, SANDRA-05)
-- D-15 Hybrid: dialer_batch_items snapshots identity only. No eligibility
-- snapshot columns are stored here; eligibility is re-resolved at request time.
-- ============================================================================

begin;

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table public.dialer_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text,
  source_kind text not null check (source_kind in ('selected_ids','filters','list')),
  source_meta jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','claimed','in_progress','completed','canceled','expired')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  jitter_session_id text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dialer_batches_org_created_idx
  on public.dialer_batches (org_id, created_at desc);
create index dialer_batches_status_idx
  on public.dialer_batches (status)
  where status in ('pending','claimed','in_progress');

create table public.dialer_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.dialer_batches(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  phone_e164 text not null,
  phone_label text not null
    check (phone_label in ('homeowner.phone_1','homeowner.phone_2','homeowner.phone_3')),
  state text not null,
  timezone text not null,
  calling_window_start_hour smallint not null default 8,
  calling_window_end_hour smallint not null default 21,
  sort_order integer not null default 0,
  status text not null default 'queued'
    check (status in ('queued','in_progress','completed','skipped','canceled')),
  last_call_activity_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, property_id, phone_e164)
);

create index dialer_batch_items_batch_idx
  on public.dialer_batch_items (batch_id, sort_order);
create index dialer_batch_items_property_idx
  on public.dialer_batch_items (property_id);
create index dialer_batch_items_contact_idx
  on public.dialer_batch_items (contact_id);

create table public.call_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  dialer_batch_item_id uuid references public.dialer_batch_items(id) on delete set null,
  jitter_attempt_id text not null,
  jitter_session_id text,
  operator_user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  outcome text
    check (outcome in ('connected_human','voicemail','no_answer','busy','failed','canceled','unknown')),
  disposition text,
  do_not_call_requested boolean not null default false,
  provider text not null default 'jitter',
  provider_call_id text,
  recording_status text not null default 'none'
    check (recording_status in ('none','pending','available','failed')),
  transcript_status text not null default 'none'
    check (transcript_status in ('none','pending','available','failed')),
  error_code text,
  error_message text,
  raw_event_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, jitter_attempt_id)
);

create index call_activities_property_started_idx
  on public.call_activities (property_id, started_at desc nulls last);
create index call_activities_org_started_idx
  on public.call_activities (org_id, started_at desc nulls last);
create index call_activities_batch_item_idx
  on public.call_activities (dialer_batch_item_id);

create table public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  call_activity_id uuid not null references public.call_activities(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','available','failed')),
  storage_path text,
  duration_seconds integer,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index call_recordings_activity_idx
  on public.call_recordings (call_activity_id);

create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_activity_id uuid not null references public.call_activities(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','available','failed')),
  text text,
  language text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index call_transcripts_activity_idx
  on public.call_transcripts (call_activity_id);

-- ----------------------------------------------------------------------------
-- RLS: direct org tables
-- ----------------------------------------------------------------------------
alter table public.dialer_batches enable row level security;

create policy dialer_batches_org_select on public.dialer_batches for select to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy dialer_batches_org_insert on public.dialer_batches for insert to authenticated
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy dialer_batches_org_update on public.dialer_batches for update to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy dialer_batches_org_delete on public.dialer_batches for delete to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

alter table public.call_activities enable row level security;

create policy call_activities_org_select on public.call_activities for select to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy call_activities_org_insert on public.call_activities for insert to authenticated
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy call_activities_org_update on public.call_activities for update to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
create policy call_activities_org_delete on public.call_activities for delete to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- RLS: child tables via parent org membership
-- ----------------------------------------------------------------------------
alter table public.dialer_batch_items enable row level security;

create policy dialer_batch_items_org_select on public.dialer_batch_items for select to authenticated using (
  exists (
    select 1 from public.dialer_batches b
    where b.id = dialer_batch_items.batch_id
      and b.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy dialer_batch_items_org_insert on public.dialer_batch_items for insert to authenticated with check (
  exists (
    select 1 from public.dialer_batches b
    where b.id = dialer_batch_items.batch_id
      and b.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy dialer_batch_items_org_update on public.dialer_batch_items for update to authenticated using (
  exists (
    select 1 from public.dialer_batches b
    where b.id = dialer_batch_items.batch_id
      and b.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
) with check (
  exists (
    select 1 from public.dialer_batches b
    where b.id = dialer_batch_items.batch_id
      and b.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy dialer_batch_items_org_delete on public.dialer_batch_items for delete to authenticated using (
  exists (
    select 1 from public.dialer_batches b
    where b.id = dialer_batch_items.batch_id
      and b.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

alter table public.call_recordings enable row level security;

create policy call_recordings_org_select on public.call_recordings for select to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_recordings_org_insert on public.call_recordings for insert to authenticated with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_recordings_org_update on public.call_recordings for update to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
) with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_recordings_org_delete on public.call_recordings for delete to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

alter table public.call_transcripts enable row level security;

create policy call_transcripts_org_select on public.call_transcripts for select to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_transcripts.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_transcripts_org_insert on public.call_transcripts for insert to authenticated with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_transcripts.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_transcripts_org_update on public.call_transcripts for update to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_transcripts.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
) with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_transcripts.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);
create policy call_transcripts_org_delete on public.call_transcripts for delete to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_transcripts.call_activity_id
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

-- ----------------------------------------------------------------------------
-- Realtime: publish the parent activity stream only.
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table public.call_activities;

-- ----------------------------------------------------------------------------
-- Jitter service auth consumer type.
-- ----------------------------------------------------------------------------
alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array['lead', 'provider', 'jitter_writeback']));

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in ('provider', 'jitter_writeback') and default_source is null)
  );

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
  ) then
    create function public.set_updated_at()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$;
  end if;
end;
$$;

create trigger trg_dialer_batches_updated_at
  before update on public.dialer_batches
  for each row execute function public.set_updated_at();
create trigger trg_dialer_batch_items_updated_at
  before update on public.dialer_batch_items
  for each row execute function public.set_updated_at();
create trigger trg_call_activities_updated_at
  before update on public.call_activities
  for each row execute function public.set_updated_at();
create trigger trg_call_recordings_updated_at
  before update on public.call_recordings
  for each row execute function public.set_updated_at();
create trigger trg_call_transcripts_updated_at
  before update on public.call_transcripts
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Child -> parent fan-out for widget Realtime.
-- ----------------------------------------------------------------------------
create or replace function public.bump_call_activities_on_child_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (tg_table_name = 'call_recordings') then
    update public.call_activities
       set recording_status = new.status,
           updated_at = now()
     where id = new.call_activity_id;
  elsif (tg_table_name = 'call_transcripts') then
    update public.call_activities
       set transcript_status = new.status,
           updated_at = now()
     where id = new.call_activity_id;
  end if;

  return new;
end;
$fn$;

create trigger bump_call_activities_on_recording_change
  after insert or update on public.call_recordings
  for each row execute function public.bump_call_activities_on_child_change();

create trigger bump_call_activities_on_transcript_change
  after insert or update on public.call_transcripts
  for each row execute function public.bump_call_activities_on_child_change();

-- ----------------------------------------------------------------------------
-- Back-reference FK, added last to break mutual-FK circularity.
-- ----------------------------------------------------------------------------
alter table public.dialer_batch_items
  add constraint dialer_batch_items_last_call_activity_id_fkey
  foreign key (last_call_activity_id)
  references public.call_activities(id)
  on delete set null;

-- ----------------------------------------------------------------------------
-- Test reset helper: include dialer/call activity tables.
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
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
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

commit;
