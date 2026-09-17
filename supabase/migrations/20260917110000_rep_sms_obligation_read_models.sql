begin;

-- Keep the obligation boundary complete for provider reconciliation and
-- softphone paths. The two attempt RPC wrappers create an obligation for a
-- browser submission, while reconciliation updates an existing Sandra attempt
-- after provider evidence arrives. This trigger covers that transition and
-- any future authenticated attempt writer without backfilling old rows.
create or replace function public.rep_sms_no_answer_attempt_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.outcome='no_answer'
    and (tg_op='INSERT' or old.outcome is distinct from 'no_answer') then
    perform public.fn_ensure_rep_sms_no_answer_obligation(
      new.org_id,new.property_id,new.assignment_episode_id,new.id,new.actor_user_id,
      new.occurred_at,'{}'::jsonb
    );
  end if;
  return new;
end;
$$;
revoke all on function public.rep_sms_no_answer_attempt_trigger() from public,anon,authenticated,service_role;
drop trigger if exists rep_sms_no_answer_attempt on public.acquisition_attempts;
create trigger rep_sms_no_answer_attempt
  after insert or update of outcome on public.acquisition_attempts
  for each row execute function public.rep_sms_no_answer_attempt_trigger();

-- Return an existing obligation id after a trigger may have created the row.
-- The unique key remains the idempotency fence; the follow-up composition is
-- never overwritten by a racing trigger or duplicate attempt receipt.
create or replace function public.fn_ensure_rep_sms_no_answer_obligation(
  p_org_id uuid,p_property_id uuid,p_episode_id uuid,p_attempt_id uuid,p_actor_id uuid,
  p_occurred_at timestamptz,p_input jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_enrolled boolean; v_sender public.rep_sms_sender_assignments%rowtype;
  v_contact uuid; v_to text; v_state text; v_reason text; v_id uuid; v_existing_state text;
begin
  if p_actor_id is null or p_attempt_id is null then return null; end if;

  select o.id,o.state into v_id,v_existing_state from public.rep_sms_obligations o
    where o.org_id=p_org_id and o.attempt_id=p_attempt_id and o.obligation_kind='no_answer_sms';
  if v_id is not null then
    -- The after-row trigger runs before an attempt RPC wrapper can return, so
    -- a browser-supplied composition may arrive after the trigger's blank
    -- obligation. Merge it only while the row is still claimable; never alter
    -- an already sending or terminal provider result.
    if nullif(btrim(p_input->>'smsBody'),'') is not null
      and v_existing_state in ('required','draft','failed_not_dispatched','blocked') then
      update public.rep_sms_obligations set message_body=nullif(btrim(p_input->>'smsBody'),''),
        composition=case when jsonb_typeof(p_input->'followUp')='object' then p_input->'followUp' else composition end
        where id=v_id;
    end if;
    return v_id;
  end if;

  select e.enabled into v_enrolled from public.rep_sms_rollout_enrollments e
    where e.org_id=p_org_id and e.user_id=p_actor_id;
  if coalesce(v_enrolled,false) is not true then return null; end if;
  select s.* into v_sender from public.rep_sms_sender_assignments s
    where s.org_id=p_org_id and s.user_id=p_actor_id and s.active
      and s.grant_status='active' and s.revoked_at is null
    order by s.is_default desc,s.label,s.id limit 1;
  select p.homeowner_contact_id into v_contact from public.properties p
    where p.id=p_property_id and p.org_id=p_org_id;
  -- Provider routed calls carry the exact destination selected by the dialer.
  -- Prefer that immutable batch snapshot so a later contact-phone edit cannot
  -- redirect a follow-up to a different number. Manual attempts and calls
  -- without a routed item use the current contact phone as a fallback.
  select i.phone_e164 into v_to
    from public.acquisition_attempts aa
    join public.call_activities ca on ca.id=aa.call_activity_id
      and ca.org_id=aa.org_id and ca.property_id=aa.property_id
    join public.dialer_batch_items i on i.id=ca.dialer_batch_item_id
      and i.property_id=aa.property_id
    where aa.id=p_attempt_id and aa.org_id=p_org_id;
  if v_to is null then
    select coalesce(c.phone_1,c.phone_2,c.phone_3) into v_to from public.contacts c
      where c.id=v_contact and c.org_id=p_org_id;
  end if;
  if v_sender.id is null then v_state:='blocked'; v_reason:='sender_grant_missing';
  elsif v_to is null or v_to !~ '^\+[1-9][0-9]{7,14}$' then v_state:='blocked'; v_reason:='recipient_missing';
  else v_state:='required'; v_reason:=null;
  end if;
  insert into public.rep_sms_obligations(
    org_id,property_id,assignment_episode_id,attempt_id,actor_user_id,provider,provider_account_id,sender_assignment_id,
    from_number,to_number,message_body,composition,state,blocked_reason,next_attempt_at
  ) values(
    p_org_id,p_property_id,p_episode_id,p_attempt_id,p_actor_id,v_sender.provider,v_sender.provider_account_id,v_sender.id,
    v_sender.phone_e164,v_to,nullif(btrim(p_input->>'smsBody'),''),
    case when jsonb_typeof(p_input->'followUp')='object' then p_input->'followUp' else '{}'::jsonb end,
    v_state,v_reason,statement_timestamp()
  ) on conflict(org_id,attempt_id,obligation_kind) do nothing returning id into v_id;
  if v_id is null then
    select o.id into v_id from public.rep_sms_obligations o
      where o.org_id=p_org_id and o.attempt_id=p_attempt_id and o.obligation_kind='no_answer_sms';
  end if;
  return v_id;
end;
$$;
revoke all on function public.fn_ensure_rep_sms_no_answer_obligation(uuid,uuid,uuid,uuid,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

-- The latest acquisition metrics migration intentionally stopped inferring a
-- rep outcome from transport telemetry. Provider reconciliation still needs
-- to carry an explicit provider terminal answer into the pending Sandra
-- attempt, however, so the no-answer obligation trigger can observe that
-- transition. Preserve an already selected outcome and never create an
-- attempt from evidence alone.
create or replace function public.my_leads_reconcile_call(p_org uuid,p_jitter_id text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_jitter_id is null or p_jitter_id='' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':acquisition-finalize:'||p_jitter_id,0));
  update public.acquisition_attempts a set
    call_activity_id=c.id,
    outcome=coalesce(a.outcome,case c.outcome
      when 'connected_human' then 'reached'
      when 'no_answer' then 'no_answer'
      when 'voicemail' then 'no_answer'
      when 'busy' then 'no_answer'
    end),
    note=coalesce(a.note,nullif(btrim(c.notes),''))
  from public.acquisition_commands r,public.call_activities c
  where r.org_id=p_org and r.operation='record_call_start'
    and r.result->>'jitterCallId'=p_jitter_id
    and a.command_id=r.id and a.org_id=p_org and a.source='sandra'
    and c.org_id=p_org and c.property_id=a.property_id
    and c.provider='sandra_softphone'
    and c.jitter_attempt_id='sandra-'||p_jitter_id
    and c.operator_user_id=a.actor_user_id
    and c.provider_call_id=r.result->>'sellerProviderCallId'
    and (a.call_activity_id is null or a.call_activity_id=c.id);
end;
$$;
revoke all on function public.my_leads_reconcile_call(uuid,text) from public,anon,authenticated,service_role;

-- The acquisition detail read model is the source used by My Leads. Keep
-- attempt facts one row per attempt while exposing the durable follow-up row
-- that belongs to that attempt. A missing row means this rep was not enrolled
-- when the attempt was recorded, rather than an outstanding requirement.
create or replace function public.my_leads_detail_rows(p_org uuid,p_property uuid,p_group text)
returns table(id uuid,occurred_at timestamptz,fact jsonb)
language sql stable security definer set search_path='' as $$
  select n.id,n.created_at,jsonb_build_object('id',n.id,'actorId',n.author_user_id,'body',n.body,'at',n.created_at)
    from public.lead_notes n where p_group='notes' and n.org_id=p_org and n.property_id=p_property
  union all
  select a.id,a.occurred_at,jsonb_build_object(
      'id',a.id,'actorId',a.actor_user_id,'outcome',a.outcome,'source',a.source,'at',a.occurred_at,
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
  select t.id,t.due_at,jsonb_build_object('id',t.id,'actorId',case when t.type='appointment' then aa.accountable_user_id else t.assignee_id end,'currentAssigneeId',t.assignee_id,'title',t.title,'status',t.status,'outcome',t.outcome,'at',t.due_at,'type',t.type,
      'callbackActionAllowed',t.type='callback' and t.status in ('open','snoozed') and (t.assignee_id=auth.uid() or exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.role='owner')),
      'lifecycleState',case when t.type='appointment' and t.status in ('open','snoozed')
        and (t.assignee_id=auth.uid() or exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid() and m.role='owner'))
        then case when t.due_at<=statement_timestamp() then 'past_due' else 'upcoming' end end)
    from public.tasks t left join public.acquisition_appointment_attribution aa on aa.task_id=t.id and aa.org_id=t.org_id
    where p_group='appointments' and t.org_id=p_org and t.related_property_id=p_property and t.type in ('appointment','callback')
  union all
  select e.id,coalesce(e.assigned_at,e.initialized_at),jsonb_build_object('id',e.id,'actorId',e.assignee_user_id,'at',coalesce(e.assigned_at,e.initialized_at),'endedAt',e.ended_at,'kind',e.episode_kind)
    from public.acquisition_assignment_episodes e where p_group='history' and e.org_id=p_org and e.property_id=p_property;
$$;
revoke all on function public.my_leads_detail_rows(uuid,uuid,text) from public,anon,authenticated,service_role;

-- Lead detail uses a separate canonical history function. It receives the same
-- obligation fields so the lead page can resume an actual required/draft row
-- after reload and can distinguish accepted/delivered from an old no-answer.
create or replace function public.fn_get_lead_acquisition_history(p_property_id uuid, p_limit integer default 50, p_before_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_org uuid; v_rows jsonb; v_more boolean;
begin
 if auth.uid() is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select org_id into v_org from public.properties where id=p_property_id and deleted_at is null;
 if v_org is null or not coalesce(public.hugo_has_active_org_access(v_org),false) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_limit is null or p_limit<1 or p_limit>100 or
   ((p_before_at is null)::int+(p_before_kind is null)::int+(p_before_id is null)::int) not in (0,3) or
   (p_before_at is not null and (not isfinite(p_before_at) or p_before_kind not in ('attempt','offer'))) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 with facts as (
  select a.occurred_at at,'attempt'::text kind,a.id,jsonb_build_object(
    'kind','attempt','id',a.id,'at',a.occurred_at,'actorId',a.actor_user_id,'source',a.source,
    'attemptKind',a.attempt_kind,'outcome',a.outcome,'note',a.note,'recordingUrl',a.recording_url,
    'callActivityId',a.call_activity_id,'followUpObligationId',o.id,'followUpStatus',o.state,
    'followUpMessage',o.message_body,'followUpComposition',o.composition,'followUpBlockedReason',o.blocked_reason
  ) row
  from public.acquisition_attempts a
  left join public.rep_sms_obligations o
    on o.org_id=a.org_id and o.attempt_id=a.id and o.obligation_kind='no_answer_sms'
  where a.org_id=v_org and a.property_id=p_property_id
  union all
  select o.sent_at,'offer',o.id,jsonb_build_object('kind','offer','id',o.id,'at',o.sent_at,'actorId',o.actor_user_id,'amountCents',o.amount_cents::text,'method',o.sent_via,'followUpAt',o.follow_up_at,'outcome',o.outcome,'outcomeAt',o.outcome_at)
  from public.acquisition_offers o where o.org_id=v_org and o.property_id=p_property_id
 ), bounded as (
  select * from facts where p_before_at is null or (at,kind,id)<(p_before_at,p_before_kind,p_before_id)
  order by at desc,kind desc,id desc limit p_limit+1
 ), numbered as (select *,row_number() over(order by at desc,kind desc,id desc) n from bounded)
 select coalesce(jsonb_agg(row order by at desc,kind desc,id desc) filter(where n<=p_limit),'[]'::jsonb),coalesce(bool_or(n>p_limit),false) into v_rows,v_more from numbered;
 return jsonb_build_object('rows',v_rows,'hasMore',v_more,'cursor',case when v_more then jsonb_build_object('at',v_rows->-1->>'at','kind',v_rows->-1->>'kind','id',v_rows->-1->>'id') else null end);
end;
$$;
revoke all on function public.fn_get_lead_acquisition_history(uuid,integer,timestamptz,text,uuid) from public,anon,service_role;
grant execute on function public.fn_get_lead_acquisition_history(uuid,integer,timestamptz,text,uuid) to authenticated;

-- Context carries the exact durable work item when one exists. The client can
-- use this id to resume through the fenced claim/authorize/result path after a
-- reload; it must not fall back to the generic free-form sender for a pending
-- obligation. Only the current actor's queue obligation is offered here.
create or replace function public.fn_get_rep_sms_context(p_property_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_contact uuid; v_enrolled boolean:=false; v_senders jsonb; v_obligation jsonb;
begin
  select p.org_id,p.homeowner_contact_id into v_org,v_contact from public.properties p where p.id=p_property_id;
  if v_org is null or auth.uid() is null then raise exception 'Lead unavailable' using errcode='42501'; end if;
  perform public.my_leads_require_read_scope(v_org,auth.uid());
  if not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=auth.uid()
    and (m.acquisitions_enabled or m.role='owner')) then raise exception 'Acquisitions access required' using errcode='42501'; end if;
  if not exists(select 1 from public.my_leads_queue_rows(v_org,auth.uid(),statement_timestamp()) q where q.property_id=p_property_id) then
    raise exception 'You can text only leads currently in your queue' using errcode='42501';
  end if;
  select coalesce(e.enabled,false) into v_enrolled from public.rep_sms_rollout_enrollments e where e.org_id=v_org and e.user_id=auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.phone_e164,'label',s.label,'isDefault',s.is_default,
    'provider',s.provider,'providerAccountId',s.provider_account_id,'providerSenderId',s.provider_sender_id,
    'compositionPolicyVersion',s.composition_policy_version,'grantStatus',s.grant_status,
    'grantedAt',s.granted_at,'revokedAt',s.revoked_at)
    order by s.is_default desc,s.label,s.id),'[]'::jsonb) into v_senders
    from public.rep_sms_sender_assignments s where v_enrolled and s.org_id=v_org and s.user_id=auth.uid()
      and s.active and s.grant_status='active' and s.revoked_at is null;
  select jsonb_build_object('id',o.id,'attemptId',o.attempt_id,'status',o.state,
      'messageBody',o.message_body,'composition',o.composition,'blockedReason',o.blocked_reason,
      'senderAssignmentId',o.sender_assignment_id,'fromNumber',o.from_number,'toNumber',o.to_number)
    into v_obligation
    from public.rep_sms_obligations o
    where v_enrolled and o.org_id=v_org and o.property_id=p_property_id and o.actor_user_id=auth.uid()
      and o.state in ('required','draft','failed_not_dispatched','blocked','unknown','delivery_failed','claimed','sending')
    order by o.created_at desc,o.id desc limit 1;
  return jsonb_build_object('orgId',v_org,'actorId',auth.uid(),'contactId',v_contact,'enrolled',v_enrolled,
    'senders',v_senders,'obligation',v_obligation);
end;
$$;
revoke all on function public.fn_get_rep_sms_context(uuid) from public,anon;
grant execute on function public.fn_get_rep_sms_context(uuid) to authenticated;

commit;
