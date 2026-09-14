begin;
alter table public.sequence_enrollments add column dialpad_pause_revision bigint not null default 0;
create function public.dialpad_sequence_revision() returns trigger language plpgsql set search_path='' as $$
begin new.dialpad_pause_revision:=old.dialpad_pause_revision+1;return new;end;
$$;
revoke all on function public.dialpad_sequence_revision() from public,anon,authenticated,service_role;
create trigger dialpad_sequence_revision before update on public.sequence_enrollments for each row execute function public.dialpad_sequence_revision();

create table public.dialpad_sequence_pause_controls (
  intent_id uuid primary key references public.dialpad_voice_intents(id) on delete restrict,
  prepared boolean not null default false,
  dispatch_started boolean not null default false,
  released boolean not null default false
);
create table public.dialpad_sequence_pause_ownership (
  intent_id uuid not null references public.dialpad_voice_intents(id) on delete restrict,
  enrollment_id uuid not null references public.sequence_enrollments(id) on delete restrict,
  paused_revision bigint not null,
  original_next_run_at timestamptz,
  primary key(intent_id,enrollment_id)
);
alter table public.dialpad_sequence_pause_controls enable row level security;
alter table public.dialpad_sequence_pause_ownership enable row level security;
revoke all on public.dialpad_sequence_pause_controls,public.dialpad_sequence_pause_ownership from public,anon,authenticated,service_role;

create function public.dialpad_require_start_eligibility(i public.dialpad_voice_intents)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.properties p where p.id=i.property_id and p.org_id=i.org_id
    and p.assigned_user_id=i.actor_user_id and p.deleted_at is null and not coalesce(p.is_dnc_locked,false)
    and p.status::text not in ('dnc','dead','closed') for update;
  if not found or not exists(select 1 from public.acquisition_assignment_episodes e where e.id=i.assignment_episode_id
    and e.org_id=i.org_id and e.property_id=i.property_id and e.assignee_user_id=i.actor_user_id and e.ended_at is null)
    or not exists(select 1 from public.memberships m where m.org_id=i.org_id and m.user_id=i.actor_user_id
      and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'DIALPAD_START_ELIGIBILITY_CHANGED' using errcode='42501';
  end if;
end;
$$;
revoke all on function public.dialpad_require_start_eligibility(public.dialpad_voice_intents) from public,anon,authenticated,service_role;

create function public.fn_prepare_dialpad_sequence_pause(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.dialpad_voice_intents%rowtype; c public.dialpad_sequence_pause_controls%rowtype; n integer; ids uuid[];
begin
  select * into i from public.dialpad_voice_intents where id=p_intent_id for update;
  if not found then raise exception 'DIALPAD_INTENT_MISSING' using errcode='P0002'; end if;
  select * into c from public.dialpad_sequence_pause_controls where intent_id=i.id;
  if c.prepared and not c.released then return jsonb_build_object('paused',(select count(*) from public.dialpad_sequence_pause_ownership where intent_id=i.id)); end if;
  if i.status<>'prepared' or coalesce(c.released,false) then raise exception 'DIALPAD_PREPARE_STATE_CONFLICT' using errcode='23514'; end if;
  perform public.dialpad_require_start_eligibility(i);
  insert into public.dialpad_sequence_pause_controls(intent_id) values(i.id) on conflict do nothing;
  with paused as (
    update public.sequence_enrollments set status='paused',pause_reason='call_in_progress',updated_at=statement_timestamp()
      where org_id=i.org_id and property_id=i.property_id and status='active'
      returning id,sequence_id,dialpad_pause_revision,next_run_at
  ), owned as (
    insert into public.dialpad_sequence_pause_ownership(intent_id,enrollment_id,paused_revision,original_next_run_at)
      select i.id,id,dialpad_pause_revision,next_run_at from paused returning enrollment_id
  ) select count(*)::integer,array_agg(distinct sequence_id) into n,ids from paused;
  update public.dialpad_sequence_pause_controls set prepared=true where intent_id=i.id;
  if n>0 then
    insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
      values(i.org_id,i.property_id,'user',i.actor_user_id,'sequence_paused',jsonb_build_object('count',n,'sequence_ids',ids,'reason','call_in_progress','permanent',false),'dialpad.intent.sequence_pause',i.id);
  end if;
  return jsonb_build_object('paused',n);
end;
$$;

create function public.fn_dispatch_dialpad_intent(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.dialpad_voice_intents%rowtype; c public.dialpad_sequence_pause_controls%rowtype;
begin
  select * into i from public.dialpad_voice_intents where id=p_intent_id for update;
  if not found then raise exception 'DIALPAD_INTENT_MISSING' using errcode='P0002'; end if;
  select * into c from public.dialpad_sequence_pause_controls where intent_id=i.id for update;
  if i.status<>'prepared' or c.prepared is distinct from true or c.dispatch_started or c.released then return jsonb_build_object('dispatched',false); end if;
  perform public.dialpad_require_start_eligibility(i);
  update public.dialpad_sequence_pause_controls set dispatch_started=true where intent_id=i.id;
  update public.dialpad_voice_intents set status='initiation_unconfirmed' where id=i.id;
  return jsonb_build_object('dispatched',true);
end;
$$;

create function public.fn_release_dialpad_start(p_intent_id uuid,p_rejection_http_status integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.dialpad_voice_intents%rowtype; c public.dialpad_sequence_pause_controls%rowtype; n integer:=0; ids uuid[];
begin
  select * into i from public.dialpad_voice_intents where id=p_intent_id for update;
  if not found then raise exception 'DIALPAD_INTENT_MISSING' using errcode='P0002'; end if;
  select * into c from public.dialpad_sequence_pause_controls where intent_id=i.id for update;
  if c.released then return jsonb_build_object('released',true,'resumed',0); end if;
  if i.provider_call_id is not null or i.status not in ('prepared','initiation_unconfirmed')
    or (coalesce(c.dispatch_started,false) and (p_rejection_http_status is null or p_rejection_http_status not in (400,401,403,404,422)))
    or (not coalesce(c.dispatch_started,false) and p_rejection_http_status is not null) then
    raise exception 'DIALPAD_RELEASE_EVIDENCE_REQUIRED' using errcode='23514';
  end if;
  perform 1 from public.properties where id=i.property_id and org_id=i.org_id for update;
  -- A peer call may depend on the same pause; never restore under that call.
  if not exists(select 1 from public.dialpad_voice_intents peer where peer.org_id=i.org_id and peer.property_id=i.property_id and peer.id<>i.id and peer.status in ('prepared','initiation_unconfirmed','linked')) then
    with resumed as (
      update public.sequence_enrollments e set status='active',pause_reason=null,next_run_at=o.original_next_run_at,updated_at=statement_timestamp()
        from public.dialpad_sequence_pause_ownership o where o.intent_id=i.id and o.enrollment_id=e.id
          and e.org_id=i.org_id and e.property_id=i.property_id and e.status='paused' and e.pause_reason='call_in_progress'
          and e.dialpad_pause_revision=o.paused_revision
        returning e.sequence_id
    ) select count(*)::integer,array_agg(distinct sequence_id) into n,ids from resumed;
  end if;
  insert into public.dialpad_sequence_pause_controls(intent_id,released) values(i.id,true)
    on conflict(intent_id) do update set released=true;
  update public.dialpad_voice_intents set status='failed',last_error_code=case when p_rejection_http_status is null then 'start_not_dispatched' else 'http_'||p_rejection_http_status::text end where id=i.id;
  if n>0 then
    insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
      values(i.org_id,i.property_id,'user',i.actor_user_id,'sequence_resumed',jsonb_build_object('count',n,'sequence_ids',ids,'reason','call_in_progress_cleared'),'dialpad.intent.sequence_resume',i.id);
  end if;
  return jsonb_build_object('released',true,'resumed',n);
end;
$$;
revoke all on function public.fn_prepare_dialpad_sequence_pause(uuid),public.fn_dispatch_dialpad_intent(uuid),public.fn_release_dialpad_start(uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_prepare_dialpad_sequence_pause(uuid),public.fn_dispatch_dialpad_intent(uuid),public.fn_release_dialpad_start(uuid,integer) to service_role;
commit;
