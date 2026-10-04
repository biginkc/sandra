-- My Leads one-call close, P1a-core (1a.4): one read definition for the next step.
--
-- Schema/function definitions only. NO data step: nothing here changes an existing row.
-- Three `create or replace` bodies, each copied verbatim from its latest live definition
-- with only the stated diff:
--   1. public.my_leads_queue_rows_for(uuid,uuid,timestamptz,uuid)
--      (latest: 20261003120000_my_leads_queue_row_lookup.sql). The next-step lateral reads
--      `t.next_step_kind = 'appointment'` (was `t.type in ('appointment','callback')`) and
--      selects t.mode; the payload gets `nextStepType` ('appointment' or null) and
--      `nextStepMode`. my_leads_queue_rows(uuid,uuid,timestamptz) delegates and is untouched.
--      Still future-dated only, so a past-due legacy callback is not a next step.
--   2. public.my_leads_detail_rows(uuid,uuid,text)
--      (latest: 20260917110000_rep_sms_obligation_read_models.sql). The appointments group
--      reads `t.next_step_kind = 'appointment'` and exposes `mode` and `location`.
--   3. public.fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)
--      (the renamed original, 20260814210000_appointment_lifecycle_rpcs.sql). The successor
--      INSERT now copies mode and location so rescheduling an in-person appointment does not
--      silently turn it into a phone appointment.
-- Grants are re-asserted exactly as the originals set them. Requires 20261005120000
-- (tasks.mode, tasks.location, tasks.next_step_kind).
begin;

create or replace function public.my_leads_queue_rows_for(p_org uuid,p_member uuid,p_at timestamptz,p_property_id uuid)
returns table(property_id uuid,stage text,assignment_sort timestamptz,warning_rank integer,next_warning_at timestamptz,search_text text,row_data jsonb)
language plpgsql stable security definer set search_path='' set plan_cache_mode='force_custom_plan' as $$
#variable_conflict use_column
begin
  return query
  with facts as (
    select p.id,p.address,p.city,p.state,p.zip,p.status,p.motivation_level,
      concat_ws(' ',c.first_name,c.last_name) as homeowner_name,c.phone_1,c.phone_2,c.phone_3,c.id as contact_id,c.do_not_contact as contact_dnc,
      coalesce(q.stage,'not_contacted') as stage,q.version,q.stage_entered_at,q.motivation_kind,q.motivation_text,
      e.id as episode_id,e.assigned_at,e.initialized_at,e.episode_kind,e.eligible,e.first_call_started_at,
      coalesce(e.assigned_at,e.initialized_at) as assignment_sort,
      case when e.eligible and e.assigned_at is not null and e.first_call_started_at is null and coalesce(q.stage,'not_contacted')<>'under_contract'
        then public.acquisition_working_deadline(e.assigned_at) end as first_due,
      case when q.stage='needs_offer' then q.stage_entered_at+interval '12 hours' end as offer_due,
      step.due_at as next_step_at,step.mode as next_step_mode,
      offer.fact as offer,offer.follow_up_at,
      (select count(*) from public.acquisition_attempts a where a.org_id=p_org and a.property_id=p.id) as attempts_count
    from public.properties p
    join public.acquisition_assignment_episodes e on e.property_id=p.id and e.org_id=p.org_id and e.ended_at is null and e.assignee_user_id=p_member
    left join public.acquisition_queue_states q on q.property_id=p.id and q.org_id=p.org_id
    left join public.contacts c on c.id=p.homeowner_contact_id and c.org_id=p.org_id
    left join lateral (
      select greatest(t.due_at,case when t.status='snoozed' then t.snoozed_until end) as due_at,t.mode
      from public.tasks t where t.org_id=p_org and t.related_property_id=p.id and t.next_step_kind = 'appointment'
        and t.status in ('open','snoozed') and greatest(t.due_at,case when t.status='snoozed' then t.snoozed_until end)>p_at
      order by due_at,t.id limit 1
    ) step on true
    left join lateral (
      select jsonb_build_object('id',o.id,'amountCents',o.amount_cents,'method',o.sent_via,'sentAt',o.sent_at,'followUpAt',o.follow_up_at,'outcome',o.outcome) as fact,
        case when o.outcome='pending' then o.follow_up_at end as follow_up_at
      from public.acquisition_offers o where o.org_id=p_org and o.property_id=p.id order by o.sent_at desc,o.id limit 1
    ) offer on true
    where p.org_id=p_org and p.assigned_user_id=p_member and (p_property_id is null or p.id=p_property_id) and p.deleted_at is null and not p.is_dnc_locked
      and p.status not in ('closed','dead','dnc') and q.archived_at is null
  ), warned as (
    select f.*,array_remove(array[
      case when first_due<=p_at then 'first_call_overdue' end,
      case when stage='contacted' and next_step_at is null then 'missing_next_step' end,
      case when offer_due<=p_at then 'offer_needed_overdue' end,
      case when stage='offer_sent' and follow_up_at<=p_at then 'offer_follow_up_overdue' end
    ],null) as reasons,
    least(case when first_due>p_at then first_due end,case when offer_due>p_at then offer_due end,
      case when stage='offer_sent' and follow_up_at>p_at then follow_up_at end,
      case when stage='contacted' then next_step_at end) as next_at
    from facts f
  )
  select w.id,w.stage,w.assignment_sort,case when cardinality(w.reasons)>0 then 1 else 0 end,w.next_at,
    concat_ws(' ',w.address,w.city,w.state,w.zip,w.homeowner_name,w.phone_1,w.phone_2,w.phone_3),
    jsonb_build_object('propertyId',w.id,'stage',w.stage,'queueVersion',coalesce(w.version,0),'sharedStatus',w.status,
      'assignmentEpisodeId',w.episode_id,'assignedAt',w.assigned_at,'initializedAt',w.initialized_at,'episodeKind',w.episode_kind,
      'clockEligible',w.eligible,'firstCallAt',w.first_call_started_at,'stageEnteredAt',w.stage_entered_at,
      'address',w.address,'city',w.city,'state',w.state,'homeownerName',nullif(w.homeowner_name,''),'phone',w.phone_1,'contactId',w.contact_id,'phones',to_jsonb(array_remove(array[w.phone_1,w.phone_2,w.phone_3],null)),'contactDnc',coalesce(w.contact_dnc,false),
      'temperature',w.motivation_level,'motivationKind',w.motivation_kind,'motivationText',w.motivation_text,
      'warningReasons',to_jsonb(w.reasons),'nextStepAt',w.next_step_at,'nextStepType',case when w.next_step_at is null then null else 'appointment' end,'nextStepMode',w.next_step_mode,
      'offer',w.offer,'attemptsCount',w.attempts_count)
  from warned w;
end;
$$;
revoke all on function public.my_leads_queue_rows_for(uuid,uuid,timestamptz,uuid) from public,anon,authenticated,service_role;

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
revoke all on function public.my_leads_detail_rows(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function public.fn_reschedule_appointment_base_20260816(
  p_task uuid,
  p_new_start timestamptz,
  p_new_end timestamptz,
  p_timezone text,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_task public.tasks;
  v_existing public.tasks;
  v_assignee_tz text;
  v_successor_id uuid;
  v_ledger_id uuid;
begin
  if v_actor is null then
    raise exception 'fn_reschedule_appointment: no authenticated caller' using errcode = '28000';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'fn_reschedule_appointment: task % not found', p_task using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'fn_reschedule_appointment: task % is not an appointment', p_task using errcode = 'P0001';
  end if;

  perform 1
  from public.memberships m
  where m.user_id = v_actor
    and m.org_id = v_task.org_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'fn_reschedule_appointment: caller has no active membership in org %', v_task.org_id
      using errcode = 'P0001';
  end if;

  -- Replay-before-validation (same idiom as fn_book_appointment): a repeat
  -- call with the same key must return the already-created successor even
  -- though the OLD row is now 'completed' (which would otherwise trip the
  -- expected-status check below) and even if the assignee's timezone pref
  -- has since changed.
  if p_idempotency_key is not null then
    select * into v_existing
    from public.tasks
    where org_id = v_task.org_id
      and calendar_chain_id = v_task.calendar_chain_id
      and booking_idempotency_key = p_idempotency_key;

    if found then
      if v_existing.due_at is distinct from p_new_start
         or v_existing.end_at is distinct from p_new_end
      then
        raise exception 'fn_reschedule_appointment: idempotency key reuse with different request'
          using errcode = 'P0001';
      end if;
      return jsonb_build_object(
        'task_id', v_existing.id,
        'old_task_id', v_task.id,
        'calendar_chain_id', v_task.calendar_chain_id,
        'duplicate', true
      );
    end if;
  end if;

  if v_task.status <> 'open' then
    raise exception 'fn_reschedule_appointment: appointment % is not open (status %)', p_task, v_task.status
      using errcode = 'P0001';
  end if;

  perform 1
  from public.task_calendar_mutations
  where calendar_chain_id = v_task.calendar_chain_id
    and phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'fn_reschedule_appointment: calendar sync in progress for this appointment'
      using errcode = 'P0001';
  end if;

  -- Timezone-label contract, same as fn_book_appointment: the assignee is
  -- unchanged by reschedule, so it's validated against THEIR authoritative
  -- pref (not a caller-supplied assignee).
  select uip.timezone
  into v_assignee_tz
  from public.user_integration_prefs uip
  where uip.user_id = v_task.assignee_id
  order by (uip.channel <> 'google_calendar'), uip.channel
  limit 1;
  v_assignee_tz := coalesce(v_assignee_tz, 'America/Chicago');
  if p_timezone is distinct from v_assignee_tz then
    raise exception 'fn_reschedule_appointment: timezone mismatch (assignee is %, got %)', v_assignee_tz, p_timezone
      using errcode = 'P0001';
  end if;

  -- Window validation — same bounds as fn_book_appointment (20260814170000).
  if not isfinite(p_new_start) or not isfinite(p_new_end) then
    raise exception 'fn_reschedule_appointment: start/end must be finite timestamps' using errcode = 'P0001';
  end if;
  if p_new_end <= p_new_start then
    raise exception 'fn_reschedule_appointment: end must be after start' using errcode = 'P0001';
  end if;
  if p_new_end - p_new_start < interval '15 minutes' or p_new_end - p_new_start > interval '24 hours' then
    raise exception 'fn_reschedule_appointment: appointment duration must be between 15 minutes and 24 hours'
      using errcode = 'P0001';
  end if;
  if p_new_start > now() + interval '2 years' or p_new_start < now() - interval '1 hour' then
    raise exception 'fn_reschedule_appointment: start must be within 1 hour in the past and 2 years in the future'
      using errcode = 'P0001';
  end if;

  -- Flag required for THIS statement (cluster d: status/outcome/
  -- completed_*/calendar_generation) — see migration header. The successor
  -- INSERT right after does NOT need it (canonical open state); left ON is
  -- harmless for that statement either way.
  perform set_config('sandra.allow_appointment_time_move', 'on', true);

  update public.tasks
  set status = 'completed',
      outcome = 'rescheduled',
      completed_at = now(),
      completed_by = v_actor,
      calendar_generation = calendar_generation + 1,
      updated_at = now()
  where id = p_task;

  insert into public.tasks (
    org_id, assignee_id, related_property_id, contact_id,
    type, status, title, description,
    due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key, mode, location
  ) values (
    v_task.org_id, v_task.assignee_id, v_task.related_property_id, v_task.contact_id,
    'appointment', 'open', v_task.title, v_task.description,
    p_new_start, p_new_end, v_task.calendar_chain_id, v_actor, p_idempotency_key, v_task.mode, v_task.location
  )
  returning id into v_successor_id;

  -- expected_generation = 0: the successor's OWN generation, fresh off the
  -- default — an entirely different row/generation pair than the old row's
  -- just-bumped value. event_id is the OLD row's event (captured before the
  -- close above changed nothing about that column — it is never touched by
  -- this RPC, only read).
  insert into public.task_calendar_mutations (
    org_id, calendar_chain_id, operation, phase,
    source_task_id, target_task_id, old_assignee_id, event_id, expected_generation
  ) values (
    v_task.org_id, v_task.calendar_chain_id, 'reschedule', 'pending',
    p_task, v_successor_id, v_task.assignee_id, v_task.google_calendar_event_id, 0
  )
  returning id into v_ledger_id;

  return jsonb_build_object(
    'task_id', v_successor_id,
    'old_task_id', p_task,
    'calendar_chain_id', v_task.calendar_chain_id,
    'duplicate', false
  );
end;
$$;

revoke all on function public.fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)
  from public, anon, authenticated;

commit;
