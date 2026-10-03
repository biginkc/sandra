-- Slack lead previews foundation. All writes are server-owned; no message body,
-- rendered block, or plaintext credential is stored in this schema.
create extension if not exists pgcrypto;

create table public.slack_installations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  team_id text not null,
  app_id text not null,
  team_name text,
  bot_user_id text not null,
  bot_token_encrypted bytea not null,
  scopes text[] not null default '{}',
  installation_version integer not null default 1 check (installation_version > 0),
  status text not null default 'active' check (status in ('active','revoked')),
  installed_by uuid not null references auth.users(id),
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, team_id, app_id)
);

create index slack_installations_team_idx on public.slack_installations(team_id, app_id, status);
alter table public.slack_installations enable row level security;

create table public.slack_account_links (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.slack_installations(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slack_user_id text not null,
  status text not null default 'active' check (status in ('active','revoked')),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id, user_id),
  unique (installation_id, slack_user_id)
);

create index slack_account_links_user_idx on public.slack_account_links(user_id, org_id, status);
alter table public.slack_account_links enable row level security;

create table public.slack_channel_approvals (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.slack_installations(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel_id text not null,
  sharing_policy_acknowledged boolean not null default false,
  status text not null default 'active' check (status in ('active','revoked')),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id, channel_id)
);

create index slack_channel_approvals_lookup_idx
  on public.slack_channel_approvals(installation_id, channel_id, status);
alter table public.slack_channel_approvals enable row level security;

create table public.slack_oauth_nonces (
  nonce_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  purpose text not null check (purpose = 'slack_installation'),
  return_path text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index slack_oauth_nonces_expiry_idx on public.slack_oauth_nonces(expires_at);
alter table public.slack_oauth_nonces enable row level security;

create table public.slack_event_receipts (
  id uuid primary key default gen_random_uuid(),
  team_id text not null,
  app_id text not null,
  event_id text not null,
  event_type text not null,
  event_time timestamptz,
  channel_id text,
  message_ts text,
  poster_slack_user_id text,
  status text not null default 'accepted' check (status in ('accepted','noop','succeeded','failed','expired','cancelled','revoked')),
  denial_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, event_id)
);

create index slack_event_receipts_retention_idx on public.slack_event_receipts(created_at);
alter table public.slack_event_receipts enable row level security;

create table public.slack_unfurl_jobs (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.slack_event_receipts(id) on delete cascade,
  installation_id uuid references public.slack_installations(id) on delete set null,
  installation_version integer check (installation_version is null or installation_version > 0),
  org_id uuid references public.organizations(id) on delete set null,
  team_id text not null,
  app_id text not null,
  channel_id text not null,
  message_ts text not null,
  poster_slack_user_id text not null,
  event_time timestamptz not null,
  status text not null default 'queued' check (status in ('queued','processing','succeeded','noop','failed','expired','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claim_token uuid,
  last_error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index slack_unfurl_jobs_due_idx
  on public.slack_unfurl_jobs(status, next_attempt_at, lease_expires_at);
create index slack_unfurl_jobs_retention_idx on public.slack_unfurl_jobs(created_at);
alter table public.slack_unfurl_jobs enable row level security;

create table public.slack_unfurl_job_urls (
  job_id uuid not null references public.slack_unfurl_jobs(id) on delete cascade,
  url_key text not null,
  lead_id uuid,
  lookup_status text,
  authorization_status text,
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key (job_id, url_key)
);

alter table public.slack_unfurl_job_urls enable row level security;

create or replace function public.create_slack_oauth_nonce(
  p_nonce_hash text, p_user_id uuid, p_org_id uuid, p_return_path text, p_expires_at timestamptz
) returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.slack_oauth_nonces(nonce_hash,user_id,org_id,purpose,return_path,expires_at)
  values (p_nonce_hash,p_user_id,p_org_id,'slack_installation',p_return_path,p_expires_at);
$$;
create or replace function public.consume_slack_oauth_nonce(
  p_nonce_hash text, p_user_id uuid, p_org_id uuid
) returns boolean language sql security definer set search_path = public, pg_temp as $$
  with consumed as (
    update public.slack_oauth_nonces
       set used_at = now()
     where nonce_hash = p_nonce_hash and user_id = p_user_id and org_id = p_org_id
       and purpose = 'slack_installation' and used_at is null and expires_at > now()
    returning 1
  ) select exists(select 1 from consumed);
$$;

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
  return query select v.id,v.installation_version;
end;
$$;

create or replace function public.get_slack_installation(
  p_org_id uuid, p_team_id text, p_app_id text, p_key text
) returns table(installation_id uuid, org_id uuid, team_id text, app_id text, team_name text, bot_user_id text,
  bot_token text, scopes text[], installation_version integer, status text)
language sql security definer set search_path = public, extensions, pg_temp as $$
  select id,org_id,team_id,app_id,team_name,bot_user_id,
    pgp_sym_decrypt(bot_token_encrypted,p_key),scopes,installation_version,status
  from public.slack_installations where org_id=p_org_id and team_id=p_team_id and app_id=p_app_id;
$$;

create or replace function public.upsert_slack_account_link(
  p_installation_id uuid, p_org_id uuid, p_user_id uuid, p_slack_user_id text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.slack_account_links(installation_id,org_id,user_id,slack_user_id,status,verified_at,revoked_at)
  values(p_installation_id,p_org_id,p_user_id,p_slack_user_id,'active',now(),null)
  on conflict on constraint slack_account_links_installation_id_user_id_key do update set slack_user_id=excluded.slack_user_id,status='active',verified_at=now(),revoked_at=null,updated_at=now()
  returning id into v_id;
  return v_id;
end;
$$;

-- Installation identity and its authenticated Sandra/Slack account binding
-- commit together. A callback that cannot persist both must not leave an
-- apparently live installation without the user link needed for delivery.
create or replace function public.upsert_slack_installation_and_account_link(
  p_org_id uuid, p_team_id text, p_app_id text, p_team_name text, p_bot_user_id text,
  p_bot_token text, p_scopes text[], p_installed_by uuid, p_user_id uuid,
  p_slack_user_id text, p_key text
) returns table(installation_id uuid, installation_version integer, account_link_id uuid)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_installation_id uuid; v_installation_version integer; v_link_id uuid;
begin
  select i.installation_id, i.installation_version into v_installation_id, v_installation_version
    from public.upsert_slack_installation(
      p_org_id, p_team_id, p_app_id, p_team_name, p_bot_user_id,
      p_bot_token, p_scopes, p_installed_by, p_key
    ) i;
  insert into public.slack_account_links(installation_id,org_id,user_id,slack_user_id,status,verified_at,revoked_at)
  values(v_installation_id,p_org_id,p_user_id,p_slack_user_id,'active',now(),null)
  on conflict on constraint slack_account_links_installation_id_user_id_key do update set slack_user_id=excluded.slack_user_id,status='active',verified_at=now(),revoked_at=null,updated_at=now()
  returning id into v_link_id;
  return query select v_installation_id, v_installation_version, v_link_id;
end;
$$;

-- acquisition_attempts intentionally has no service-role table grant. Expose
-- only the two aggregate facts needed by the Slack snapshot, and make the
-- property/org/deleted checks part of the definer-owned query itself.
create or replace function public.get_slack_preview_attempt_facts(
  p_org_id uuid, p_property_id uuid
) returns table(
  latest_attempt_id uuid,
  latest_attempt_occurred_at timestamptz,
  latest_attempt_outcome text,
  reached_call_id uuid,
  reached_call_occurred_at timestamptz
)
language sql security definer set search_path = public, pg_temp as $$
  with scoped_property as (
    select 1
      from public.properties p
     where p.id = p_property_id
       and p.org_id = p_org_id
       and p.deleted_at is null
  ), latest_attempt as (
    select a.id, a.occurred_at, a.outcome
      from public.acquisition_attempts a
     where a.org_id = p_org_id
       and a.property_id = p_property_id
       and exists (select 1 from scoped_property)
     order by a.occurred_at desc, a.id desc
     limit 1
  ), reached_call as (
    select a.id, a.occurred_at
      from public.acquisition_attempts a
     where a.org_id = p_org_id
       and a.property_id = p_property_id
       and a.attempt_kind = 'call'
       and a.outcome = 'reached'
       and exists (select 1 from scoped_property)
     order by a.occurred_at desc, a.id desc
     limit 1
  )
  select la.id, la.occurred_at, la.outcome, rc.id, rc.occurred_at
    from (select 1) anchor
    left join latest_attempt la on true
    left join reached_call rc on true;
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
declare v_receipt public.slack_event_receipts; v_job uuid; v_current_installation_version integer; v_installation_status text; v_terminal boolean := p_denial_code is not null or coalesce(array_length(p_url_keys,1),0)=0;
begin
  -- Serialize accepted enqueue with revocation/reinstall. The job captures
  -- the exact installation generation that Slack delivered the event to;
  -- an event observed before revocation cannot resurrect after reinstall.
  if not v_terminal then
    if p_installation_id is null or p_org_id is null then raise exception 'INSTALLATION_REQUIRED' using errcode='22023'; end if;
    if p_installation_version is null then raise exception 'INSTALLATION_VERSION_REQUIRED' using errcode='22023'; end if;
    select i.installation_version, i.status into v_current_installation_version, v_installation_status
      from public.slack_installations i
     where i.id=p_installation_id and i.org_id=p_org_id and i.team_id=p_team_id and i.app_id=p_app_id
     for update;
    if v_current_installation_version is null or v_installation_status <> 'active' then raise exception 'INSTALLATION_NOT_ACTIVE' using errcode='22023'; end if;
    if v_current_installation_version <> p_installation_version then raise exception 'INSTALLATION_VERSION_MISMATCH' using errcode='22023'; end if;
  end if;
  insert into public.slack_event_receipts(team_id,app_id,event_id,event_type,event_time,channel_id,message_ts,poster_slack_user_id,status,denial_code)
  values(p_team_id,p_app_id,p_event_id,p_event_type,p_event_time,p_channel_id,p_message_ts,p_poster_slack_user_id,case when v_terminal then 'noop' else 'accepted' end,p_denial_code)
  on conflict (team_id,event_id) do nothing returning * into v_receipt;
  if v_receipt.id is null then
    select r.* into v_receipt from public.slack_event_receipts r where r.team_id=p_team_id and r.event_id=p_event_id for update;
    select j.id into v_job from public.slack_unfurl_jobs j where j.receipt_id=v_receipt.id;
    if v_job is not null or v_receipt.status <> 'accepted' or v_terminal then
      return query select true,true,v_job; return;
    end if;
    -- Repair an inconsistent accepted receipt transactionally. A prior
    -- response can never acknowledge an accepted receipt before this job
    -- exists, but this branch makes retries safe after a legacy partial row.
    insert into public.slack_unfurl_jobs(receipt_id,installation_id,installation_version,org_id,team_id,app_id,channel_id,message_ts,poster_slack_user_id,event_time,expires_at)
    values(v_receipt.id,p_installation_id,p_installation_version,p_org_id,p_team_id,p_app_id,p_channel_id,p_message_ts,p_poster_slack_user_id,coalesce(p_event_time,now()),coalesce(p_event_time,now())+interval '15 minutes')
    returning id into v_job;
    insert into public.slack_unfurl_job_urls(job_id,url_key)
    select v_job,u from (select distinct unnest(p_url_keys) u) s where length(u) > 0;
    return query select true,true,v_job; return;
  end if;
  if v_terminal then return query select true,false,null::uuid; return; end if;
  insert into public.slack_unfurl_jobs(receipt_id,installation_id,installation_version,org_id,team_id,app_id,channel_id,message_ts,poster_slack_user_id,event_time,expires_at)
  values(v_receipt.id,p_installation_id,p_installation_version,p_org_id,p_team_id,p_app_id,p_channel_id,p_message_ts,p_poster_slack_user_id,coalesce(p_event_time,now()),coalesce(p_event_time,now())+interval '15 minutes')
  returning id into v_job;
  insert into public.slack_unfurl_job_urls(job_id,url_key)
  select v_job,u from (select distinct unnest(p_url_keys) u) s where length(u) > 0;
  return query select true,false,v_job;
end;
$$;

create or replace function public.claim_slack_unfurl_jobs(
  p_now timestamptz, p_claim_token uuid, p_lease_seconds integer, p_limit integer
) returns setof public.slack_unfurl_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Close work that can no longer be attempted. This also updates the
  -- receipt so an abandoned final-attempt lease cannot remain accepted.
  with closed as (
    update public.slack_unfurl_jobs
       set status=case when expires_at <= p_now then 'expired' else 'failed' end,
           claim_token=null, lease_expires_at=null,
           last_error_code=case when expires_at <= p_now then 'job_expired' else 'max_attempts_exhausted' end,
           updated_at=p_now
     where ((status='processing' and lease_expires_at < p_now) or (status='queued' and (next_attempt_at <= p_now or expires_at <= p_now)))
       and (expires_at <= p_now or attempts >= max_attempts)
    returning receipt_id,status
  )
  update public.slack_event_receipts r
     set status=closed.status, updated_at=p_now
    from closed
   where r.id=closed.receipt_id;

  return query with due as (
    select id from public.slack_unfurl_jobs
    where (status='queued' and next_attempt_at <= p_now)
       or (status='processing' and lease_expires_at < p_now and next_attempt_at <= p_now)
    order by next_attempt_at,created_at,id limit greatest(1,least(p_limit,25)) for update skip locked
  )
  update public.slack_unfurl_jobs j
     set status='processing', claim_token=p_claim_token, lease_expires_at=p_now+make_interval(secs=>p_lease_seconds), attempts=attempts+1, updated_at=p_now
    from due where j.id=due.id and j.attempts < j.max_attempts and j.expires_at > p_now
  returning j.*;
end;
$$;

create or replace function public.release_slack_unfurl_job_claim(
  p_job_id uuid, p_claim_token uuid
) returns boolean language sql security definer set search_path = public, pg_temp as $$
  update public.slack_unfurl_jobs
     set status='queued', claim_token=null, lease_expires_at=null,
         attempts=greatest(attempts-1,0),
         next_attempt_at=now(), updated_at=now()
   where id=p_job_id and status='processing' and claim_token=p_claim_token
  returning true;
$$;

create or replace function public.finish_slack_unfurl_job(
  p_job_id uuid, p_claim_token uuid, p_status text, p_error_code text default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_receipt uuid; v_rows integer;
begin
  update public.slack_unfurl_jobs set status=p_status,claim_token=null,lease_expires_at=null,last_error_code=p_error_code,updated_at=now()
    where id=p_job_id and status='processing' and claim_token=p_claim_token returning receipt_id into v_receipt;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then update public.slack_event_receipts set status=p_status,updated_at=now() where id=v_receipt; end if;
  return v_rows > 0;
end;
$$;

create or replace function public.reschedule_slack_unfurl_job(
  p_job_id uuid, p_claim_token uuid, p_next_attempt_at timestamptz, p_error_code text
) returns boolean language sql security definer set search_path = public, pg_temp as $$
  update public.slack_unfurl_jobs set status=case when attempts>=max_attempts then 'failed' else 'queued' end,
    claim_token=null,lease_expires_at=null,next_attempt_at=p_next_attempt_at,last_error_code=p_error_code,updated_at=now()
    where id=p_job_id and status='processing' and claim_token=p_claim_token returning true;
$$;

create or replace function public.revoke_slack_installation(
  p_team_id text, p_app_id text, p_reason text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.slack_installations set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    where team_id=p_team_id and app_id=p_app_id and status='active';
  get diagnostics v_count = row_count;
  update public.slack_account_links l set status='revoked',revoked_at=now(),updated_at=now()
    from public.slack_installations i where l.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and l.status='active';
  update public.slack_channel_approvals a set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    from public.slack_installations i where a.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and a.status='active';
  with cancelled as (
    update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,updated_at=now()
      from public.slack_installations i where j.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id and j.status in ('queued','processing')
      returning j.receipt_id
  )
  update public.slack_event_receipts r set status='revoked',updated_at=now()
    from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

create or replace function public.revoke_slack_channel_approval(
  p_team_id text, p_app_id text, p_channel_id text, p_reason text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.slack_channel_approvals a set status='revoked',revoked_at=now(),revoked_reason=p_reason,updated_at=now()
    from public.slack_installations i
   where a.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id
     and a.channel_id=p_channel_id and a.status='active';
  get diagnostics v_count = row_count;
  with cancelled as (
    update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,last_error_code=p_reason,updated_at=now()
      from public.slack_installations i
     where j.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id
       and j.channel_id=p_channel_id and j.status in ('queued','processing')
      returning j.receipt_id
  )
  update public.slack_event_receipts r set status='revoked',updated_at=now()
    from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

create or replace function public.revoke_slack_account_links(
  p_team_id text, p_app_id text, p_slack_user_ids text[], p_reason text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.slack_account_links l set status='revoked',revoked_at=now(),updated_at=now()
    from public.slack_installations i
   where l.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id
     and l.slack_user_id = any(coalesce(p_slack_user_ids,'{}')) and l.status='active';
  get diagnostics v_count = row_count;
  with cancelled as (
    update public.slack_unfurl_jobs j set status='cancelled',claim_token=null,lease_expires_at=null,last_error_code=p_reason,updated_at=now()
      from public.slack_account_links l, public.slack_installations i
     where j.installation_id=i.id and l.installation_id=i.id and i.team_id=p_team_id and i.app_id=p_app_id
       and j.poster_slack_user_id=any(coalesce(p_slack_user_ids,'{}')) and j.status in ('queued','processing')
      returning j.receipt_id
  )
  update public.slack_event_receipts r set status='revoked',updated_at=now()
    from cancelled where r.id=cancelled.receipt_id;
  return v_count;
end;
$$;

create or replace function public.cleanup_slack_unfurl_data(p_cutoff timestamptz)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  delete from public.slack_event_receipts where created_at < p_cutoff;
  get diagnostics v_count = row_count;
  delete from public.slack_oauth_nonces where expires_at < now() or created_at < p_cutoff;
  return v_count;
end;
$$;

revoke all on table public.slack_installations, public.slack_account_links,
  public.slack_channel_approvals, public.slack_oauth_nonces,
  public.slack_event_receipts, public.slack_unfurl_jobs,
  public.slack_unfurl_job_urls from public, anon, authenticated;
revoke all on function public.create_slack_oauth_nonce(text,uuid,uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.consume_slack_oauth_nonce(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.upsert_slack_installation(uuid,text,text,text,text,text,text[],uuid,text) from public,anon,authenticated;
revoke all on function public.get_slack_installation(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.upsert_slack_account_link(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.upsert_slack_installation_and_account_link(uuid,text,text,text,text,text,text[],uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.get_slack_preview_attempt_facts(uuid,uuid) from public,anon,authenticated;
revoke all on function public.approve_slack_channel(uuid,uuid,text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.enqueue_slack_unfurl_event(text,text,text,text,timestamptz,uuid,uuid,integer,text,text,text,text[],text) from public,anon,authenticated;
revoke all on function public.claim_slack_unfurl_jobs(timestamptz,uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.release_slack_unfurl_job_claim(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_slack_unfurl_job(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.reschedule_slack_unfurl_job(uuid,uuid,timestamptz,text) from public,anon,authenticated;
revoke all on function public.revoke_slack_installation(text,text,text) from public,anon,authenticated;
revoke all on function public.revoke_slack_channel_approval(text,text,text,text) from public,anon,authenticated;
revoke all on function public.revoke_slack_account_links(text,text,text[],text) from public,anon,authenticated;
revoke all on function public.cleanup_slack_unfurl_data(timestamptz) from public,anon,authenticated;
grant execute on function public.create_slack_oauth_nonce(text,uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.consume_slack_oauth_nonce(text,uuid,uuid) to service_role;
grant execute on function public.upsert_slack_installation(uuid,text,text,text,text,text,text[],uuid,text) to service_role;
grant execute on function public.get_slack_installation(uuid,text,text,text) to service_role;
grant execute on function public.upsert_slack_account_link(uuid,uuid,uuid,text) to service_role;
grant execute on function public.upsert_slack_installation_and_account_link(uuid,text,text,text,text,text,text[],uuid,uuid,text,text) to service_role;
grant execute on function public.get_slack_preview_attempt_facts(uuid,uuid) to service_role;
grant execute on function public.approve_slack_channel(uuid,uuid,text,uuid,boolean) to service_role;
grant execute on function public.enqueue_slack_unfurl_event(text,text,text,text,timestamptz,uuid,uuid,integer,text,text,text,text[],text) to service_role;
grant execute on function public.claim_slack_unfurl_jobs(timestamptz,uuid,integer,integer) to service_role;
grant execute on function public.release_slack_unfurl_job_claim(uuid,uuid) to service_role;
grant execute on function public.finish_slack_unfurl_job(uuid,uuid,text,text) to service_role;
grant execute on function public.reschedule_slack_unfurl_job(uuid,uuid,timestamptz,text) to service_role;
grant execute on function public.revoke_slack_installation(text,text,text) to service_role;
grant execute on function public.revoke_slack_channel_approval(text,text,text,text) to service_role;
grant execute on function public.revoke_slack_account_links(text,text,text[],text) to service_role;
grant execute on function public.cleanup_slack_unfurl_data(timestamptz) to service_role;

-- The worker uses the service role for these narrow operational reads/writes.
-- Keep the grants explicit; RLS bypass alone is not a table privilege.
grant select on public.slack_installations, public.slack_account_links,
  public.slack_channel_approvals, public.memberships to service_role;
grant select, update on public.slack_unfurl_job_urls to service_role;
