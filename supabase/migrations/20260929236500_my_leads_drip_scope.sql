begin;

-- Use the same property/episode/status boundary as my_leads_queue_rows. This
-- returns identifiers only; the application reads drip details through RLS.
create or replace function public.fn_list_my_leads_drip_scope(p_org_id uuid, p_member_id uuid)
returns table(property_id uuid, stage text, in_drip boolean, replied_at timestamptz, search_text text, row_data jsonb)
language plpgsql security definer set search_path = ''
set statement_timeout = '5s' as $$
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  return query
  with owned as (
    select r.property_id as id, r.stage as queue_stage, r.search_text as search_value, r.row_data
    from public.my_leads_queue_rows(p_org_id, p_member_id, statement_timestamp()) r
  ), preferred as (
    select distinct on (e.property_id) e.property_id, e.id, e.status, e.pause_reason
    from public.sequence_enrollments e join owned o on o.id = e.property_id
    where e.org_id = p_org_id and e.status in ('active', 'paused', 'completed')
    -- Migration 20260929236000's one-live-drip partial unique index guarantees
    -- at most one active/paused enrollment per property.
    order by e.property_id,
      case when e.status in ('active', 'paused') then 0 else 1 end,
      e.enrolled_at desc, e.id desc
  ), facts as (
    select o.id, o.queue_stage, o.search_value, o.row_data, (n.status = 'active') as active_drip,
      case when (n.status = 'paused' and n.pause_reason in ('inbound_reply', 'rep_sms_human_takeover'))
        or n.status = 'completed' then (
          select max(reply.created_at) from public.messages reply
          join lateral (
            -- The immediately preceding relevant message must be a drip text
            -- from this enrollment. An earlier inbound consumes that text;
            -- a human outbound ends the pending attribution. AI replies do not.
            select prior.id, prior.direction from public.messages prior
            where prior.org_id = p_org_id and prior.property_id = o.id
              and (prior.created_at, prior.id) < (reply.created_at, reply.id)
              and (prior.direction = 'inbound' or (prior.direction = 'outbound'
                and (prior.metadata->>'generated_by' is distinct from 'ai_responder_v1'
                  or exists (select 1 from public.sequence_step_runs drip_run
                    where drip_run.message_id = prior.id))))
            order by prior.created_at desc, prior.id desc limit 1
          ) prior on prior.direction = 'outbound'
          join public.sequence_step_runs run on run.message_id = prior.id
            and run.enrollment_id = n.id
          where reply.org_id = p_org_id and reply.property_id = o.id
            and reply.direction = 'inbound'
        )
      end as latest_reply
    from owned o join preferred n on n.property_id = o.id
  )
  select f.id, f.queue_stage, f.active_drip,
    case when f.latest_reply is not null and not exists (
      select 1 from public.messages m where m.org_id = p_org_id and m.property_id = f.id
        and m.direction = 'outbound' and m.campaign_id is null
        and m.metadata->>'generated_by' is null and m.created_at > f.latest_reply
        and not exists (select 1 from public.sequence_step_runs r where r.message_id = m.id)
    ) and not exists (
      select 1 from public.acquisition_attempts a where a.org_id = p_org_id and a.property_id = f.id
        and a.recorded_at > f.latest_reply
    ) and not exists (
      select 1 from public.lead_events l where l.org_id = p_org_id and l.property_id = f.id
        and l.actor_type = 'user' and l.created_at > f.latest_reply
        and (l.event_type = 'dispo_set' or (l.event_type = 'my_leads_workflow'
          and l.payload->>'operation' in ('ready_acquisition_offer', 'log_acquisition_offer',
            'record_acquisition_contract', 'decline_acquisition_offer', 'handoff_acquisition_lead',
            'log_acquisition_attempt')))
    ) then f.latest_reply end,
    f.search_value, f.row_data
  from facts f where f.active_drip or f.latest_reply is not null;
end;
$$;
revoke all on function public.fn_list_my_leads_drip_scope(uuid, uuid) from public, anon;
grant execute on function public.fn_list_my_leads_drip_scope(uuid, uuid) to authenticated;

-- Keep the same lock order as acquisition workflow commands. A preflight
-- read cannot authorize a later disposition write after reassignment.
create or replace function public.fn_handoff_acquisition_lead_to_drip(
  p_org_id uuid, p_member_id uuid, p_property_id uuid,
  p_expected_episode_id uuid, p_expected_queue_version bigint,
  p_expected_shared_status text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_queue_exists boolean;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
begin
  if p_member_id is null or p_property_id is null or p_expected_episode_id is null
    or p_expected_queue_version is null or p_expected_queue_version < 0
    or p_expected_shared_status is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_actor <> p_member_id and not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = v_actor
      and m.role = 'owner' and m.access_status = 'active'
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.acquisition_org_settings s
    where s.org_id = p_org_id and s.my_leads_enabled) or not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_member_id
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  v_hash := public.my_leads_command_hash('handoff_acquisition_lead_to_drip',p_org_id,v_actor,
    jsonb_build_object('memberId',p_member_id,'propertyId',p_property_id,
      'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
      'expectedSharedStatus',p_expected_shared_status));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',
    p_org_id,'handoff_acquisition_lead_to_drip',p_idempotency_key),0));
  v_replay := public.my_leads_workflow_replay(p_org_id,'handoff_acquisition_lead_to_drip',
    p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_property from public.properties p
    where p.org_id = p_org_id and p.id = p_property_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.assigned_user_id is distinct from p_member_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001'; end if;
  if v_property.deleted_at is not null or v_property.is_dnc_locked
    or v_property.outreach_dispo in ('dnc','opted_out') then
    raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_property.status is distinct from p_expected_shared_status
    or v_property.status in ('closed','dead','dnc','under_contract') then
    raise exception 'STALE_STATE' using errcode = '40001'; end if;
  select * into v_queue from public.acquisition_queue_states q
    where q.org_id = p_org_id and q.property_id = p_property_id for update;
  v_queue_exists := found;
  if coalesce(v_queue.version,0) is distinct from p_expected_queue_version
    or v_queue.archived_at is not null then
    raise exception 'STALE_STATE' using errcode = '40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e
    where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id
    or v_episode.assignee_user_id is distinct from p_member_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = '40001'; end if;

  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,
    idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','handoff_acquisition_lead_to_drip',
      p_idempotency_key,v_hash,'{}');
  update public.properties set outreach_dispo = 'needs_sequence',follow_up_at = null,
    updated_at = statement_timestamp()
    where org_id = p_org_id and id = p_property_id and assigned_user_id = p_member_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode = '40001'; end if;
  if v_queue_exists then
    update public.acquisition_queue_states q set version = q.version + 1,
      updated_at = statement_timestamp()
      where q.org_id = p_org_id and q.property_id = p_property_id and q.version = p_expected_queue_version;
    if not found then raise exception 'STALE_STATE' using errcode = '40001'; end if;
  else
    insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version)
      values(p_property_id,p_org_id,'contacted',statement_timestamp(),1);
  end if;
  v_result := jsonb_build_object('ok',true,'propertyId',p_property_id,
    'queueVersion',p_expected_queue_version + 1);
  update public.acquisition_commands set result = v_result
    where id = v_command_id and org_id = p_org_id;
  if v_property.outreach_dispo is distinct from 'needs_sequence' then
    insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,
      payload,source_type,source_id)
      values(p_org_id,p_property_id,'user',v_actor,'dispo_set',
        jsonb_build_object('from',v_property.outreach_dispo,'to','needs_sequence'),
        'acquisition_command',v_command_id);
  end if;
  return v_result;
end;
$$;
revoke all on function public.fn_handoff_acquisition_lead_to_drip(uuid,uuid,uuid,uuid,bigint,text,uuid) from public, anon;
grant execute on function public.fn_handoff_acquisition_lead_to_drip(uuid,uuid,uuid,uuid,bigint,text,uuid) to authenticated;
commit;
