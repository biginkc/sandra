-- Additive, inert until an operator configures a destination and dedicated signed webhook.
-- Timestamp is provisional until release-coordinator reservation/hosted-ledger checks.
begin;
create schema if not exists norma_private;
revoke all on schema norma_private from public,anon;
grant usage on schema norma_private to authenticated;
-- Match the shared Messages/Leads workspace restriction, in addition to tenant membership.
create or replace function norma_private.can_access_callbacks(p_org_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and public.hugo_has_active_org_access(p_org_id)
    and (exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.role='owner' and m.access_status='active'
        and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>now()))
      or not exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.role='member' and m.acquisitions_enabled
        and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>now())));
$$;
revoke all on function norma_private.can_access_callbacks(uuid) from public,anon,service_role;
grant execute on function norma_private.can_access_callbacks(uuid) to authenticated;
create table public.norma_inbound_destinations (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  org_id uuid not null references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  recording_lookup_enabled boolean not null default false,
  lookup_denied_at timestamptz
);
alter table public.norma_inbound_destinations enable row level security;
create policy norma_inbound_destinations_service on public.norma_inbound_destinations for all to service_role using (true) with check (true);
revoke all on public.norma_inbound_destinations from public, anon, authenticated;
grant select, insert, update, delete on public.norma_inbound_destinations to service_role;

create table public.norma_inbound_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider_call_id text not null unique check (provider_call_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  from_e164 text not null check (from_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  completed boolean not null default false,
  recording_state text not null default 'pending' check (recording_state in ('pending','reported_available','not_recorded')),
  reconciliation_state text not null default 'pending' check(reconciliation_state in ('pending','done','denied','unavailable')),
  reconciliation_attempts smallint not null default 0 check(reconciliation_attempts between 0 and 6),
  next_lookup_at timestamptz not null default now(),
  -- A phone match is evidence for a human, never authority to select a property.
  review_state text not null default 'needs_review' check (review_state in ('needs_review','associated')),
  property_id uuid,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (property_id, org_id) references public.properties(id, org_id) on delete set null (property_id),
  check ((review_state = 'needs_review' and property_id is null and reviewed_at is null)
      or (review_state = 'associated' and reviewed_at is not null))
);
create index norma_inbound_calls_org_review_idx on public.norma_inbound_calls(org_id, review_state, created_at desc);
alter table public.norma_inbound_calls enable row level security;
create policy norma_inbound_calls_service on public.norma_inbound_calls for all to service_role using (true) with check (true);
create policy norma_inbound_calls_read on public.norma_inbound_calls for select to authenticated
  using (norma_private.can_access_callbacks(org_id));
revoke all on public.norma_inbound_calls from public, anon, authenticated;
grant select on public.norma_inbound_calls to authenticated;
grant select, insert, update on public.norma_inbound_calls to service_role;

-- Service-only ingestion resolves the tenant from a configured destination, never payload metadata.
-- Invoker rights and explicit grants preserve the service boundary without a definer bypass.
create function public.fn_norma_ingest_inbound_call(
  p_call_id text, p_from text, p_to text, p_completed boolean, p_recording_state text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  if p_call_id is null or p_call_id !~ '^[a-zA-Z0-9_-]{1,128}$'
     or p_from is null or p_from !~ '^\+[1-9][0-9]{7,14}$'
     or p_to is null or p_to !~ '^\+[1-9][0-9]{7,14}$'
     or p_completed is null or p_recording_state is null
     or p_recording_state not in ('pending','reported_available','not_recorded') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select org_id into v_org from public.norma_inbound_destinations where phone_e164=p_to and enabled for share;
  if v_org is null then return null; end if;
  insert into public.norma_inbound_calls(org_id,provider_call_id,from_e164,to_e164,completed,recording_state,reconciliation_state)
    values(v_org,p_call_id,p_from,p_to,p_completed,p_recording_state,case when p_recording_state='pending' then 'pending' else 'done' end)
  on conflict(provider_call_id) do update set
    completed = norma_inbound_calls.completed or excluded.completed,
    recording_state = case
      when norma_inbound_calls.recording_state='reported_available' or excluded.recording_state='reported_available' then 'reported_available'
      when norma_inbound_calls.recording_state='not_recorded' or excluded.recording_state='not_recorded' then 'not_recorded'
      else 'pending' end,
    reconciliation_state = case when excluded.recording_state in ('reported_available','not_recorded') then 'done' else norma_inbound_calls.reconciliation_state end,
    updated_at = now()
  where norma_inbound_calls.org_id=excluded.org_id
    and norma_inbound_calls.from_e164=excluded.from_e164 and norma_inbound_calls.to_e164=excluded.to_e164
  returning id into v_id;
  if v_id is null then raise exception 'CALL_IDENTITY_CONFLICT' using errcode='23514'; end if;
  return v_id;
end $$;
revoke all on function public.fn_norma_ingest_inbound_call(text,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_norma_ingest_inbound_call(text,text,text,boolean,text) to service_role;
-- Serialize inbound provider work and retain uncertain results across lease expiry.
-- Destination flags remain the activation control; denial recovery also requires
-- explicitly clearing denied_at after the access condition has been resolved.
create table public.norma_inbound_lookup_control (
  singleton boolean primary key default true check (singleton),
  denied_at timestamptz,
  awaiting_result boolean not null default false,
  lease_id uuid,
  lease_until timestamptz
);
insert into public.norma_inbound_lookup_control(singleton) values(true);
alter table public.norma_inbound_lookup_control enable row level security;
revoke all on public.norma_inbound_lookup_control from public,anon,authenticated;
grant all on public.norma_inbound_lookup_control to service_role;
create function public.fn_norma_claim_inbound_recordings()
returns table(id uuid,provider_call_id text,from_e164 text,to_e164 text,reconciliation_attempts smallint,lease_id uuid)
language plpgsql security invoker set search_path='' as $$
declare token uuid; n integer;
begin
  select gen_random_uuid() into token from public.norma_inbound_lookup_control c
    where c.singleton and c.denied_at is null and not c.awaiting_result
      and (c.lease_until is null or c.lease_until<now()) for update skip locked;
  if not found then return; end if;
  update public.norma_inbound_lookup_control set lease_id=token,lease_until=now()+interval '2 minutes' where singleton;
  update public.norma_inbound_calls c set reconciliation_state='unavailable'
    where c.reconciliation_state='pending' and c.reconciliation_attempts>=6 and c.next_lookup_at<=now();
  return query
  with eligible as (
    select c.id from public.norma_inbound_calls c
    where exists(select 1 from public.norma_inbound_destinations d where d.phone_e164=c.to_e164 and d.org_id=c.org_id and d.enabled and d.recording_lookup_enabled)
      and c.reconciliation_state='pending' and c.recording_state='pending' and c.next_lookup_at<=now()
      and c.reconciliation_attempts<6
    order by c.next_lookup_at,c.id for update skip locked limit 5
  ), claimed as (
    update public.norma_inbound_calls c set reconciliation_attempts=c.reconciliation_attempts+1,
      next_lookup_at=now()+make_interval(mins => (5*power(2,c.reconciliation_attempts))::integer)
    from eligible e where c.id=e.id returning c.*
  ) select c.id,c.provider_call_id,c.from_e164,c.to_e164,c.reconciliation_attempts::smallint,token from claimed c;
  get diagnostics n=row_count;
  if n=0 then
    update public.norma_inbound_lookup_control c set lease_id=null,lease_until=null where c.singleton and c.lease_id=token;
  end if;
end $$;
-- Commit this barrier before the network request. A failed checkpoint/denial write
-- blocks all new batches, even after lease expiry, until admitted operator recovery.
create function public.fn_norma_start_inbound_lookup(p_lease_id uuid,p_call_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  update public.norma_inbound_lookup_control ctl set awaiting_result=true
    where ctl.singleton and ctl.denied_at is null and not ctl.awaiting_result
      and ctl.lease_id=p_lease_id and ctl.lease_until>now()
      and exists(select 1 from public.norma_inbound_calls c join public.norma_inbound_destinations d
        on d.phone_e164=c.to_e164 and d.org_id=c.org_id
        where c.id=p_call_id and c.recording_state='pending' and c.reconciliation_state='pending'
          and d.enabled and d.recording_lookup_enabled);
  get diagnostics n=row_count; return n=1;
end $$;
create function public.fn_norma_checkpoint_inbound_lookup(p_call_id uuid,p_attempts smallint,p_lease_id uuid,p_state text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_state not in ('pending','done','unavailable') then raise exception 'Invalid inbound state' using errcode='22023'; end if;
  perform 1 from public.norma_inbound_lookup_control c where c.singleton and c.denied_at is null
    and c.lease_id=p_lease_id and c.lease_until>now() and c.awaiting_result for update;
  if not found then return false; end if;
  perform 1 from public.norma_inbound_calls c where c.id=p_call_id and c.reconciliation_attempts=p_attempts for update;
  if not found then return false; end if;
  -- A signed webhook may have won while the lookup was in flight. Its evidence
  -- stays terminal, but this known result can still safely clear our barrier.
  update public.norma_inbound_calls set reconciliation_state=p_state
    where id=p_call_id and reconciliation_attempts=p_attempts and recording_state='pending';
  update public.norma_inbound_lookup_control set awaiting_result=false where singleton and lease_id=p_lease_id;
  return true;
end $$;
create function public.fn_norma_pause_inbound_lookups() returns void language plpgsql security invoker set search_path='' as $$
begin
  update public.norma_inbound_lookup_control set denied_at=now() where singleton;
  update public.norma_inbound_destinations set recording_lookup_enabled=false,lookup_denied_at=now();
end $$;
create function public.fn_norma_finish_inbound_lookup(p_lease_id uuid,p_denied boolean default false)
returns void language plpgsql security invoker set search_path='' as $$
begin
  -- Denial is global even if the reporting worker's lease has become stale.
  if p_denied then perform public.fn_norma_pause_inbound_lookups(); end if;
  update public.norma_inbound_lookup_control
    set lease_id=null,lease_until=null,
        awaiting_result=case when p_denied then false else awaiting_result end
    where singleton and lease_id=p_lease_id;
end $$;
revoke all on function public.fn_norma_claim_inbound_recordings(),public.fn_norma_start_inbound_lookup(uuid,uuid),public.fn_norma_checkpoint_inbound_lookup(uuid,smallint,uuid,text),public.fn_norma_pause_inbound_lookups(),public.fn_norma_finish_inbound_lookup(uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_norma_claim_inbound_recordings(),public.fn_norma_start_inbound_lookup(uuid,uuid),public.fn_norma_checkpoint_inbound_lookup(uuid,smallint,uuid,text),public.fn_norma_pause_inbound_lookups(),public.fn_norma_finish_inbound_lookup(uuid,boolean) to service_role;

-- Association is an explicit authenticated action. Preserve each decision in an append-only audit.
create table public.norma_inbound_reviews (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.norma_inbound_calls(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid,
  property_id_snapshot uuid not null,
  reviewer_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(property_id,org_id) references public.properties(id,org_id) on delete set null (property_id)
);
alter table public.norma_inbound_reviews enable row level security;
create policy norma_inbound_reviews_read on public.norma_inbound_reviews for select to authenticated using(norma_private.can_access_callbacks(org_id));
revoke all on public.norma_inbound_reviews from public,anon,authenticated,service_role;
grant select on public.norma_inbound_reviews to authenticated,service_role;

create schema if not exists norma_private;
revoke all on schema norma_private from public,anon;
grant usage on schema norma_private to authenticated;
create function norma_private.associate_inbound_call(p_call_id uuid,p_property_id uuid,p_expected_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.norma_inbound_calls%rowtype; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'UNAUTHORIZED' using errcode='42501'; end if;
  select * into r from public.norma_inbound_calls where id=p_call_id and norma_private.can_access_callbacks(org_id);
  if not found then raise exception 'NOT_FOUND' using errcode='42501'; end if;
  -- Property before call: matches merge/delete lock order and prevents an association/merge deadlock.
  perform 1 from public.properties where id=p_property_id and org_id=r.org_id and deleted_at is null for key share;
  if not found then raise exception 'INVALID_PROPERTY' using errcode='22023'; end if;
  select * into r from public.norma_inbound_calls where id=p_call_id and norma_private.can_access_callbacks(org_id) for update;
  if not found then raise exception 'NOT_FOUND' using errcode='42501'; end if;
  if r.property_id=p_property_id then return r.id; end if;
  if r.review_state<>'needs_review' then raise exception 'ALREADY_ASSOCIATED' using errcode='22023'; end if;
  if p_expected_updated_at is null or r.updated_at<>p_expected_updated_at then raise exception 'STALE_CALL' using errcode='40001'; end if;
  if not exists(select 1 from public.properties where id=p_property_id and org_id=r.org_id and deleted_at is null) then
    raise exception 'INVALID_PROPERTY' using errcode='22023';
  end if;
  insert into public.norma_inbound_reviews(call_id,org_id,property_id,property_id_snapshot,reviewer_id) values(r.id,r.org_id,p_property_id,p_property_id,v_user);
  update public.norma_inbound_calls set property_id=p_property_id,review_state='associated',reviewed_by=v_user,reviewed_at=now(),updated_at=now() where id=r.id;
  return r.id;
end $$;
revoke all on function norma_private.associate_inbound_call(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function norma_private.associate_inbound_call(uuid,uuid,timestamptz) to authenticated;
create function public.fn_norma_associate_inbound_call(p_call_id uuid,p_property_id uuid,p_expected_updated_at timestamptz)
returns uuid language sql security invoker set search_path='' as $$
  select norma_private.associate_inbound_call(p_call_id,p_property_id,p_expected_updated_at);
$$;
revoke all on function public.fn_norma_associate_inbound_call(uuid,uuid,timestamptz) from public,anon,service_role;
grant execute on function public.fn_norma_associate_inbound_call(uuid,uuid,timestamptz) to authenticated;
-- Extend the existing authorized merge function; preserve its current locks, guards and other repoints.
create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select property.org_id into v_keeper_org_id
  from public.properties property where property.id = keeper_id;
  select property.org_id into v_loser_org_id
  from public.properties property where property.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  -- Deterministic locking makes a concurrent save either complete before the
  -- merge or fail cleanly before the loser is removed.
  perform 1
  from public.properties property
  where property.id in (keeper_id, loser_id)
  order by property.id
  for update;

  update public.norma_inbound_calls set property_id=keeper_id,updated_at=now()
    where property_id=loser_id and org_id=v_keeper_org_id;
  update public.norma_inbound_reviews set property_id=keeper_id
    where property_id=loser_id and org_id=v_keeper_org_id;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.esign_requests
  set property_id = keeper_id,
      updated_at = now()
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.lead_files
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  perform set_config('offer_calculations.merge_repoint', 'true', true);
  set constraints offer_calculations_parent_org_property_series_fkey deferred;
  update public.offer_calculations
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  -- The trigger marker is transaction-local and only covers the repoint above.
  -- Clear it before invoking the private merge body so no later maintenance
  -- statement can accidentally inherit calculator write authority.
  perform set_config('offer_calculations.merge_repoint', '', true);

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;
commit;
