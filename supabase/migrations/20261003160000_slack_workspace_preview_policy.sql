-- Workspace-wide Slack preview policy. Existing installations start in
-- legacy mode so manual channel approvals continue to behave unchanged.
-- Only an owner can switch an installation to eligible-internal-channels or
-- disable all preview work. Policy revisions fence jobs across every switch.
alter table public.slack_unfurl_jobs
  add column if not exists policy_revision bigint;

create table public.slack_preview_policies (
  installation_id uuid primary key references public.slack_installations(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  mode text not null default 'legacy' check (mode in ('legacy','eligible_internal_channels','disabled')),
  policy_revision bigint not null default 1 check (policy_revision > 0),
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index slack_preview_policies_org_idx on public.slack_preview_policies(org_id, mode);
alter table public.slack_preview_policies enable row level security;

-- A channel_shared lifecycle event is a durable denial even when no legacy
-- approval row existed. The tombstone deliberately survives reconnects and
-- policy changes until a separately reviewed operator workflow removes it.
create table public.slack_channel_denials (
  installation_id uuid not null references public.slack_installations(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_id text not null,
  source_event_id text,
  denied_reason text not null,
  denied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (installation_id, channel_id)
);

create index slack_channel_denials_lookup_idx
  on public.slack_channel_denials(installation_id, channel_id);
alter table public.slack_channel_denials enable row level security;

insert into public.slack_preview_policies(installation_id, org_id)
select i.id, i.org_id
  from public.slack_installations i
on conflict (installation_id) do nothing;

-- Keep policy rows present for installations created after this migration.
create or replace function public.upsert_slack_installation(
  p_org_id uuid, p_team_id text, p_app_id text, p_team_name text, p_bot_user_id text,
  p_bot_token text, p_scopes text[], p_installed_by uuid, p_key text
) returns table(installation_id uuid, installation_version integer)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.slack_installations;
begin
  insert into public.slack_installations(org_id,team_id,app_id,team_name,bot_user_id,bot_token_encrypted,scopes,installed_by)
  values (p_org_id,p_team_id,p_app_id,p_team_name,p_bot_user_id,pgp_sym_encrypt(p_bot_token,p_key),coalesce(p_scopes,'{}'),p_installed_by)
  on conflict (org_id,team_id,app_id) do update set
    team_name=excluded.team_name, bot_user_id=excluded.bot_user_id,
    bot_token_encrypted=excluded.bot_token_encrypted, scopes=excluded.scopes,
    installed_by=excluded.installed_by, status='active',
    installation_version=case when slack_installations.status='revoked' then slack_installations.installation_version+1 else slack_installations.installation_version end,
    revoked_at=null, revoked_reason=null, updated_at=now()
  returning * into v;
  insert into public.slack_preview_policies(installation_id,org_id)
  values(v.id,p_org_id) on conflict on constraint slack_preview_policies_pkey do nothing;
  return query select v.id,v.installation_version;
end;
$$;

create or replace function public.approve_slack_channel(
  p_installation_id uuid, p_org_id uuid, p_channel_id text, p_approved_by uuid,
  p_sharing_policy_acknowledged boolean
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not p_sharing_policy_acknowledged then raise exception 'SHARING_POLICY_ACK_REQUIRED' using errcode='22023'; end if;
  if not exists (
    select 1 from public.memberships m where m.user_id=p_approved_by and m.org_id=p_org_id
      and m.role = 'owner'
      and coalesce(m.access_status,'active')='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ) then raise exception 'APPROVER_NOT_ACTIVE' using errcode='42501'; end if;
  if exists (select 1 from public.slack_channel_denials d where d.installation_id=p_installation_id and d.org_id=p_org_id and d.channel_id=p_channel_id) then
    raise exception 'CHANNEL_DENIED' using errcode='42501';
  end if;
  if not exists (select 1 from public.slack_installations i where i.id=p_installation_id and i.org_id=p_org_id and i.status='active') then
    raise exception 'INSTALLATION_NOT_ACTIVE' using errcode='22023';
  end if;
  insert into public.slack_channel_approvals(installation_id,org_id,channel_id,sharing_policy_acknowledged,status,approved_by,approved_at,revoked_at,revoked_reason)
  values(p_installation_id,p_org_id,p_channel_id,true,'active',p_approved_by,now(),null,null)
  on conflict (installation_id,channel_id) do update set status='active',sharing_policy_acknowledged=true,approved_by=p_approved_by,approved_at=now(),revoked_at=null,revoked_reason=null,updated_at=now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.enqueue_slack_unfurl_event(
  p_team_id text, p_app_id text, p_event_id text, p_event_type text, p_event_time timestamptz,
  p_org_id uuid, p_installation_id uuid, p_installation_version integer, p_channel_id text, p_message_ts text,
  p_poster_slack_user_id text, p_url_keys text[], p_denial_code text default null
) returns table(accepted boolean, duplicate boolean, job_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_receipt public.slack_event_receipts;
  v_job uuid;
  v_current_installation_version integer;
  v_installation_status text;
  v_policy_mode text := 'legacy';
  v_policy_revision bigint;
  v_denial_code text := p_denial_code;
  v_terminal boolean := p_denial_code is not null or coalesce(array_length(p_url_keys,1),0)=0;
  v_channel_denied boolean := false;
begin
  -- Lock the installation before deriving policy revision. Revoke, disable,
  -- reconnect, and enqueue therefore serialize on one authoritative row.
  if not v_terminal or p_installation_id is not null then
    if p_installation_id is null or p_org_id is null then raise exception 'INSTALLATION_REQUIRED' using errcode='22023'; end if;
    if p_installation_version is null then raise exception 'INSTALLATION_VERSION_REQUIRED' using errcode='22023'; end if;
    select i.installation_version, i.status into v_current_installation_version, v_installation_status
      from public.slack_installations i
     where i.id=p_installation_id and i.org_id=p_org_id and i.team_id=p_team_id and i.app_id=p_app_id
     for update;
    if v_current_installation_version is null or v_installation_status <> 'active' then raise exception 'INSTALLATION_NOT_ACTIVE' using errcode='22023'; end if;
    if v_current_installation_version <> p_installation_version then raise exception 'INSTALLATION_VERSION_MISMATCH' using errcode='22023'; end if;
    select coalesce(p.mode,'legacy'), p.policy_revision into v_policy_mode, v_policy_revision
      from public.slack_preview_policies p where p.installation_id=p_installation_id and p.org_id=p_org_id;
    if v_policy_mode='disabled' then
      v_terminal := true;
      v_denial_code := coalesce(v_denial_code,'previews_disabled');
    elsif v_policy_mode='eligible_internal_channels' then
      select exists(
        select 1 from public.slack_channel_denials d
         where d.installation_id=p_installation_id and d.org_id=p_org_id and d.channel_id=p_channel_id
      ) or exists(
        select 1 from public.slack_channel_approvals a
         where a.installation_id=p_installation_id and a.org_id=p_org_id and a.channel_id=p_channel_id and a.status='revoked'
      ) into v_channel_denied;
      if v_channel_denied then
        v_terminal := true;
        v_denial_code := coalesce(v_denial_code,'channel_not_approved');
      end if;
    else
      v_policy_revision := null;
    end if;
  end if;
  insert into public.slack_event_receipts(team_id,app_id,event_id,event_type,event_time,channel_id,message_ts,poster_slack_user_id,status,denial_code)
  values(p_team_id,p_app_id,p_event_id,p_event_type,p_event_time,p_channel_id,p_message_ts,p_poster_slack_user_id,case when v_terminal then 'noop' else 'accepted' end,v_denial_code)
  on conflict (team_id,event_id) do nothing returning * into v_receipt;
  if v_receipt.id is null then
    select r.* into v_receipt from public.slack_event_receipts r where r.team_id=p_team_id and r.event_id=p_event_id for update;
    select j.id into v_job from public.slack_unfurl_jobs j where j.receipt_id=v_receipt.id;
    if v_job is not null or v_receipt.status <> 'accepted' or v_terminal then
      return query select true,true,v_job; return;
    end if;
    insert into public.slack_unfurl_jobs(receipt_id,installation_id,installation_version,policy_revision,org_id,team_id,app_id,channel_id,message_ts,poster_slack_user_id,event_time,expires_at)
    values(v_receipt.id,p_installation_id,p_installation_version,case when v_policy_mode='eligible_internal_channels' then v_policy_revision else null end,p_org_id,p_team_id,p_app_id,p_channel_id,p_message_ts,p_poster_slack_user_id,coalesce(p_event_time,now()),coalesce(p_event_time,now())+interval '15 minutes')
    returning id into v_job;
    insert into public.slack_unfurl_job_urls(job_id,url_key)
    select v_job,u from (select distinct unnest(p_url_keys) u) s where length(u) > 0;
    return query select true,true,v_job; return;
  end if;
  if v_terminal then return query select true,false,null::uuid; return; end if;
  insert into public.slack_unfurl_jobs(receipt_id,installation_id,installation_version,policy_revision,org_id,team_id,app_id,channel_id,message_ts,poster_slack_user_id,event_time,expires_at)
  values(v_receipt.id,p_installation_id,p_installation_version,case when v_policy_mode='eligible_internal_channels' then v_policy_revision else null end,p_org_id,p_team_id,p_app_id,p_channel_id,p_message_ts,p_poster_slack_user_id,coalesce(p_event_time,now()),coalesce(p_event_time,now())+interval '15 minutes')
  returning id into v_job;
  insert into public.slack_unfurl_job_urls(job_id,url_key)
  select v_job,u from (select distinct unnest(p_url_keys) u) s where length(u) > 0;
  return query select true,false,v_job;
end;
$$;

-- The final guard fences both legacy jobs and workspace-policy jobs. A legacy
-- job is valid only while the installation remains in legacy mode; a policy
-- job must match the exact enabled revision captured by enqueue.
create or replace function public.guard_slack_unfurl_dispatch(
  p_job_id uuid, p_claim_token uuid, p_installation_id uuid,
  p_installation_version integer, p_org_id uuid, p_channel_id text,
  p_poster_slack_user_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user_id uuid; v_found integer; v_has_approval boolean;
begin
  perform 1 from public.slack_installations i
   where i.id=p_installation_id and i.org_id=p_org_id and i.status='active'
     and i.installation_version=p_installation_version
   for update;
  if not found then return false; end if;

  select l.user_id into v_user_id
    from public.slack_account_links l
   where l.installation_id=p_installation_id and l.org_id=p_org_id
     and l.slack_user_id=p_poster_slack_user_id and l.status='active'
   for update;
  if not found then return false; end if;

  perform 1 from public.memberships m
   where m.user_id=v_user_id and m.org_id=p_org_id
     and coalesce(m.access_status,'active')='active'
     and m.deletion_prepared_at is null
     and (m.access_expires_at is null or m.access_expires_at > now())
   for update;
  if not found then return false; end if;

  if exists (
    select 1 from public.slack_channel_denials d
     where d.installation_id=p_installation_id and d.org_id=p_org_id and d.channel_id=p_channel_id
  ) then return false; end if;
  if exists (
    select 1 from public.slack_channel_approvals a
     where a.installation_id=p_installation_id and a.org_id=p_org_id and a.channel_id=p_channel_id and a.status='revoked'
  ) then return false; end if;

  perform 1 from public.slack_channel_approvals a
   where a.installation_id=p_installation_id and a.org_id=p_org_id
     and a.channel_id=p_channel_id and a.status='active'
     and a.sharing_policy_acknowledged=true
   for update;
  v_has_approval := found;
  if not exists (
    select 1 from public.slack_preview_policies p
     where p.installation_id=p_installation_id and p.org_id=p_org_id and p.mode='eligible_internal_channels'
  ) and not v_has_approval then return false; end if;

  select 1 into v_found
    from public.slack_unfurl_jobs j
   where j.id=p_job_id and j.status='processing' and j.claim_token=p_claim_token
     and j.installation_id=p_installation_id and j.installation_version=p_installation_version
     and j.org_id=p_org_id and j.channel_id=p_channel_id
     and j.poster_slack_user_id=p_poster_slack_user_id
     and j.lease_expires_at > now() and j.expires_at > now()
     and (
       (j.policy_revision is null and exists (
          select 1 from public.slack_preview_policies p
           where p.installation_id=p_installation_id and p.org_id=p_org_id and p.mode='legacy'
       ))
       or (j.policy_revision is not null and exists (
          select 1 from public.slack_preview_policies p
           where p.installation_id=p_installation_id and p.org_id=p_org_id
             and p.mode='eligible_internal_channels' and p.policy_revision=j.policy_revision
       ))
     )
   for update;
  return found;
end;
$$;

-- The settings surface receives only installation metadata. Token ciphertext,
-- scopes, and account-link identifiers stay inside the service-role RPC.
create or replace function public.list_slack_preview_installations(
  p_org_id uuid, p_user_id uuid
) returns table(
  installation_id uuid, org_id uuid, team_name text, app_id text,
  status text, installation_version integer, policy_enabled boolean,
  account_linked boolean
)
language sql security definer set search_path = public, pg_temp as $$
  select i.id, i.org_id, i.team_name, i.app_id, i.status, i.installation_version,
    coalesce(p.mode = 'eligible_internal_channels', false),
    exists (
      select 1 from public.slack_account_links l
       where l.installation_id = i.id and l.org_id = i.org_id
         and l.user_id = p_user_id and l.status = 'active'
    )
  from public.slack_installations i
  left join public.slack_preview_policies p on p.installation_id = i.id
  where i.org_id = p_org_id
  order by i.team_name, i.id;
$$;

create or replace function public.set_slack_preview_policy(
  p_installation_id uuid, p_org_id uuid, p_owner_id uuid, p_enabled boolean
) returns table(mode text, policy_revision bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_installation public.slack_installations;
  v_mode text;
  v_revision bigint;
begin
  select i.* into v_installation from public.slack_installations i
   where i.id=p_installation_id and i.org_id=p_org_id
   for update;
  if not found or v_installation.status <> 'active' then raise exception 'INSTALLATION_NOT_ACTIVE' using errcode='22023'; end if;
  if not (v_installation.scopes @> array['links:read','links:write','channels:read','groups:read','users:read']::text[]) then
    raise exception 'INSTALLATION_SCOPE_MISSING' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.memberships m where m.user_id=p_owner_id and m.org_id=p_org_id
      and m.role='owner' and coalesce(m.access_status,'active')='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at > now())
  ) then raise exception 'OWNER_NOT_ACTIVE' using errcode='42501'; end if;
  v_mode := case when p_enabled then 'eligible_internal_channels' else 'disabled' end;
  insert into public.slack_preview_policies(installation_id,org_id,mode,policy_revision,acknowledged_by,acknowledged_at,disabled_at,disabled_reason)
  values(p_installation_id,p_org_id,v_mode,1,p_owner_id,case when p_enabled then now() else null end,case when p_enabled then null else now() end,case when p_enabled then null else 'owner_disabled' end)
  on conflict (installation_id) do update set
    org_id=excluded.org_id, mode=excluded.mode,
    policy_revision=public.slack_preview_policies.policy_revision+1,
    acknowledged_by=case when excluded.mode='eligible_internal_channels' then excluded.acknowledged_by else public.slack_preview_policies.acknowledged_by end,
    acknowledged_at=case when excluded.mode='eligible_internal_channels' then excluded.acknowledged_at else public.slack_preview_policies.acknowledged_at end,
    disabled_at=excluded.disabled_at, disabled_reason=excluded.disabled_reason, updated_at=now()
  returning public.slack_preview_policies.mode, public.slack_preview_policies.policy_revision into mode, policy_revision;
  if v_mode='disabled' then
    with cancelled as (
      update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,last_error_code='previews_disabled',updated_at=now()
       where j.installation_id=p_installation_id and j.status in ('queued','processing') returning j.receipt_id
    ) update public.slack_event_receipts r set status='cancelled',updated_at=now() from cancelled where r.id=cancelled.receipt_id;
  end if;
  return next;
end;
$$;

create or replace function public.deny_slack_channel(
  p_team_id text, p_app_id text, p_channel_id text, p_reason text, p_source_event_id text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  insert into public.slack_channel_denials(installation_id,org_id,channel_id,source_event_id,denied_reason,updated_at)
  select i.id,i.org_id,p_channel_id,p_source_event_id,p_reason,now()
    from public.slack_installations i where i.team_id=p_team_id and i.app_id=p_app_id
  on conflict (installation_id,channel_id) do update set source_event_id=coalesce(excluded.source_event_id,slack_channel_denials.source_event_id),denied_reason=excluded.denied_reason,updated_at=now();
  update public.slack_channel_approvals a set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    from public.slack_installations i where a.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and a.channel_id=p_channel_id and a.status='active';
  get diagnostics v_count = row_count;
  with cancelled as (
    update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,last_error_code=p_reason,updated_at=now()
      from public.slack_installations i where j.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and j.channel_id=p_channel_id and j.status in ('queued','processing') returning j.receipt_id
  ) update public.slack_event_receipts r set status='revoked',updated_at=now() from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

create or replace function public.process_slack_lifecycle_event(
  p_team_id text, p_app_id text, p_event_id text, p_event_type text,
  p_event_time timestamptz, p_channel_id text, p_slack_user_ids text[],
  p_action text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_receipt uuid;
begin
  insert into public.slack_event_receipts(team_id,app_id,event_id,event_type,event_time,channel_id,status,denial_code)
  values(p_team_id,p_app_id,p_event_id,p_event_type,p_event_time,p_channel_id,'revoked','lifecycle_processed')
  on conflict (team_id,event_id) do nothing returning id into v_receipt;
  if v_receipt is null then return false; end if;
  if p_action='installation' then
    perform public.revoke_slack_installation(p_team_id,p_app_id,p_event_type);
  elsif p_action='account_links' then
    perform public.revoke_slack_account_links(p_team_id,p_app_id,coalesce(p_slack_user_ids,'{}'),p_event_type);
  elsif p_action='channel' and p_channel_id is not null then
    perform public.deny_slack_channel(p_team_id,p_app_id,p_channel_id,p_event_type,p_event_id);
  elsif p_action <> 'noop' then
    raise exception 'INVALID_LIFECYCLE_ACTION' using errcode='22023';
  end if;
  return true;
end;
$$;

-- Installation revocation disables the workspace policy and advances its
-- revision, so a reconnect cannot resurrect jobs from the old generation.
create or replace function public.revoke_slack_installation(
  p_team_id text, p_app_id text, p_reason text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.slack_installations set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    where team_id=p_team_id and app_id=p_app_id and status='active';
  get diagnostics v_count = row_count;
  update public.slack_preview_policies p set mode='disabled',policy_revision=p.policy_revision+1,disabled_at=now(),disabled_reason=p_reason,updated_at=now()
    from public.slack_installations i where p.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id;
  update public.slack_account_links l set status='revoked',revoked_at=now(),updated_at=now()
    from public.slack_installations i where l.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and l.status='active';
  update public.slack_channel_approvals a set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    from public.slack_installations i where a.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and a.status='active';
  with cancelled as (
    update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,updated_at=now()
      from public.slack_installations i where j.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and j.status in ('queued','processing') returning j.receipt_id
  ) update public.slack_event_receipts r set status='revoked',updated_at=now() from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

create or replace function public.revoke_slack_installation_generation(
  p_team_id text, p_app_id text, p_installation_id uuid,
  p_installation_version integer, p_reason text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_current_version integer; v_status text; v_count integer;
begin
  select i.installation_version, i.status into v_current_version, v_status
    from public.slack_installations i where i.id=p_installation_id and i.team_id=p_team_id and i.app_id=p_app_id for update;
  if not found or v_status <> 'active' or v_current_version <> p_installation_version then return 0; end if;
  update public.slack_installations set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now() where id=p_installation_id;
  get diagnostics v_count = row_count;
  update public.slack_preview_policies p set mode='disabled',policy_revision=p.policy_revision+1,disabled_at=now(),disabled_reason=p_reason,updated_at=now() where p.installation_id=p_installation_id;
  update public.slack_account_links set status='revoked',revoked_at=now(),updated_at=now() where installation_id=p_installation_id and status='active';
  update public.slack_channel_approvals set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now() where installation_id=p_installation_id and status='active';
  with cancelled as (update public.slack_unfurl_jobs set status='cancelled',claim_token=null,lease_expires_at=null,last_error_code=p_reason,updated_at=now() where installation_id=p_installation_id and installation_version=p_installation_version and status in ('queued','processing') returning receipt_id)
  update public.slack_event_receipts r set status='revoked',updated_at=now() from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

revoke all on table public.slack_preview_policies, public.slack_channel_denials from public, anon, authenticated;
grant select on public.slack_preview_policies, public.slack_channel_denials to service_role;
revoke all on function public.set_slack_preview_policy(uuid,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.deny_slack_channel(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.set_slack_preview_policy(uuid,uuid,uuid,boolean) to service_role;
grant execute on function public.deny_slack_channel(text,text,text,text,text) to service_role;
revoke all on function public.list_slack_preview_installations(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_slack_preview_installations(uuid,uuid) to service_role;
