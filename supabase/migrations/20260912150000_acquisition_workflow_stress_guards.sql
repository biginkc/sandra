-- My Leads workflow guards found during the desktop stress campaign.
-- These changes keep chronology and fresh Not contacted handoffs atomic at the
-- database boundary; the browser is not the security or consistency boundary.

begin;

create or replace function public.fn_decline_acquisition_offer(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_offer_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_offer public.acquisition_offers%rowtype;
  v_settings public.acquisition_org_settings%rowtype;
  v_role text;
  v_version bigint;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null
     or p_expected_queue_version < 0 or p_expected_shared_status is null
     or p_idempotency_key is null or p_offer_id is null or p_occurred_at is null
     or not isfinite(p_occurred_at) or p_occurred_at > statement_timestamp() then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash := public.my_leads_command_hash('decline_acquisition_offer',p_org_id,v_actor,jsonb_build_object(
    'propertyId',p_property_id,'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
    'expectedSharedStatus',p_expected_shared_status,'offerId',p_offer_id,'occurredAt',p_occurred_at));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',p_org_id,'decline_acquisition_offer',p_idempotency_key),0));
  v_replay := public.my_leads_workflow_replay(p_org_id,'decline_acquisition_offer',p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.acquisition_org_settings s where s.org_id=p_org_id and s.my_leads_enabled) then raise exception 'FEATURE_DISABLED' using errcode='42501'; end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo='dnc' then raise exception 'DNC_LOCKED' using errcode='42501'; end if;
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if v_property.status in ('closed','dead','under_contract','offer_declined') then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  if not found then raise exception 'STALE_STATE' using errcode='40001'; end if;
  v_version:=coalesce(v_queue.version,0);
  if v_version<>p_expected_queue_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_offer from public.acquisition_offers o where o.id=p_offer_id and o.org_id=p_org_id and o.property_id=p_property_id for update;
  if not found or v_offer.assignment_episode_id is distinct from v_episode.id or v_offer.outcome<>'pending' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  if p_occurred_at < v_offer.sent_at then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_settings from public.acquisition_org_settings s where s.org_id=p_org_id;
  if not found or v_settings.needs_sequence_owner_id is null or not exists (
    select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=v_settings.needs_sequence_owner_id and m.access_status='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
  ) then raise exception 'RECIPIENT_UNAVAILABLE' using errcode='22023'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','decline_acquisition_offer',p_idempotency_key,v_hash,'{}');
  update public.acquisition_offers set outcome='declined',outcome_at=p_occurred_at,outcome_by=v_actor,updated_at=statement_timestamp()
    where id=p_offer_id and org_id=p_org_id and property_id=p_property_id;
  update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='needs_sequence_handoff',version=q.version+1,updated_at=statement_timestamp()
    where q.org_id=p_org_id and q.property_id=p_property_id;
  perform set_config('my_leads.handoff_property_id',format('%s:%s',p_property_id,v_command_id),true);
  update public.properties set status='offer_declined',outreach_dispo='needs_sequence',assigned_user_id=v_settings.needs_sequence_owner_id,updated_at=statement_timestamp()
    where id=p_property_id and org_id=p_org_id and assigned_user_id is not distinct from v_property.assigned_user_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',v_queue.stage,'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'decline_acquisition_offer',jsonb_build_object('status','offer_declined','disposition','needs_sequence','recipientUserId',v_settings.needs_sequence_owner_id));
  return v_result;
end;
$$;

create or replace function public.fn_handoff_acquisition_lead(
  p_org_id uuid,
  p_property_id uuid,
  p_expected_episode_id uuid,
  p_expected_queue_version bigint,
  p_expected_shared_status text,
  p_idempotency_key uuid,
  p_reason text,
  p_recipient_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_settings public.acquisition_org_settings%rowtype;
  v_role text;
  v_version bigint;
  v_queue_exists boolean;
begin
  if p_property_id is null or p_expected_episode_id is null or p_expected_queue_version is null or p_expected_queue_version<0
     or p_expected_shared_status is null or p_idempotency_key is null or p_reason not in ('not_interested','needs_nurture') or p_recipient_user_id is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('handoff_acquisition_lead',p_org_id,v_actor,jsonb_build_object(
    'propertyId',p_property_id,'expectedEpisodeId',p_expected_episode_id,'expectedQueueVersion',p_expected_queue_version,
    'expectedSharedStatus',p_expected_shared_status,'reason',p_reason,'recipientUserId',p_recipient_user_id));
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',p_org_id,'handoff_acquisition_lead',p_idempotency_key),0));
  v_replay:=public.my_leads_workflow_replay(p_org_id,'handoff_acquisition_lead',p_idempotency_key,v_actor,v_hash);
  if v_replay is not null then return v_replay; end if;
  if not exists(select 1 from public.acquisition_org_settings s where s.org_id=p_org_id and s.my_leads_enabled) then raise exception 'FEATURE_DISABLED' using errcode='42501'; end if;
  select * into v_property from public.properties p where p.id=p_property_id and p.org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo='dnc' then raise exception 'DNC_LOCKED' using errcode='42501'; end if;
  if v_property.status is distinct from p_expected_shared_status then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select m.role into v_role from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor and m.access_status='active'
    and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_role<>'owner' and v_property.assigned_user_id is distinct from v_actor then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  if v_property.status in ('closed','dead','under_contract') then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_queue from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id for update;
  v_queue_exists := found;
  v_version:=coalesce(v_queue.version,0);
  if not v_queue_exists and p_expected_queue_version <> 0 then raise exception 'STALE_STATE' using errcode='40001'; end if;
  if v_queue_exists and (v_version<>p_expected_queue_version or v_queue.archived_at is not null) then raise exception 'STALE_STATE' using errcode='40001'; end if;
  select * into v_episode from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.property_id=p_property_id and e.ended_at is null for update;
  if not found or v_episode.id is distinct from p_expected_episode_id then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  select * into v_settings from public.acquisition_org_settings s where s.org_id=p_org_id;
  if not found or v_settings.needs_sequence_owner_id is distinct from p_recipient_user_id or not exists(
    select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_recipient_user_id and m.access_status='active'
      and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
  ) then raise exception 'RECIPIENT_UNAVAILABLE' using errcode='22023'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command_id,p_org_id,v_actor,'user','handoff_acquisition_lead',p_idempotency_key,v_hash,'{}');
  if v_queue_exists then
    update public.acquisition_queue_states q set archived_at=statement_timestamp(),archived_by=v_actor,archive_reason='needs_sequence_handoff',version=q.version+1,updated_at=statement_timestamp()
      where q.org_id=p_org_id and q.property_id=p_property_id;
  else
    -- Not contacted is implicit in the read model, but the assignment observer
    -- needs an archived sentinel to prove that this handoff is intentional.
    insert into public.acquisition_queue_states (
      property_id, org_id, stage, stage_entered_at, archived_at, archived_by,
      archive_reason, version
    ) values (
      p_property_id, p_org_id, 'contacted', coalesce(v_episode.assigned_at, statement_timestamp()),
      statement_timestamp(), v_actor, 'needs_sequence_handoff', 1
    );
  end if;
  perform set_config('my_leads.handoff_property_id',format('%s:%s',p_property_id,v_command_id),true);
  update public.properties set outreach_dispo='needs_sequence',assigned_user_id=p_recipient_user_id,updated_at=statement_timestamp()
    where id=p_property_id and org_id=p_org_id and assigned_user_id is not distinct from v_property.assigned_user_id;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode='40001'; end if;
  perform set_config('my_leads.handoff_property_id','',true);
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',p_property_id,'queueVersion',v_version+1,'stage',coalesce(v_queue.stage,'not_contacted'),'archived',true,'assignmentEpisodeId',v_episode.id);
  update public.acquisition_commands set result=v_result where id=v_command_id and org_id=p_org_id;
  perform public.my_leads_workflow_append_event(p_org_id,p_property_id,v_actor,v_command_id,'handoff_acquisition_lead',jsonb_build_object('disposition','needs_sequence','reason',p_reason,'recipientUserId',p_recipient_user_id));
  return v_result;
end;
$$;

commit;
