begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.org_esign_canary_leases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  actor_id uuid not null references auth.users(id),
  lease_token_hash text not null check (
    lease_token_hash ~ '^[a-f0-9]{64}$'
  ),
  status text not null default 'active' check (
    status in ('active', 'restored', 'expired')
  ),
  requested_test_mode boolean not null,
  requested_sending_enabled boolean not null,
  original_test_mode boolean not null,
  original_sending_enabled boolean not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  restored_at timestamptz,
  restored_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_esign_canary_leases_run_id_key unique (run_id),
  constraint org_esign_canary_leases_expires_after_start check (
    expires_at > started_at
  )
);

create unique index if not exists idx_org_esign_canary_leases_active_per_org
  on public.org_esign_canary_leases (org_id)
  where status = 'active';

create index if not exists idx_org_esign_canary_leases_org_status
  on public.org_esign_canary_leases (org_id, status, expires_at);

comment on table public.org_esign_canary_leases is
  'Durable service-role canary lease for temporary eSign mode transitions.';
comment on column public.org_esign_canary_leases.lease_token_hash is
  'sha256 digest of the canary lease token. The plain token is never persisted.';

create or replace function public.list_expired_esign_canary_leases(
  p_org_id uuid default null
)
returns table (
  org_id uuid,
  run_id uuid,
  actor_id uuid,
  lease_id uuid,
  started_at timestamptz,
  expires_at timestamptz,
  seconds_overdue bigint,
  original_test_mode boolean,
  original_sending_enabled boolean,
  requested_test_mode boolean,
  requested_sending_enabled boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    lease.org_id,
    lease.run_id,
    lease.actor_id,
    lease.id,
    lease.started_at,
    lease.expires_at,
    floor(extract(epoch from (now() - lease.expires_at)))::bigint,
    lease.original_test_mode,
    lease.original_sending_enabled,
    lease.requested_test_mode,
    lease.requested_sending_enabled
  from public.org_esign_canary_leases lease
  where (lease.status = 'expired'
     or (lease.status = 'active' and lease.expires_at <= now()))
    and (p_org_id is null or lease.org_id = p_org_id)
  order by lease.expires_at asc;
$$;

create or replace function public.start_esign_canary_lease(
  p_org_id uuid,
  p_actor_id uuid,
  p_run_id uuid,
  p_expires_at timestamptz default now() + interval '20 minutes',
  p_requested_test_mode boolean default true,
  p_requested_sending_enabled boolean default true
)
returns table (
  run_id uuid,
  lease_id uuid,
  lease_token uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_integration public.org_esign_integrations%rowtype;
  v_active public.org_esign_canary_leases%rowtype;
  v_token uuid := gen_random_uuid();
  v_token_hash text;
  v_original_test_mode boolean;
  v_original_sending_enabled boolean;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_org_id = '00000000-0000-0000-0000-000000000bbb'::uuid then
    raise exception 'canary lease is not available for the sales organization'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'run_id is required' using errcode = '22023';
  end if;
  if p_expires_at > v_now + interval '20 minutes' then
    raise exception 'canary lease expiration is capped at 20 minutes'
      using errcode = '22023';
  end if;
  if p_expires_at <= v_now then
    raise exception 'canary lease must expire in the future' using errcode = '22023';
  end if;
  if p_requested_test_mode is distinct from true
     or p_requested_sending_enabled is distinct from true then
    raise exception 'canary lease requires requested test mode enabled and sending enabled'
      using errcode = '22023';
  end if;

  select * into v_active
  from public.org_esign_canary_leases lease
  where lease.org_id = p_org_id
    and lease.status = 'active'
  for update;

  if found then
    if v_active.expires_at <= v_now then
      raise exception 'active canary lease has expired for this org'
        using errcode = '55000';
    end if;
    raise exception 'organization already has an active canary lease'
      using errcode = '55000';
  end if;

  if exists (
    select 1 from public.org_esign_canary_leases lease
    where lease.org_id = p_org_id and lease.status = 'expired'
  ) then
    raise exception 'expired canary lease requires explicit recovery'
      using errcode = '55000';
  end if;

  perform public.esign_require_active_owner(p_org_id, p_actor_id);

  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected' using errcode = 'P0002';
  end if;

  v_original_test_mode := v_integration.test_mode;
  v_original_sending_enabled := v_integration.sending_enabled;

  perform public.set_org_esign_test_mode(p_org_id, p_actor_id, true);
  perform public.set_org_esign_sending_enabled(p_org_id, p_actor_id, true);

  select * into v_integration
  from public.org_esign_integrations
  where org_id = p_org_id
  for update;

  if v_integration.test_mode is distinct from p_requested_test_mode
     or v_integration.sending_enabled is distinct from p_requested_sending_enabled then
    raise exception 'canary transition did not take effect'
      using errcode = '55000';
  end if;

  v_token_hash := encode(
    extensions.digest(convert_to(v_token::text, 'utf8'), 'sha256'),
    'hex'
  );

  insert into public.org_esign_canary_leases (
    org_id,
    run_id,
    actor_id,
    lease_token_hash,
    requested_test_mode,
    requested_sending_enabled,
    original_test_mode,
    original_sending_enabled,
    started_at,
    expires_at
  ) values (
    p_org_id,
    p_run_id,
    p_actor_id,
    v_token_hash,
    p_requested_test_mode,
    p_requested_sending_enabled,
    v_original_test_mode,
    v_original_sending_enabled,
    v_now,
    p_expires_at
  ) returning
    p_run_id,
    id,
    v_token
    into run_id, lease_id, lease_token;

  return next;
  return;
end;
$$;

create or replace function public.restore_esign_canary_lease(
  p_org_id uuid,
  p_actor_id uuid,
  p_run_id uuid,
  p_lease_token uuid
)
returns table (
  outcome text,
  lease_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease public.org_esign_canary_leases%rowtype;
  v_integration public.org_esign_integrations%rowtype;
  v_token_hash text;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_org_id = '00000000-0000-0000-0000-000000000bbb'::uuid then
    raise exception 'canary lease is not available for the sales organization'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'run_id is required' using errcode = '22023';
  end if;
  if p_lease_token is null then
    raise exception 'lease token is required' using errcode = '22023';
  end if;

  perform public.esign_require_active_owner(p_org_id, p_actor_id);

  select * into v_lease
  from public.org_esign_canary_leases lease
  where lease.org_id = p_org_id
    and lease.run_id = p_run_id
    and lease.status in ('active', 'expired')
  for update;

  if not found then
    raise exception 'recoverable canary lease was not found'
      using errcode = 'P0002';
  end if;

  v_token_hash := encode(
    extensions.digest(convert_to(p_lease_token::text, 'utf8'), 'sha256'),
    'hex'
  );
  if v_lease.lease_token_hash is distinct from v_token_hash then
    raise exception 'canary lease token is invalid' using errcode = '42501';
  end if;

  select * into v_integration
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for update;
  if not found then
    raise exception 'Dropbox Sign is not connected'
      using errcode = 'P0002';
  end if;

  if v_integration.test_mode is distinct from v_lease.requested_test_mode
     or v_integration.sending_enabled is distinct from
       (case when v_lease.status = 'expired' then false
             else v_lease.requested_sending_enabled end) then
    raise exception 'canary lease state has changed; aborting restore'
      using errcode = '55000';
  end if;

  if v_lease.expires_at <= v_now and v_lease.status = 'active' then
    update public.org_esign_integrations
    set sending_enabled = false, updated_by = p_actor_id, updated_at = v_now
    where org_id = p_org_id and provider = 'dropbox_sign';
    update public.org_esign_canary_leases
    set status = 'expired', updated_at = v_now
    where id = v_lease.id;
  end if;

  perform public.set_org_esign_test_mode(
    p_org_id, p_actor_id, v_lease.original_test_mode
  );
  perform public.set_org_esign_sending_enabled(
    p_org_id, p_actor_id, v_lease.original_sending_enabled
  );

  select * into v_integration
  from public.org_esign_integrations
  where org_id = p_org_id
  for update;

  if v_integration.test_mode is distinct from v_lease.original_test_mode
     or v_integration.sending_enabled is distinct from v_lease.original_sending_enabled then
    raise exception 'canary restore readback failed'
      using errcode = '55000';
  end if;

  update public.org_esign_canary_leases
  set status = 'restored',
      restored_at = v_now,
      restored_by = p_actor_id,
      updated_at = v_now
  where id = v_lease.id;

  return query select 'restored'::text, v_lease.id;
end;
$$;

-- A missing watchdog run cannot allow a new request after the lease deadline.
create or replace function public.reject_expired_esign_canary_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.org_esign_canary_leases lease
    where lease.org_id = new.org_id
      and lease.status in ('active', 'expired')
      and lease.expires_at <= clock_timestamp()
  ) then
    raise exception 'expired eSign canary lease blocks new contract requests'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger reject_expired_esign_canary_request_before_insert
  before insert on public.esign_requests
  for each row execute function public.reject_expired_esign_canary_request();

-- The watchdog makes the expiration visible and disables sending. It never
-- restores the prior live mode: recovery requires the held token and readback.
create or replace function public.fence_expired_esign_canary_lease(
  p_org_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease public.org_esign_canary_leases%rowtype;
  v_integration public.org_esign_integrations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_lease from public.org_esign_canary_leases lease
  where lease.org_id = p_org_id and lease.run_id = p_run_id
  for update;
  if not found then return 'not_found'; end if;
  if v_lease.status = 'restored' then return 'restored'; end if;
  if v_lease.expires_at > clock_timestamp() then return 'not_expired'; end if;
  select * into v_integration from public.org_esign_integrations integration
  where integration.org_id = p_org_id and integration.provider = 'dropbox_sign'
  for update;
  if not found then return 'integration_missing'; end if;
  if v_integration.test_mode is distinct from v_lease.requested_test_mode then
    return 'state_conflict';
  end if;
  update public.org_esign_integrations
  set sending_enabled = false, updated_by = v_lease.actor_id, updated_at = now()
  where org_id = p_org_id and provider = 'dropbox_sign';
  update public.org_esign_canary_leases
  set status = 'expired', updated_at = now()
  where id = v_lease.id;
  return 'fenced';
end;
$$;

-- Called immediately before the Dropbox Sign network handoff for a dedicated
-- canary org. A request claimed before expiry cannot dispatch after expiry.
create or replace function public.allow_esign_canary_provider_dispatch(
  p_org_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease public.org_esign_canary_leases%rowtype;
  v_request public.esign_requests%rowtype;
  v_integration public.org_esign_integrations%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_org_id = '00000000-0000-0000-0000-000000000bbb'::uuid then
    return false;
  end if;
  select * into v_lease from public.org_esign_canary_leases lease
  where lease.org_id = p_org_id and lease.status = 'active'
  for update;
  if not found then return false; end if;
  if v_lease.expires_at <= v_now then
    perform public.fence_expired_esign_canary_lease(p_org_id, v_lease.run_id);
    return false;
  end if;
  -- Leave enough time for the bounded provider request to finish.
  if v_lease.expires_at <= v_now + interval '45 seconds' then return false; end if;
  select * into v_request from public.esign_requests request
  where request.org_id = p_org_id and request.id = p_request_id;
  if not found or v_request.test_mode is distinct from true
     or v_request.delivery_state is distinct from 'sending'
     or v_request.created_at < v_lease.started_at
     or v_request.created_at >= v_lease.expires_at then
    return false;
  end if;
  select * into v_integration from public.org_esign_integrations integration
  where integration.org_id = p_org_id and integration.provider = 'dropbox_sign'
  for update;
  if not found or v_integration.test_mode is distinct from true
     or v_integration.sending_enabled is distinct from true then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.start_esign_canary_lease(uuid, uuid, uuid, timestamptz, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.start_esign_canary_lease(uuid, uuid, uuid, timestamptz, boolean, boolean)
  to service_role;

revoke all on function public.restore_esign_canary_lease(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_esign_canary_lease(uuid, uuid, uuid, uuid)
  to service_role;

revoke all on function public.list_expired_esign_canary_leases(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_esign_canary_leases(uuid)
  to service_role;

revoke all on function public.fence_expired_esign_canary_lease(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.fence_expired_esign_canary_lease(uuid, uuid)
  to service_role;

revoke all on function public.reject_expired_esign_canary_request()
  from public, anon, authenticated, service_role;

revoke all on function public.allow_esign_canary_provider_dispatch(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.allow_esign_canary_provider_dispatch(uuid, uuid)
  to service_role;

revoke all on table public.org_esign_canary_leases from public, anon, authenticated;
grant all on table public.org_esign_canary_leases to service_role;

commit;
