-- My Leads P13: exact launch preview, admitted apply and compensating rollback.
-- Preview is read-only. Apply never enables the rollout flag.

begin;

-- Memberships do not currently have an access/designation revision. This
-- additive counter makes a preview stale even when a member is toggled away
-- and back before apply.
alter table public.memberships
  add column if not exists my_leads_revision bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memberships'::regclass
      and conname = 'memberships_my_leads_revision_check'
  ) then
    alter table public.memberships
      add constraint memberships_my_leads_revision_check
      check (my_leads_revision >= 0);
  end if;
end;
$$;

create or replace function public.bump_my_leads_membership_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.acquisitions_enabled is distinct from old.acquisitions_enabled
     or new.access_status is distinct from old.access_status
     or new.access_expires_at is distinct from old.access_expires_at
     or new.deletion_prepared_at is distinct from old.deletion_prepared_at
     or new.role is distinct from old.role then
    new.my_leads_revision := old.my_leads_revision + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_my_leads_membership_revision()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_bump_my_leads_membership_revision on public.memberships;
create trigger trg_bump_my_leads_membership_revision
before update of acquisitions_enabled, access_status, access_expires_at,
  deletion_prepared_at, role on public.memberships
for each row execute function public.bump_my_leads_membership_revision();

create table public.acquisition_launch_cohort_items (
  cohort_id uuid not null,
  org_id uuid not null,
  property_id uuid not null,
  member_id uuid not null references auth.users(id) on delete restrict,
  expected_episode_id uuid,
  expected_assigned_user_id uuid not null references auth.users(id) on delete restrict,
  expected_assigned_at timestamptz,
  expected_episode_initialized_at timestamptz,
  expected_member_revision bigint not null check (expected_member_revision >= 0),
  expected_shared_status text not null,
  expected_queue_version bigint not null check (expected_queue_version >= 0),
  expected_queue_stage text,
  expected_is_dnc_locked boolean not null,
  expected_deleted_at timestamptz,
  expected_settings_revision bigint not null check (expected_settings_revision >= 0),
  prior_episode_id uuid,
  prior_episode_eligible boolean,
  prior_episode_assigned_at timestamptz,
  prior_episode_initialized_at timestamptz,
  prior_queue_exists boolean not null,
  prior_queue_stage text,
  prior_queue_stage_entered_at timestamptz,
  prior_queue_motivation_recorded boolean,
  prior_queue_motivation_kind text,
  prior_queue_motivation_text text,
  prior_queue_motivation_recorded_at timestamptz,
  prior_queue_motivation_recorded_by uuid references auth.users(id) on delete restrict,
  prior_queue_archived_at timestamptz,
  prior_queue_archived_by uuid references auth.users(id) on delete restrict,
  prior_queue_archive_reason text,
  prior_queue_version bigint,
  prior_queue_launch_cohort_id uuid,
  prior_queue_launch_previous_shared_status text,
  prior_queue_signed_at timestamptz,
  prior_queue_signed_by uuid references auth.users(id) on delete restrict,
  launch_episode_id uuid,
  applied_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  primary key (cohort_id, property_id),
  constraint acquisition_launch_items_cohort_org_fkey
    foreign key (cohort_id, org_id)
    references public.acquisition_launch_cohorts(id, org_id) on delete cascade,
  constraint acquisition_launch_items_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint acquisition_launch_items_episode_property_org_fkey
    foreign key (expected_episode_id, property_id, org_id)
    references public.acquisition_assignment_episodes(id, property_id, org_id),
  constraint acquisition_launch_items_launch_episode_fkey
    foreign key (launch_episode_id, property_id, org_id)
    references public.acquisition_assignment_episodes(id, property_id, org_id),
  constraint acquisition_launch_items_stage_check
    check (expected_queue_stage is null or expected_queue_stage in
      ('contacted', 'needs_offer', 'offer_sent', 'under_contract'))
);

alter table public.acquisition_launch_cohort_items enable row level security;
revoke all on table public.acquisition_launch_cohort_items
  from public, anon, authenticated, service_role;

create index acquisition_launch_items_org_property_idx
  on public.acquisition_launch_cohort_items (org_id, property_id);

create or replace function public.my_leads_launch_require_owner(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.org_id = p_org_id and m.user_id = v_actor and m.role = 'owner'
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create or replace function public.my_leads_launch_candidate_rows(
  p_org_id uuid,
  p_member_id uuid
)
returns table (
  property_id uuid,
  expected_episode_id uuid,
  expected_assigned_user_id uuid,
  expected_assigned_at timestamptz,
  expected_episode_initialized_at timestamptz,
  expected_member_revision bigint,
  expected_shared_status text,
  expected_queue_version bigint,
  expected_queue_stage text,
  expected_is_dnc_locked boolean,
  expected_deleted_at timestamptz,
  expected_settings_revision bigint
)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, e.id, p.assigned_user_id, e.assigned_at, e.initialized_at,
         m.my_leads_revision, p.status, coalesce(q.version, 0), q.stage,
         coalesce(p.is_dnc_locked, false), p.deleted_at, s.settings_revision
  from public.properties p
  join public.memberships m
    on m.org_id = p.org_id and m.user_id = p.assigned_user_id
  left join public.acquisition_assignment_episodes e
    on e.org_id = p.org_id and e.property_id = p.id
   and e.assignee_user_id = p.assigned_user_id and e.ended_at is null
  join public.acquisition_org_settings s on s.org_id = p.org_id
  left join public.acquisition_queue_states q
    on q.org_id = p.org_id and q.property_id = p.id
  where p.org_id = p_org_id
    and p.assigned_user_id = p_member_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    and m.acquisitions_enabled
    and (e.id is null or not e.eligible)
    and p.deleted_at is null
    and not coalesce(p.is_dnc_locked, false)
    and p.status in ('prospect', 'new_lead', 'contacted', 'interested', 'offer_sent', 'under_contract')
    and (q.archived_at is null)
  order by p.id;
$$;

create or replace function public.my_leads_launch_fingerprint_rows(
  p_org_id uuid,
  p_member_id uuid,
  p_settings_revision bigint,
  p_rows jsonb
)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'orgId', p_org_id,
          'memberId', p_member_id,
          'settingsRevision', p_settings_revision,
          'rows', coalesce(p_rows, '[]'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.my_leads_launch_fingerprint(
  p_org_id uuid,
  p_member_id uuid,
  p_settings_revision bigint
)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select public.my_leads_launch_fingerprint_rows(
    p_org_id,
    p_member_id,
    p_settings_revision,
    coalesce(
      (select jsonb_agg(to_jsonb(r) order by r.property_id)
       from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r),
      '[]'::jsonb
    )
  );
$$;

create or replace function public.fn_preview_acquisition_launch(
  p_org_id uuid,
  p_member_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_member public.memberships%rowtype;
  v_rows jsonb;
  v_fingerprint text;
  v_cutoff timestamptz := statement_timestamp();
  v_cohort_id uuid := extensions.gen_random_uuid();
  v_total bigint;
  v_closed_dead bigint;
  v_dnc bigint;
  v_offer_declined bigint;
  v_archived bigint;
  v_missing_episode bigint;
begin
  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled or v_settings.active_launch_cohort_id is not null then
    raise exception 'LAUNCH_ALREADY_APPLIED' using errcode = '40001';
  end if;
  select * into v_member from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_member_id for share;
  if not found or v_member.access_status <> 'active' or v_member.deletion_prepared_at is not null
     or (v_member.access_expires_at is not null and v_member.access_expires_at <= v_cutoff)
     or not v_member.acquisitions_enabled then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships r
    where r.org_id = p_org_id and r.user_id = v_settings.needs_sequence_owner_id
      and r.access_status = 'active' and r.deletion_prepared_at is null
      and (r.access_expires_at is null or r.access_expires_at > v_cutoff)
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r;
  v_fingerprint := public.my_leads_launch_fingerprint(
    p_org_id, p_member_id, v_settings.settings_revision
  );

  select count(*) into v_total from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id;
  select count(*) into v_closed_dead from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.status in ('closed', 'dead');
  select count(*) into v_dnc from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and (p.is_dnc_locked or p.outreach_dispo = 'dnc');
  select count(*) into v_offer_declined from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.status = 'offer_declined';
  select count(*) into v_archived from public.properties p
  join public.acquisition_queue_states q on q.org_id = p.org_id and q.property_id = p.id
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id and q.archived_at is not null;
  select count(*) into v_missing_episode from public.properties p
  where p.org_id = p_org_id and p.assigned_user_id = p_member_id
    and p.deleted_at is null and not coalesce(p.is_dnc_locked, false)
    and p.status in ('prospect', 'new_lead', 'contacted', 'interested', 'offer_sent', 'under_contract')
    and not exists (
      select 1 from public.acquisition_assignment_episodes e
      where e.org_id = p.org_id and e.property_id = p.id and e.ended_at is null
    );

  return jsonb_build_object(
    'ok', true, 'cohortId', v_cohort_id, 'orgId', p_org_id, 'memberId', p_member_id,
    'settingsRevision', v_settings.settings_revision, 'previewCutoffAt', v_cutoff,
    'previewCount', jsonb_array_length(v_rows), 'fingerprint', v_fingerprint,
    'rows', v_rows,
    'excluded', jsonb_build_object(
      'assignedTotal', v_total, 'closedOrDead', v_closed_dead, 'dnc', v_dnc,
      'offerDeclined', v_offer_declined, 'alreadyArchived', v_archived,
      'missingEpisode', v_missing_episode
    )
  );
end;
$$;

create or replace function public.fn_apply_acquisition_launch(
  p_org_id uuid,
  p_member_id uuid,
  p_cohort_id uuid,
  p_preview_fingerprint text,
  p_expected_settings_revision bigint,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_member public.memberships%rowtype;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_current_fingerprint text;
  v_rows jsonb;
  v_current_rows jsonb;
  v_count integer;
  v_cutover timestamptz := statement_timestamp();
  v_item record;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_episode_exists boolean;
  v_prior_queue public.acquisition_queue_states%rowtype;
  v_prior_queue_exists boolean;
  v_stage text;
  v_launch_episode_id uuid;
  v_applied_queue_version bigint;
begin
  if p_member_id is null or p_cohort_id is null or p_preview_fingerprint is null
     or p_expected_settings_revision is null or p_expected_settings_revision < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'apply_acquisition_launch', p_org_id, v_actor,
    jsonb_build_object('memberId', p_member_id, 'cohortId', p_cohort_id,
      'fingerprint', p_preview_fingerprint, 'expectedSettingsRevision', p_expected_settings_revision)
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'apply_acquisition_launch', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'apply_acquisition_launch', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;

  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled or v_settings.active_launch_cohort_id is not null
     or v_settings.settings_revision <> p_expected_settings_revision then
    raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
  end if;
  select * into v_member from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_member_id for update;
  if not found or v_member.access_status <> 'active' or v_member.deletion_prepared_at is not null
     or (v_member.access_expires_at is not null and v_member.access_expires_at <= v_cutover)
     or not v_member.acquisitions_enabled then
    raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
  end if;
  if v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships r
    where r.org_id = p_org_id and r.user_id = v_settings.needs_sequence_owner_id
      and r.access_status = 'active' and r.deletion_prepared_at is null
      and (r.access_expires_at is null or r.access_expires_at > v_cutover)
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  -- Capture the candidate set once. Every later lock, revalidation and
  -- write uses this same bounded set; a property assigned after this point
  -- remains outside the admitted preview.
  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r;
  v_count := jsonb_array_length(v_rows);
  v_current_fingerprint := public.my_leads_launch_fingerprint_rows(
    p_org_id, p_member_id, v_settings.settings_revision, v_rows
  );
  if v_current_fingerprint is distinct from p_preview_fingerprint then
    raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
  end if;

  -- Lock the captured preview set in deterministic property order, then
  -- re-read only those property IDs. This detects changes to declared rows
  -- without admitting a newly assigned property into the cohort.
  for v_item in
    select * from jsonb_to_recordset(v_rows) as captured(
      property_id uuid,
      expected_episode_id uuid,
      expected_assigned_user_id uuid,
      expected_assigned_at timestamptz,
      expected_episode_initialized_at timestamptz,
      expected_member_revision bigint,
      expected_shared_status text,
      expected_queue_version bigint,
      expected_queue_stage text,
      expected_is_dnc_locked boolean,
      expected_deleted_at timestamptz,
      expected_settings_revision bigint
    )
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then raise exception 'LAUNCH_INVALIDATED' using errcode = '40001'; end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    v_episode_exists := found;
    select * into v_prior_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.property_id), '[]'::jsonb)
    into v_current_rows
  from public.my_leads_launch_candidate_rows(p_org_id, p_member_id) r
  join jsonb_to_recordset(v_rows) as captured(property_id uuid)
    on captured.property_id = r.property_id;
  v_current_fingerprint := public.my_leads_launch_fingerprint_rows(
    p_org_id, p_member_id, v_settings.settings_revision, v_current_rows
  );
  if v_current_fingerprint is distinct from p_preview_fingerprint then
    raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
  end if;

  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'apply_acquisition_launch',
    p_idempotency_key, v_hash, '{}'::jsonb
  );
  if v_count = 0 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into public.acquisition_launch_cohorts (
    id, org_id, member_id, status, preview_count, preview_fingerprint,
    preview_cutoff_at, started_at, created_by
  )
  values (
    p_cohort_id, p_org_id, p_member_id, 'running', v_count,
    p_preview_fingerprint, v_cutover, v_cutover, v_actor
  );

  for v_item in
    select * from jsonb_to_recordset(v_rows) as captured(
      property_id uuid,
      expected_episode_id uuid,
      expected_assigned_user_id uuid,
      expected_assigned_at timestamptz,
      expected_episode_initialized_at timestamptz,
      expected_member_revision bigint,
      expected_shared_status text,
      expected_queue_version bigint,
      expected_queue_stage text,
      expected_is_dnc_locked boolean,
      expected_deleted_at timestamptz,
      expected_settings_revision bigint
    )
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then
      raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
    end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    v_episode_exists := found;
    select * into v_prior_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
    v_prior_queue_exists := found;

    insert into public.acquisition_launch_cohort_items (
      cohort_id, org_id, property_id, member_id, expected_episode_id,
      expected_assigned_user_id, expected_assigned_at, expected_episode_initialized_at,
      expected_member_revision, expected_shared_status, expected_queue_version,
      expected_queue_stage, expected_is_dnc_locked, expected_deleted_at,
      expected_settings_revision, prior_episode_id, prior_episode_eligible,
      prior_episode_assigned_at, prior_episode_initialized_at, prior_queue_exists,
      prior_queue_stage, prior_queue_stage_entered_at, prior_queue_motivation_recorded,
      prior_queue_motivation_kind, prior_queue_motivation_text,
      prior_queue_motivation_recorded_at, prior_queue_motivation_recorded_by,
      prior_queue_archived_at, prior_queue_archived_by, prior_queue_archive_reason,
      prior_queue_version, prior_queue_launch_cohort_id,
      prior_queue_launch_previous_shared_status, prior_queue_signed_at,
      prior_queue_signed_by
    ) values (
      p_cohort_id, p_org_id, v_item.property_id, p_member_id, v_item.expected_episode_id,
      v_item.expected_assigned_user_id, v_item.expected_assigned_at,
      v_item.expected_episode_initialized_at, v_item.expected_member_revision,
      v_item.expected_shared_status, v_item.expected_queue_version, v_item.expected_queue_stage,
      v_item.expected_is_dnc_locked, v_item.expected_deleted_at,
      v_item.expected_settings_revision, v_episode.id,
      case when v_episode_exists then v_episode.eligible end,
      case when v_episode_exists then v_episode.assigned_at end,
      case when v_episode_exists then v_episode.initialized_at end,
      v_prior_queue_exists,
      case when v_prior_queue_exists then v_prior_queue.stage end,
      case when v_prior_queue_exists then v_prior_queue.stage_entered_at end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded end,
      case when v_prior_queue_exists then v_prior_queue.motivation_kind end,
      case when v_prior_queue_exists then v_prior_queue.motivation_text end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded_at end,
      case when v_prior_queue_exists then v_prior_queue.motivation_recorded_by end,
      case when v_prior_queue_exists then v_prior_queue.archived_at end,
      case when v_prior_queue_exists then v_prior_queue.archived_by end,
      case when v_prior_queue_exists then v_prior_queue.archive_reason end,
      case when v_prior_queue_exists then v_prior_queue.version end,
      case when v_prior_queue_exists then v_prior_queue.launch_cohort_id end,
      case when v_prior_queue_exists then v_prior_queue.launch_previous_shared_status end,
      case when v_prior_queue_exists then v_prior_queue.signed_at end,
      case when v_prior_queue_exists then v_prior_queue.signed_by end
    );

    if v_episode_exists then
      update public.acquisition_assignment_episodes
      set ended_at = v_cutover
      where id = v_episode.id and org_id = p_org_id;
    end if;
    insert into public.acquisition_assignment_episodes (
      org_id, property_id, assignee_user_id, episode_kind, eligible,
      assigned_at, initialized_at, launch_cohort_id
    ) values (
      p_org_id, v_item.property_id, p_member_id, 'launch', false,
      null, v_cutover, p_cohort_id
    ) returning id into v_launch_episode_id;

    v_stage := coalesce(v_item.expected_queue_stage,
      case v_item.expected_shared_status
        when 'prospect' then 'contacted'
        when 'new_lead' then 'contacted'
        when 'contacted' then 'contacted'
        when 'interested' then 'needs_offer'
        when 'offer_sent' then 'offer_sent'
        when 'under_contract' then 'under_contract'
        else null
      end);
    if v_stage is null then
      raise exception 'LAUNCH_INVALIDATED' using errcode = '40001';
    end if;
    if v_prior_queue_exists then
      update public.acquisition_queue_states q
      set launch_cohort_id = p_cohort_id,
          launch_previous_shared_status = v_item.expected_shared_status,
          version = q.version + 1,
          updated_at = v_cutover
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
      v_applied_queue_version := v_item.expected_queue_version + 1;
    else
      insert into public.acquisition_queue_states (
        property_id, org_id, stage, stage_entered_at, version,
        launch_cohort_id, launch_previous_shared_status
      ) values (
        v_item.property_id, p_org_id, v_stage, v_cutover, 0,
        p_cohort_id, v_item.expected_shared_status
      );
      v_applied_queue_version := 0;
    end if;
    update public.acquisition_launch_cohort_items i
    set launch_episode_id = v_launch_episode_id
    where i.cohort_id = p_cohort_id and i.property_id = v_item.property_id;
  end loop;

  update public.acquisition_org_settings s
  set active_launch_cohort_id = p_cohort_id,
      launch_cutover_at = v_cutover,
      settings_revision = s.settings_revision + 1,
      updated_at = v_cutover
  where s.org_id = p_org_id;
  update public.acquisition_launch_cohorts
  set status = 'complete', completed_at = v_cutover
  where id = p_cohort_id and org_id = p_org_id;
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'cohortId', p_cohort_id,
    'memberId', p_member_id, 'count', v_count, 'fingerprint', p_preview_fingerprint,
    'settingsRevision', p_expected_settings_revision + 1
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  return v_result;
end;
$$;

create or replace function public.fn_rollback_acquisition_launch(
  p_org_id uuid,
  p_cohort_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_launch_require_owner(p_org_id);
  v_settings public.acquisition_org_settings%rowtype;
  v_cohort public.acquisition_launch_cohorts%rowtype;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_item record;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_queue_exists boolean;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_attempts bigint;
  v_offers bigint;
  v_expected_stage text;
  v_count integer := 0;
  v_now timestamptz := statement_timestamp();
begin
  if p_cohort_id is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'rollback_acquisition_launch', p_org_id, v_actor,
    jsonb_build_object('cohortId', p_cohort_id)
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'rollback_acquisition_launch', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'rollback_acquisition_launch', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;
  select * into v_settings from public.acquisition_org_settings s
  where s.org_id = p_org_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_cohort from public.acquisition_launch_cohorts c
  where c.id = p_cohort_id and c.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_settings.my_leads_enabled then
    raise exception 'FEATURE_ENABLED' using errcode = '40001';
  end if;
  if v_settings.active_launch_cohort_id is distinct from p_cohort_id
     or v_cohort.status not in ('complete', 'running') then
    if v_cohort.status = 'rolled_back' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  for v_item in
    select * from public.acquisition_launch_cohort_items i
    where i.org_id = p_org_id and i.cohort_id = p_cohort_id
    order by property_id
  loop
    select * into v_property from public.properties p
    where p.id = v_item.property_id and p.org_id = p_org_id for update;
    if not found then
      raise exception 'ROLLBACK_BLOCKED' using errcode = '40001';
    end if;
    select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = v_item.property_id and e.ended_at is null
    for update;
    if not found or v_episode.id is distinct from v_item.launch_episode_id
       or v_episode.episode_kind <> 'launch' or v_episode.first_call_started_at is not null then
      raise exception 'ROLLBACK_BLOCKED' using errcode = '40001';
    end if;
    select * into v_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = v_item.property_id for update;
    v_queue_exists := found;
    v_expected_stage := coalesce(v_item.expected_queue_stage,
      case v_item.expected_shared_status
        when 'prospect' then 'contacted'
        when 'new_lead' then 'contacted'
        when 'contacted' then 'contacted'
        when 'interested' then 'needs_offer'
        when 'offer_sent' then 'offer_sent'
        when 'under_contract' then 'under_contract'
        else null
      end);
    if v_property.assigned_user_id is distinct from v_item.expected_assigned_user_id
       or v_property.status is distinct from v_item.expected_shared_status
       or coalesce(v_property.is_dnc_locked, false) is distinct from v_item.expected_is_dnc_locked
       or v_property.deleted_at is distinct from v_item.expected_deleted_at
       or not v_queue_exists
       or v_queue.launch_cohort_id is distinct from p_cohort_id
       or v_queue.launch_previous_shared_status is distinct from v_item.expected_shared_status
       or v_queue.stage is distinct from v_expected_stage
       or v_queue.stage_entered_at is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_stage_entered_at
         else v_queue.stage_entered_at
       end)
       or v_queue.motivation_recorded is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_recorded
         else false
       end)
       or v_queue.motivation_kind is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_kind
         else null
       end)
       or v_queue.motivation_text is distinct from (case
         when v_item.prior_queue_exists then v_item.prior_queue_motivation_text
         else null
       end)
       or v_queue.archived_at is not null
       or v_queue.archived_by is not null
       or v_queue.archive_reason is not null
       or v_queue.version <> v_item.expected_queue_version +
         (case when v_item.prior_queue_exists then 1 else 0 end) then
      raise exception 'ROLLBACK_BLOCKED' using errcode = '40001';
    end if;
    select count(*) into v_attempts from public.acquisition_attempts a
    where a.org_id = p_org_id and a.property_id = v_item.property_id
      and a.assignment_episode_id = v_item.launch_episode_id;
    select count(*) into v_offers from public.acquisition_offers o
    where o.org_id = p_org_id and o.property_id = v_item.property_id
      and o.assignment_episode_id = v_item.launch_episode_id;
    if v_attempts > 0 or v_offers > 0 then
      raise exception 'ROLLBACK_BLOCKED' using errcode = '40001';
    end if;

    update public.acquisition_assignment_episodes
    set ended_at = v_now where id = v_item.launch_episode_id and org_id = p_org_id;
    if v_item.prior_episode_id is not null then
      update public.acquisition_assignment_episodes
      set ended_at = null where id = v_item.prior_episode_id and org_id = p_org_id;
    end if;
    if v_item.prior_queue_exists then
      update public.acquisition_queue_states q
      set stage = v_item.prior_queue_stage,
          stage_entered_at = v_item.prior_queue_stage_entered_at,
          motivation_recorded = v_item.prior_queue_motivation_recorded,
          motivation_kind = v_item.prior_queue_motivation_kind,
          motivation_text = v_item.prior_queue_motivation_text,
          motivation_recorded_at = v_item.prior_queue_motivation_recorded_at,
          motivation_recorded_by = v_item.prior_queue_motivation_recorded_by,
          archived_at = v_item.prior_queue_archived_at,
          archived_by = v_item.prior_queue_archived_by,
          archive_reason = v_item.prior_queue_archive_reason,
          version = v_item.prior_queue_version,
          launch_cohort_id = v_item.prior_queue_launch_cohort_id,
          launch_previous_shared_status = v_item.prior_queue_launch_previous_shared_status,
          signed_at = v_item.prior_queue_signed_at,
          signed_by = v_item.prior_queue_signed_by,
          updated_at = v_now
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
    else
      delete from public.acquisition_queue_states q
      where q.org_id = p_org_id and q.property_id = v_item.property_id;
    end if;
    update public.acquisition_launch_cohort_items
    set rolled_back_at = v_now
    where cohort_id = p_cohort_id and property_id = v_item.property_id;
    v_count := v_count + 1;
  end loop;

  update public.acquisition_org_settings s
  set active_launch_cohort_id = null,
      launch_cutover_at = null,
      settings_revision = s.settings_revision + 1,
      updated_at = v_now
  where s.org_id = p_org_id;
  update public.acquisition_launch_cohorts
  set status = 'rolled_back', completed_at = coalesce(completed_at, v_now)
  where id = p_cohort_id and org_id = p_org_id;
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'rollback_acquisition_launch',
    p_idempotency_key, v_hash,
    jsonb_build_object('ok', true, 'duplicate', false, 'cohortId', p_cohort_id, 'count', v_count)
  );
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'cohortId', p_cohort_id, 'count', v_count
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  return v_result;
end;
$$;

revoke all on function public.bump_my_leads_membership_revision() from public, anon, authenticated, service_role;
revoke all on function public.my_leads_launch_require_owner(uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_leads_launch_candidate_rows(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_leads_launch_fingerprint_rows(uuid, uuid, bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.my_leads_launch_fingerprint(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.fn_preview_acquisition_launch(uuid, uuid) from public, anon, service_role;
grant execute on function public.fn_preview_acquisition_launch(uuid, uuid) to authenticated;
revoke all on function public.fn_apply_acquisition_launch(uuid, uuid, uuid, text, bigint, uuid) from public, anon, service_role;
grant execute on function public.fn_apply_acquisition_launch(uuid, uuid, uuid, text, bigint, uuid) to authenticated;
revoke all on function public.fn_rollback_acquisition_launch(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.fn_rollback_acquisition_launch(uuid, uuid, uuid) to authenticated;

commit;
