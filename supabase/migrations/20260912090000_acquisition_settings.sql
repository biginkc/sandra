-- My Leads foundation: organization settings, protected Acquisitions
-- designation, and the command receipt used by every later mutation packet.
-- Feature rollout remains disabled by default.

begin;

alter table public.memberships
  add column if not exists acquisitions_enabled boolean not null default false;

comment on column public.memberships.acquisitions_enabled is
  'My Leads timing designation. It affects new assignment episodes only and is not an access role.';

create index if not exists memberships_org_acquisitions_idx
  on public.memberships (org_id, acquisitions_enabled, user_id);

create table public.acquisition_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('user', 'service')),
  operation text not null,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  context_key_hash text,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint acquisition_commands_actor_check
    check ((actor_kind = 'user') = (actor_user_id is not null)),
  constraint acquisition_commands_context_hash_check
    check (context_key_hash is null or context_key_hash ~ '^[0-9a-f]{64}$'),
  constraint acquisition_commands_id_org_key unique (id, org_id),
  constraint acquisition_commands_identity_key
    unique (org_id, operation, idempotency_key)
);

create unique index acquisition_commands_context_key_idx
  on public.acquisition_commands (org_id, operation, context_key_hash)
  where context_key_hash is not null;

comment on table public.acquisition_commands is
  'RPC/provider command receipts. Results are replayable; raw request secrets and signed credentials do not belong here.';
comment on column public.acquisition_commands.context_key_hash is
  'Optional SHA-256 digest for a stable provider context such as a Sandra call token.';

alter table public.acquisition_commands enable row level security;
revoke all on table public.acquisition_commands
  from public, anon, authenticated, service_role;

create table public.acquisition_org_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  my_leads_enabled boolean not null default false,
  needs_sequence_owner_id uuid references auth.users(id) on delete restrict,
  active_launch_cohort_id uuid,
  settings_revision bigint not null default 0 check (settings_revision >= 0),
  launch_cutover_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.acquisition_org_settings.my_leads_enabled is
  'Server-side rollout gate. It is enabled only by the admitted launch operation, never by a browser setting toggle.';

alter table public.acquisition_org_settings enable row level security;
revoke all on table public.acquisition_org_settings
  from public, anon, authenticated, service_role;

create or replace function public.my_leads_command_hash(
  p_operation text,
  p_org_id uuid,
  p_actor_user_id uuid,
  p_payload jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', p_operation,
          'org_id', p_org_id,
          'actor_user_id', p_actor_user_id,
          'payload', coalesce(p_payload, '{}'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.my_leads_command_hash(text, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.my_leads_guard_designation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_marker text := current_setting('my_leads.designation_update', true);
  v_expected text;
begin
  if tg_op = 'INSERT' then
    -- New memberships inherit the safe default. A legacy writer cannot seed
    -- the protected designation by including true in an INSERT.
    if new.acquisitions_enabled then
      raise exception 'MY_LEADS_DESIGNATION_FORBIDDEN'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.acquisitions_enabled is distinct from old.acquisitions_enabled then
    v_expected := format(
      '%s:%s:%s',
      auth.uid(),
      new.org_id,
      new.user_id
    );
    if v_marker is distinct from v_expected then
      raise exception 'MY_LEADS_DESIGNATION_FORBIDDEN'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.my_leads_guard_designation_update()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_my_leads_designation_guard on public.memberships;
create trigger trg_my_leads_designation_guard
before insert or update of acquisitions_enabled on public.memberships
for each row execute function public.my_leads_guard_designation_update();

-- The existing membership policies are intentionally broad for the legacy
-- roster. This column has its own privilege boundary; the owner RPC sets a
-- transaction-local marker that the trigger verifies.
revoke update (acquisitions_enabled)
  on table public.memberships
  from public, anon, authenticated, service_role;

create or replace function public.fn_set_acquisition_designation(
  p_org_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_expected_enabled boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_result jsonb;
  v_existing public.acquisition_commands%rowtype;
begin
  if v_actor is null or p_org_id is null or p_user_id is null
     or p_expected_enabled is null
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- Authenticate the caller/org before any replay. Replay may not grant a
  -- newly unauthorized caller access to a prior result.
  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_hash := public.my_leads_command_hash(
    'set_acquisition_designation',
    p_org_id,
    v_actor,
    jsonb_build_object(
      'user_id', p_user_id,
      'enabled', p_enabled,
      'expected_enabled', p_expected_enabled
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'set_acquisition_designation', p_idempotency_key),
    0
  ));

  select * into v_existing
  from public.acquisition_commands c
  where c.org_id = p_org_id
    and c.operation = 'set_acquisition_designation'
    and c.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.actor_user_id is distinct from v_actor
       or v_existing.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
  end if;

  -- Lock the target after the command identity and compare the designation
  -- under that lock. This prevents two owner tabs from silently losing a
  -- toggle while retaining the successful replay result.
  if not exists (
    select 1
    from public.memberships m
    where m.user_id = p_user_id and m.org_id = p_org_id
    for update
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if (select m.acquisitions_enabled from public.memberships m
      where m.user_id = p_user_id and m.org_id = p_org_id)
      is distinct from p_expected_enabled then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;
  if not exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.user_id = p_user_id
      and m.org_id = p_org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
      and coalesce(
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(btrim(u.email), '')
      ) is not null
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  perform set_config(
    'my_leads.designation_update',
    format('%s:%s:%s', v_actor, p_org_id, p_user_id),
    true
  );
  update public.memberships
  set acquisitions_enabled = p_enabled
  where user_id = p_user_id and org_id = p_org_id;
  perform set_config('my_leads.designation_update', '', true);

  v_result := jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'orgId', p_org_id,
    'userId', p_user_id,
    'acquisitionsEnabled', p_enabled
  );
  insert into public.acquisition_commands (
    org_id, actor_user_id, actor_kind, operation, idempotency_key,
    request_hash, result
  ) values (
    p_org_id, v_actor, 'user', 'set_acquisition_designation',
    p_idempotency_key, v_hash, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.fn_set_acquisition_designation(uuid, uuid, boolean, boolean, uuid)
  from public, anon, service_role;
grant execute on function public.fn_set_acquisition_designation(uuid, uuid, boolean, boolean, uuid)
  to authenticated;

create or replace function public.fn_set_acquisition_settings(
  p_org_id uuid,
  p_needs_sequence_owner_id uuid,
  p_expected_settings_revision bigint,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_result jsonb;
  v_enabled boolean;
  v_revision bigint;
  v_existing public.acquisition_commands%rowtype;
  v_current_revision bigint := 0;
  v_settings_exists boolean := false;
begin
  if v_actor is null or p_org_id is null or p_needs_sequence_owner_id is null
     or p_expected_settings_revision is null or p_expected_settings_revision < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor and m.org_id = p_org_id and m.role = 'owner'
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_hash := public.my_leads_command_hash(
    'set_acquisition_settings', p_org_id, v_actor,
    jsonb_build_object(
      'needs_sequence_owner_id', p_needs_sequence_owner_id,
      'expected_settings_revision', p_expected_settings_revision
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'set_acquisition_settings', p_idempotency_key),
    0
  ));
  select * into v_existing from public.acquisition_commands c
  where c.org_id = p_org_id and c.operation = 'set_acquisition_settings'
    and c.idempotency_key = p_idempotency_key for update;
  if found then
    if v_existing.actor_user_id is distinct from v_actor
       or v_existing.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_set(v_existing.result, '{duplicate}', 'true'::jsonb, true);
  end if;
  -- Organization settings are the next lock in the org-level command order.
  select s.settings_revision into v_current_revision
  from public.acquisition_org_settings s
  where s.org_id = p_org_id
  for update;
  v_settings_exists := found;
  if v_current_revision is distinct from p_expected_settings_revision
     and not (not v_settings_exists and p_expected_settings_revision = 0) then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- The recipient is locked after settings so concurrent owner changes cannot
  -- validate a member that is being revoked or expired in the same window.
  if not exists (
    select 1 from public.memberships m
    where m.user_id = p_needs_sequence_owner_id and m.org_id = p_org_id
    for update
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.user_id = p_needs_sequence_owner_id and m.org_id = p_org_id
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
      and coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                   nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                   nullif(btrim(u.email), '')) is not null
  ) then
    raise exception 'RECIPIENT_UNAVAILABLE' using errcode = '22023';
  end if;

  insert into public.acquisition_org_settings (org_id, needs_sequence_owner_id)
  values (p_org_id, p_needs_sequence_owner_id)
  on conflict (org_id) do update
  set needs_sequence_owner_id = excluded.needs_sequence_owner_id,
      settings_revision = public.acquisition_org_settings.settings_revision + 1,
      updated_at = statement_timestamp();

  select s.my_leads_enabled into v_enabled
  from public.acquisition_org_settings s
  where s.org_id = p_org_id;
  select s.settings_revision into v_revision
  from public.acquisition_org_settings s
  where s.org_id = p_org_id;

  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'orgId', p_org_id,
    'needsSequenceOwnerId', p_needs_sequence_owner_id,
    'myLeadsEnabled', coalesce(v_enabled, false),
    'settingsRevision', coalesce(v_revision, 0)
  );
  insert into public.acquisition_commands (
    org_id, actor_user_id, actor_kind, operation, idempotency_key,
    request_hash, result
  ) values (
    p_org_id, v_actor, 'user', 'set_acquisition_settings',
    p_idempotency_key, v_hash, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.fn_set_acquisition_settings(uuid, uuid, bigint, uuid)
  from public, anon, service_role;
grant execute on function public.fn_set_acquisition_settings(uuid, uuid, bigint, uuid)
  to authenticated;

commit;
