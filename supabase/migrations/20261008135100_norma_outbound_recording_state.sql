-- Master-reserved local preparation identity; revalidate before publication/shared application.
-- Recording work is pulled from committed request identities, never run inside call
-- completion, notification, or dispatch transactions. No media URLs are stored.
begin;
create table public.norma_recording_lookup_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  denied_at timestamptz,
  awaiting_result boolean not null default false,
  lease_id uuid,
  lease_until timestamptz
);
insert into public.norma_recording_lookup_control(singleton) values (true);
create table public.norma_attempt_recordings (
  request_id uuid not null references public.norma_call_requests(id) on delete cascade,
  attempt smallint not null check (attempt in (1,2)),
  provider_call_id text not null unique check (provider_call_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  state text not null default 'pending' check (state in ('pending','reported_available','not_recorded','unavailable','failed')),
  lookup_attempts smallint not null default 0 check (lookup_attempts between 0 and 6),
  next_lookup_at timestamptz not null default now(),
  last_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (request_id,attempt)
);
create index norma_attempt_recordings_pending on public.norma_attempt_recordings(next_lookup_at) where state='pending';
alter table public.norma_attempt_recordings enable row level security;
alter table public.norma_recording_lookup_control enable row level security;
create policy norma_attempt_recordings_read on public.norma_attempt_recordings for select to authenticated
  using (exists (select 1 from public.norma_call_requests r where r.id=norma_attempt_recordings.request_id));
revoke all on public.norma_attempt_recordings,public.norma_recording_lookup_control from public,anon,authenticated;
grant select on public.norma_attempt_recordings to authenticated;
grant all on public.norma_attempt_recordings,public.norma_recording_lookup_control to service_role;

-- JSON projection intentionally supports both legacy and retry-aware request rows.
-- At most 100 new identities per sweep; repeated sweeps never reset durable evidence.
create function public.fn_norma_seed_recordings() returns integer
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  insert into public.norma_attempt_recordings(request_id,attempt,provider_call_id)
  select r.id,c.attempt,c.call_id from public.norma_call_requests r
  cross join lateral (values
    (1::smallint,case when to_jsonb(r)->>'attempt'='2' then to_jsonb(r)->>'first_bland_call_id' else r.bland_call_id end),
    (2::smallint,case when to_jsonb(r)->>'attempt'='2' then r.bland_call_id else null end)
  ) c(attempt,call_id)
  where c.call_id ~ '^[a-zA-Z0-9_-]{1,128}$'
    and not exists(select 1 from public.norma_attempt_recordings a where a.request_id=r.id and a.attempt=c.attempt)
    and not exists(select 1 from public.norma_attempt_recordings a where a.provider_call_id=c.call_id)
  order by r.created_at,r.id,c.attempt limit 100
  on conflict do nothing;
  get diagnostics n=row_count;
  return n;
end $$;

-- One leased batch globally prevents concurrent jobs from continuing after a denial.
-- An unused lease expires after two minutes; an uncertain provider result remains
-- blocked by the write-ahead barrier until explicit operator recovery.
create function public.fn_norma_claim_recordings()
returns table(request_id uuid,attempt smallint,provider_call_id text,phone_e164 text,lookup_attempts smallint,lease_id uuid)
language plpgsql security invoker set search_path='' as $$
declare token uuid; n integer;
begin
  select gen_random_uuid() into token from public.norma_recording_lookup_control c
   where c.singleton and c.enabled and not c.awaiting_result and (c.lease_until is null or c.lease_until<now()) for update skip locked;
  if not found then return; end if;
  perform public.fn_norma_seed_recordings();
  update public.norma_recording_lookup_control set lease_id=token,lease_until=now()+interval '2 minutes' where singleton;
  update public.norma_attempt_recordings a set state='failed',updated_at=now()
    where a.state='pending' and a.lookup_attempts=6 and a.next_lookup_at<=now();
  return query
  with chosen as (
    select a.request_id,a.attempt from public.norma_attempt_recordings a
    where a.state='pending' and a.lookup_attempts<6 and a.next_lookup_at<=now()
    order by a.next_lookup_at,a.request_id,a.attempt limit 5 for update skip locked
  ), claimed as (
    update public.norma_attempt_recordings a
    set lookup_attempts=a.lookup_attempts+1,next_lookup_at=now()+interval '5 minutes'*power(2,a.lookup_attempts),updated_at=now()
    from chosen c where a.request_id=c.request_id and a.attempt=c.attempt returning a.*
  ) select a.request_id,a.attempt,a.provider_call_id,r.phone_e164,a.lookup_attempts,token
    from claimed a join public.norma_call_requests r on r.id=a.request_id;
  get diagnostics n=row_count;
  if n=0 then
    update public.norma_recording_lookup_control c set lease_id=null,lease_until=null where c.singleton and c.lease_id=token;
  end if;
end $$;

-- Write-ahead barrier: an unknown provider result (including a failed denial write)
-- must not lead to an automatic retry after lease expiry. An operator may recover
-- a stranded barrier only after admitting the access/result condition.
create function public.fn_norma_start_recording_lookup(p_lease_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  update public.norma_recording_lookup_control set awaiting_result=true
    where singleton and enabled and not awaiting_result and lease_id=p_lease_id and lease_until>now();
  get diagnostics n=row_count; return n=1;
end $$;

-- Compare-and-set prevents expired workers from overwriting newer reconciliation.
create function public.fn_norma_checkpoint_recording(p_request_id uuid,p_attempt smallint,p_call_id text,p_lookup_attempts smallint,p_lease_id uuid,p_state text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  if p_state not in ('pending','reported_available','not_recorded','unavailable','failed') then raise exception 'Invalid recording state' using errcode='22023'; end if;
  perform 1 from public.norma_recording_lookup_control where singleton and enabled and lease_id=p_lease_id and lease_until>now() for update;
  if not found then return false; end if;
  update public.norma_attempt_recordings set state=p_state,last_checked_at=now(),updated_at=now()
    where request_id=p_request_id and attempt=p_attempt and provider_call_id=p_call_id and lookup_attempts=p_lookup_attempts and state='pending';
  get diagnostics n=row_count;
  if n=1 then
    update public.norma_recording_lookup_control set awaiting_result=false where singleton and lease_id=p_lease_id;
  end if;
  return n=1;
end $$;
create function public.fn_norma_finish_recording_lookup(p_lease_id uuid,p_denied boolean default false)
returns void language sql security invoker set search_path='' as $$
  update public.norma_recording_lookup_control
    set enabled=case when p_denied then false else enabled end,
        denied_at=case when p_denied then now() else denied_at end,
        awaiting_result=case when p_denied then false else awaiting_result end,
        lease_id=case when lease_id=p_lease_id then null else lease_id end,
        lease_until=case when lease_id=p_lease_id then null else lease_until end
    where singleton and (p_denied or lease_id=p_lease_id);
$$;
revoke all on function public.fn_norma_seed_recordings(),public.fn_norma_claim_recordings(),public.fn_norma_start_recording_lookup(uuid),public.fn_norma_checkpoint_recording(uuid,smallint,text,smallint,uuid,text),public.fn_norma_finish_recording_lookup(uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_norma_seed_recordings(),public.fn_norma_claim_recordings(),public.fn_norma_start_recording_lookup(uuid),public.fn_norma_checkpoint_recording(uuid,smallint,text,smallint,uuid,text),public.fn_norma_finish_recording_lookup(uuid,boolean) to service_role;
commit;
