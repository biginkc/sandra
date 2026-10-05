-- My Leads one-call close, P1c (1c.1): database support for the post-call prompt.
--
-- Schema and functions only. NO data step: nothing here changes an existing row.
--   1. fn_log_acquisition_attempt_without_sms_obligation: outcome list gains 'voicemail'.
--   2. fn_finalize_acquisition_attempt_without_sms_obligation: outcome list gains 'voicemail'.
--      ('not_logged' stays system-only; the column CHECK admitting both is 20261005110000.)
--      The public wrappers create the no-answer SMS obligation only for outcome='no_answer',
--      so a voicemail attempt is obligation-free with no wrapper change.
--   3. lead_notes.idempotency_key + partial unique index (org_id, idempotency_key) where not null.
--   4. fn_get_acquisition_call_references: also returns callOutcome / talkSeconds / provider
--      from the linked call_activities row (outcome prefill in the prompt).
--   5. my_leads_detail_rows: the attempts fact carries 'note'.
-- Each CREATE OR REPLACE keeps the live body except for the stated diff; grants are preserved.
-- Requires 20261005121000 (my_leads_detail_rows next-step body) and 20261005110000.
begin;

-- 1. log
CREATE OR REPLACE FUNCTION public.fn_log_acquisition_attempt_without_sms_obligation(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid:=auth.uid();
  v_property_id uuid:=(p_input->>'propertyId')::uuid;
  v_key uuid:=(p_input->>'idempotencyKey')::uuid;
  v_expected_episode uuid:=(p_input->>'expectedEpisodeId')::uuid;
  v_version bigint:=(p_input->>'expectedQueueVersion')::bigint;
  v_at timestamptz:=(p_input->>'occurredAt')::timestamptz;
  v_source text:=p_input->>'source';
  v_kind text:=p_input->>'kind';
  v_outcome text:=p_input->>'outcome';
  v_org uuid;v_owner boolean;v_hash text;v_result jsonb;v_attempt_id uuid;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_command uuid:=extensions.gen_random_uuid();
begin
  if v_actor is null or v_property_id is null or v_key is null or v_version is null or v_version<0
    or v_at is null or not isfinite(v_at) or v_at>statement_timestamp()
    or (v_outcome in ('reached','no_answer','wrong_number','voicemail')) is not true
    or ((v_source='dialpad' and v_kind='call') or (v_source='manual' and v_kind='outreach')) is not true then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select org_id into v_org from public.properties where id=v_property_id;
  select m.role='owner' into v_owner from public.memberships m where m.org_id=v_org and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp());
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if nullif(btrim(p_input->>'recordingUrl'),'') is not null and
    (length(p_input->>'recordingUrl')>4096 or (p_input->>'recordingUrl') !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('log_acquisition_attempt',v_org,v_actor,p_input);
  perform pg_advisory_xact_lock(hashtextextended(format('my-leads:%s:%s:%s',v_org,'log_acquisition_attempt',v_key),0));
  select * into v_receipt from public.acquisition_commands where org_id=v_org and operation='log_acquisition_attempt' and idempotency_key=v_key;
  if found then
    if v_receipt.actor_user_id is distinct from v_actor or v_receipt.request_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01';
    end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true'::jsonb);
  end if;
  if not exists(select 1 from public.acquisition_org_settings where org_id=v_org and my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode='42501';
  end if;
  select * into v_property from public.properties where id=v_property_id and org_id=v_org for update;
  if not v_owner and v_property.assigned_user_id is distinct from v_actor then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_property.deleted_at is not null or v_property.is_dnc_locked or v_property.status='dnc' then
    raise exception 'DNC_LOCKED' using errcode='42501';
  end if;
  if v_property.status is distinct from p_input->>'expectedSharedStatus' then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  select * into v_queue from public.acquisition_queue_states where property_id=v_property_id and org_id=v_org for update;
  select * into v_episode from public.acquisition_assignment_episodes where property_id=v_property_id and org_id=v_org and ended_at is null for update;
  if v_episode.id is distinct from v_expected_episode then raise exception 'STALE_ASSIGNMENT' using errcode='MLS01'; end if;
  if coalesce(v_queue.version,0)<>v_version or v_queue.archived_at is not null then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  insert into public.acquisition_commands(id,org_id,actor_user_id,actor_kind,operation,idempotency_key,request_hash,result)
    values(v_command,v_org,v_actor,'user','log_acquisition_attempt',v_key,v_hash,'{}');
  insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,outcome,occurred_at,note,recording_url,idempotency_key,command_id)
    values(v_org,v_property_id,v_episode.id,v_actor,v_kind,v_source,v_outcome,v_at,nullif(btrim(p_input->>'note'),''),nullif(btrim(p_input->>'recordingUrl'),''),v_key,v_command)
    returning id into v_attempt_id;
  if v_kind='call' and v_episode.eligible and v_episode.assignee_user_id=v_actor and v_at>=v_episode.assigned_at then
    update public.acquisition_assignment_episodes set first_call_started_at=v_at,first_call_actor_user_id=v_actor,
      first_call_provider_key='dialpad:'||v_attempt_id::text
      where id=v_episode.id and (first_call_started_at is null or first_call_started_at>v_at);
  end if;
  if v_queue.property_id is null then
    insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version)
      values(v_property_id,v_org,'contacted',v_at,1) returning * into v_queue;
  else
    update public.acquisition_queue_states set version=version+1,updated_at=statement_timestamp()
      where property_id=v_property_id and org_id=v_org returning * into v_queue;
  end if;
  if v_property.status in ('new_lead','prospect') then update public.properties set status='contacted' where id=v_property_id; end if;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_property_id,'attemptId',v_attempt_id,
    'assignmentEpisodeId',v_episode.id,'queueVersion',v_queue.version,'stage',v_queue.stage,'archived',false);
  update public.acquisition_commands set result=v_result where id=v_command;
  return v_result;
end;
$function$;

-- 2. finalize
CREATE OR REPLACE FUNCTION public.fn_finalize_acquisition_attempt_without_sms_obligation(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid:=(p_input->>'orgId')::uuid;
  v_actor uuid:=auth.uid();
  v_key uuid:=(p_input->>'idempotencyKey')::uuid;
  v_activity uuid:=(p_input->>'callActivityId')::uuid;
  v_attempt public.acquisition_attempts%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_hash text;
  v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if v_key is null or v_activity is null or (p_input->>'outcome') is null or (p_input->>'outcome') not in ('reached','no_answer','wrong_number','voicemail') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if nullif(btrim(p_input->>'recordingUrl'),'') is not null and
    (length(p_input->>'recordingUrl')>4096 or (p_input->>'recordingUrl') !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('finalize_acquisition_attempt',v_org,v_actor,p_input);
  perform pg_advisory_xact_lock(hashtextextended(v_org::text||':finalize-command:'||v_key::text,0));
  select * into v_receipt from public.acquisition_commands where org_id=v_org and operation='finalize_acquisition_attempt' and idempotency_key=v_key;
  if found then
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='MLS01'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true');
  end if;
  select * into v_attempt from public.acquisition_attempts where org_id=v_org and call_activity_id=v_activity
    and property_id=(p_input->>'propertyId')::uuid
    and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))
    and actor_user_id=v_actor for update;
  if not found then raise exception 'PROVIDER_EVIDENCE_PENDING' using errcode='42501'; end if;
  if v_attempt.outcome is distinct from p_input->>'outcome' and exists(
    select 1 from public.acquisition_commands r where r.org_id=v_org
      and r.operation='finalize_acquisition_attempt' and r.result->>'attemptId'=v_attempt.id::text
  ) then raise exception 'STALE_STATE' using errcode='MLS01'; end if;
  update public.acquisition_attempts set outcome=p_input->>'outcome',note=coalesce(nullif(btrim(p_input->>'note'),''),note),
    recording_url=coalesce(nullif(btrim(p_input->>'recordingUrl'),''),recording_url) where id=v_attempt.id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_attempt.property_id,'attemptId',v_attempt.id);
  insert into public.acquisition_commands(org_id,actor_kind,actor_user_id,operation,idempotency_key,request_hash,result)
    values(v_org,'user',v_actor,'finalize_acquisition_attempt',v_key,v_hash,v_result);
  return v_result;
end;
$function$;

-- 3. lead note idempotency
alter table public.lead_notes add column idempotency_key uuid;
create unique index idx_lead_notes_org_idempotency
  on public.lead_notes (org_id, idempotency_key)
  where idempotency_key is not null;

-- 4. call references
create or replace function public.fn_get_acquisition_call_references(p_org_id uuid, p_property_id uuid, p_member_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $function$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if not exists(select 1 from public.properties p where p.id=p_property_id and p.org_id=p_org_id
    and p.assigned_user_id=p_member_id and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',a.call_activity_id,'occurredAt',a.occurred_at,
      'callOutcome',c.outcome,'talkSeconds',c.talk_duration_seconds,'provider',c.provider) order by a.occurred_at desc),'[]')
    from (select call_activity_id,occurred_at,org_id from public.acquisition_attempts where org_id=p_org_id and property_id=p_property_id
      and actor_user_id=auth.uid()
      and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))
      and outcome is null and call_activity_id is not null order by occurred_at desc limit 20) a
    left join public.call_activities c on c.id=a.call_activity_id and c.org_id=a.org_id);
end;
$function$;

-- 5. detail attempts fact
create or replace function public.my_leads_detail_rows(p_org uuid,p_property uuid,p_group text)
returns table(id uuid,occurred_at timestamptz,fact jsonb)
language sql stable security definer set search_path='' as $$
  select n.id,n.created_at,jsonb_build_object('id',n.id,'actorId',n.author_user_id,'body',n.body,'at',n.created_at)
    from public.lead_notes n where p_group='notes' and n.org_id=p_org and n.property_id=p_property
  union all
  select a.id,a.occurred_at,jsonb_build_object(
      'id',a.id,'actorId',a.actor_user_id,'outcome',a.outcome,'source',a.source,'at',a.occurred_at,'note',a.note,
      'recordingUrl',a.recording_url,'callActivityId',a.call_activity_id,
      'followUpObligationId',o.id,'followUpStatus',o.state,'followUpMessage',o.message_body,
      'followUpComposition',o.composition,'followUpBlockedReason',o.blocked_reason
    )
    from public.acquisition_attempts a
    left join public.rep_sms_obligations o
      on o.org_id=a.org_id and o.attempt_id=a.id and o.obligation_kind='no_answer_sms'
    where p_group='attempts' and a.org_id=p_org and a.property_id=p_property
  union all
  select o.id,o.sent_at,jsonb_build_object('id',o.id,'actorId',o.actor_user_id,'amountCents',o.amount_cents,'method',o.sent_via,'outcome',o.outcome,'at',o.sent_at)
    from public.acquisition_offers o where p_group='offers' and o.org_id=p_org and o.property_id=p_property
  union all
  select t.id,t.due_at,jsonb_build_object('id',t.id,'actorId',case when t.type='appointment' then aa.accountable_user_id else t.assignee_id end,'currentAssigneeId',t.assignee_id,'title',t.title,'status',t.status,'outcome',t.outcome,'at',t.due_at,'type',t.type,'mode',t.mode,'location',t.location,
      'callbackActionAllowed',t.type='callback' and t.status in ('open','snoozed') and (t.assignee_id=auth.uid() or exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.role='owner')),
      'lifecycleState',case when t.type='appointment' and t.status in ('open','snoozed')
        and (t.assignee_id=auth.uid() or exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.role='owner'))
        then case when t.due_at<=statement_timestamp() then 'past_due' else 'upcoming' end end)
    from public.tasks t left join public.acquisition_appointment_attribution aa on aa.task_id=t.id and aa.org_id=t.org_id
    where p_group='appointments' and t.org_id=p_org and t.related_property_id=p_property and t.next_step_kind = 'appointment'
  union all
  select e.id,coalesce(e.assigned_at,e.initialized_at),jsonb_build_object('id',e.id,'actorId',e.assignee_user_id,'at',coalesce(e.assigned_at,e.initialized_at),'endedAt',e.ended_at,'kind',e.episode_kind)
    from public.acquisition_assignment_episodes e where p_group='history' and e.org_id=p_org and e.property_id=p_property;
$$;

commit;
