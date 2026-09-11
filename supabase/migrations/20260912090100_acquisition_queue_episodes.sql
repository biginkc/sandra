-- My Leads foundation: launch cohorts, queue projection and assignment
-- episodes. The observer is assignment-only and preserves the existing
-- properties status/assignee guards.

begin;

-- call_activities.id is globally unique, but the composite key makes a new
-- My Leads activity reference prove the property and tenant agree as well.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.call_activities'::regclass
      and conname = 'call_activities_id_property_org_key'
  ) then
    alter table public.call_activities
      add constraint call_activities_id_property_org_key
      unique (id, property_id, org_id);
  end if;
end;
$$;

create table public.acquisition_launch_cohorts (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('planned', 'running', 'complete', 'rolled_back')),
  preview_count integer not null default 0 check (preview_count >= 0),
  preview_fingerprint text not null check (btrim(preview_fingerprint) <> ''),
  preview_cutoff_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint acquisition_launch_cohorts_id_org_key unique (id, org_id),
  constraint acquisition_launch_cohorts_dates_check
    check (completed_at is null or started_at is not null and completed_at >= started_at)
);

create unique index acquisition_launch_cohorts_active_org_idx
  on public.acquisition_launch_cohorts (org_id)
  where status in ('planned', 'running');

alter table public.acquisition_launch_cohorts enable row level security;
revoke all on table public.acquisition_launch_cohorts
  from public, anon, authenticated, service_role;

-- P01 intentionally creates settings before cohorts so it can be deployed
-- independently. Add the tenant-safe cross-reference only after both tables
-- exist.
alter table public.acquisition_org_settings
  add constraint acquisition_org_settings_active_cohort_org_fkey
  foreign key (active_launch_cohort_id, org_id)
  references public.acquisition_launch_cohorts(id, org_id);

create table public.acquisition_queue_states (
  property_id uuid not null,
  org_id uuid not null,
  stage text not null check (stage in ('contacted', 'needs_offer', 'offer_sent', 'under_contract')),
  stage_entered_at timestamptz not null,
  motivation_recorded boolean not null default false,
  motivation_kind text check (motivation_kind in ('specified', 'no_motivation')),
  motivation_text text,
  motivation_recorded_at timestamptz,
  motivation_recorded_by uuid references auth.users(id) on delete restrict,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  archive_reason text check (archive_reason in ('needs_sequence_handoff', 'under_contract_archived', 'manual')),
  version bigint not null default 0 check (version >= 0),
  launch_cohort_id uuid,
  launch_previous_shared_status text,
  signed_at timestamptz,
  signed_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (property_id, org_id),
  constraint acquisition_queue_states_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint acquisition_queue_states_launch_cohort_org_fkey
    foreign key (launch_cohort_id, org_id)
    references public.acquisition_launch_cohorts(id, org_id),
  constraint acquisition_queue_states_motivation_check
    check (
      (not motivation_recorded
       and motivation_kind is null
       and motivation_text is null
       and motivation_recorded_at is null
       and motivation_recorded_by is null)
      or
      (motivation_recorded
       and motivation_kind is not null
       and motivation_recorded_at is not null
       and motivation_recorded_by is not null
       and motivation_kind = 'no_motivation'
       and motivation_text is null)
      or
      (motivation_recorded
       and motivation_kind is not null
       and motivation_recorded_at is not null
       and motivation_recorded_by is not null
       and motivation_kind = 'specified'
       and motivation_text is not null
       and btrim(motivation_text) <> '')
    ),
  constraint acquisition_queue_states_archive_check
    check (
      (archived_at is null and archived_by is null and archive_reason is null)
      or
      (archived_at is not null and archived_by is not null and archive_reason is not null)
    ),
  constraint acquisition_queue_states_signed_check
    check ((signed_at is null) = (signed_by is null))
);

create index acquisition_queue_states_active_stage_idx
  on public.acquisition_queue_states (org_id, stage, stage_entered_at, property_id)
  where archived_at is null;

alter table public.acquisition_queue_states enable row level security;
revoke all on table public.acquisition_queue_states
  from public, anon, authenticated, service_role;

create table public.acquisition_assignment_episodes (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  assignee_user_id uuid not null references auth.users(id) on delete restrict,
  episode_kind text not null check (episode_kind in ('live', 'launch')),
  eligible boolean not null,
  assigned_at timestamptz,
  initialized_at timestamptz not null default now(),
  ended_at timestamptz,
  first_call_started_at timestamptz,
  first_call_actor_user_id uuid references auth.users(id) on delete restrict,
  first_call_activity_id uuid,
  first_call_provider_key text,
  launch_cohort_id uuid,
  created_at timestamptz not null default now(),
  constraint acquisition_assignment_episodes_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint acquisition_assignment_episodes_id_property_org_key
    unique (id, property_id, org_id),
  constraint acquisition_assignment_episodes_launch_cohort_org_fkey
    foreign key (launch_cohort_id, org_id)
    references public.acquisition_launch_cohorts(id, org_id),
  constraint acquisition_assignment_episodes_activity_org_fkey
    foreign key (first_call_activity_id, property_id, org_id)
    references public.call_activities(id, property_id, org_id)
    on delete set null (first_call_activity_id),
  constraint acquisition_assignment_episodes_kind_assigned_check
    check ((episode_kind = 'live') = (assigned_at is not null)),
  constraint acquisition_assignment_episodes_end_check
    check (ended_at is null or ended_at >= coalesce(assigned_at, initialized_at)),
  constraint acquisition_assignment_episodes_first_call_actor_check
    check (
      first_call_started_at is null
      or (
        first_call_actor_user_id is not null
        and first_call_started_at >= coalesce(assigned_at, initialized_at)
        and (ended_at is null or first_call_started_at < ended_at)
      )
    )
);

create unique index acquisition_assignment_episodes_open_property_idx
  on public.acquisition_assignment_episodes (org_id, property_id)
  where ended_at is null;

create index acquisition_assignment_episodes_assignee_start_idx
  on public.acquisition_assignment_episodes (org_id, assignee_user_id, assigned_at, property_id)
  where ended_at is null;

alter table public.acquisition_assignment_episodes enable row level security;
revoke all on table public.acquisition_assignment_episodes
  from public, anon, authenticated, service_role;

create or replace function public.observe_my_leads_property_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.acquisition_org_settings%rowtype;
  v_member_enabled boolean := false;
  v_member_active boolean := false;
  v_episode_eligible boolean := false;
  v_handoff_marker text := current_setting('my_leads.handoff_property_id', true);
  v_handoff_command_id uuid;
  v_handoff_suppressed boolean := false;
  v_stage text;
begin
  select * into v_settings
  from public.acquisition_org_settings s
  where s.org_id = new.org_id;

  -- An organization without settings has opted out of the observer entirely.
  if not found then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.assigned_user_id is not distinct from new.assigned_user_id then
    return new;
  end if;

  update public.acquisition_assignment_episodes e
  set ended_at = statement_timestamp()
  where e.org_id = new.org_id
    and e.property_id = new.id
    and e.ended_at is null;

  if new.assigned_user_id is null then
    return new;
  end if;

  select coalesce(m.acquisitions_enabled, false),
         m.access_status = 'active'
           and m.deletion_prepared_at is null
           and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  into v_member_enabled, v_member_active
  from public.memberships m
  where m.org_id = new.org_id and m.user_id = new.assigned_user_id;

  -- Handoff callers set property UUID + the already-recorded command UUID.
  -- The marker alone is insufficient: the archive and command must be
  -- present in this transaction and belong to the same actor/org.
  if v_handoff_marker ~* '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
     and lower(split_part(v_handoff_marker, ':', 1)) = lower(new.id::text) then
    v_handoff_command_id := split_part(v_handoff_marker, ':', 2)::uuid;
  end if;
  v_handoff_suppressed := v_handoff_command_id is not null
    and exists (
      select 1
      from public.acquisition_queue_states q
      join public.acquisition_commands c
        on c.id = v_handoff_command_id and c.org_id = q.org_id
      where q.org_id = new.org_id
        and q.property_id = new.id
        and q.archived_at is not null
        and q.archive_reason = 'needs_sequence_handoff'
        and q.archived_by is not null
        and c.operation in ('handoff_acquisition_lead', 'decline_acquisition_offer')
        and c.actor_user_id = q.archived_by
    );

  v_episode_eligible := v_settings.my_leads_enabled
    and v_member_active
    and v_member_enabled
    and new.deleted_at is null
    and not coalesce(new.is_dnc_locked, false);

  -- A later deliberate assignment to a designated member may reopen only a
  -- needs-sequence handoff. The handoff command sets its marker before the
  -- property assignment, so its Jarrad reassignment remains archived.
  if v_settings.my_leads_enabled and v_member_active and v_member_enabled
     and not v_handoff_suppressed then
    update public.acquisition_queue_states q
    set archived_at = null,
        archived_by = null,
        archive_reason = null,
        stage = 'contacted',
        stage_entered_at = statement_timestamp(),
        version = q.version + 1,
        updated_at = statement_timestamp()
    where q.org_id = new.org_id
      and q.property_id = new.id
      and q.archived_at is not null
      and q.archive_reason = 'needs_sequence_handoff';
  end if;

  insert into public.acquisition_assignment_episodes (
    org_id, property_id, assignee_user_id, episode_kind, eligible,
    assigned_at, initialized_at
  ) values (
    new.org_id, new.id, new.assigned_user_id, 'live',
    v_episode_eligible and not v_handoff_suppressed,
    statement_timestamp(), statement_timestamp()
  );

  -- Assignment is an enrollment boundary. A pre-existing advanced shared
  -- status can seed the queue once, but an arbitrary status edit cannot.
  if v_settings.my_leads_enabled and not v_handoff_suppressed
     and new.deleted_at is null
     and not coalesce(new.is_dnc_locked, false) then
    v_stage := case new.status
      when 'contacted' then 'contacted'
      when 'interested' then 'needs_offer'
      when 'offer_sent' then 'offer_sent'
      when 'under_contract' then 'under_contract'
      else null
    end;
    if v_stage is not null then
      insert into public.acquisition_queue_states (
        property_id, org_id, stage, stage_entered_at
      ) values (
        new.id, new.org_id, v_stage, statement_timestamp()
      ) on conflict (property_id, org_id) do nothing;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.observe_my_leads_property_assignment()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_my_leads_property_assignment on public.properties;
create trigger trg_my_leads_property_assignment
after insert or update of assigned_user_id on public.properties
for each row execute function public.observe_my_leads_property_assignment();

commit;
