begin;

-- Single-lead My Leads lookup.
--
-- 1. my_leads_queue_rows_for(...) is the ONE copy of the queue projection SQL.
--    It adds an optional property filter that is applied INSIDE the projection
--    (against public.properties, before the episode/task/offer joins), so a
--    single-lead read does not compute the whole queue. It is plpgsql with
--    plan_cache_mode=force_custom_plan: SQL-language functions are planned
--    without parameter values, which would turn `p_property_id is null or
--    p.id = p_property_id` into an unindexable generic filter.
-- 2. my_leads_queue_rows(org,member,at) keeps its exact signature, grants and
--    row shape, and now delegates with a null property filter. Every existing
--    caller (page, KPIs, badge, drip scope, rep SMS, ...) is unchanged.
-- 3. fn_get_my_leads_queue_row(org,member,property) returns the queue row or a
--    reason code. Reasons come from a security-definer read because the
--    episode/queue-state tables are revoked from authenticated.
--
-- Additive only: no data changes.

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
      step.due_at as next_step_at,step.type as next_step_type,
      offer.fact as offer,offer.follow_up_at,
      (select count(*) from public.acquisition_attempts a where a.org_id=p_org and a.property_id=p.id) as attempts_count
    from public.properties p
    join public.acquisition_assignment_episodes e on e.property_id=p.id and e.org_id=p.org_id and e.ended_at is null and e.assignee_user_id=p_member
    left join public.acquisition_queue_states q on q.property_id=p.id and q.org_id=p.org_id
    left join public.contacts c on c.id=p.homeowner_contact_id and c.org_id=p.org_id
    left join lateral (
      select greatest(t.due_at,case when t.status='snoozed' then t.snoozed_until end) as due_at,t.type
      from public.tasks t where t.org_id=p_org and t.related_property_id=p.id and t.type in ('appointment','callback')
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
      'warningReasons',to_jsonb(w.reasons),'nextStepAt',w.next_step_at,'nextStepType',w.next_step_type,
      'offer',w.offer,'attemptsCount',w.attempts_count)
  from warned w;
end;
$$;
revoke all on function public.my_leads_queue_rows_for(uuid,uuid,timestamptz,uuid) from public,anon,authenticated,service_role;

-- Same signature/volatility/security as the original, so create-or-replace
-- keeps the existing revoke. Re-asserted below for clarity.
create or replace function public.my_leads_queue_rows(p_org uuid,p_member uuid,p_at timestamptz)
returns table(property_id uuid,stage text,assignment_sort timestamptz,warning_rank integer,next_warning_at timestamptz,search_text text,row_data jsonb)
language sql stable security definer set search_path='' as $$
  select * from public.my_leads_queue_rows_for(p_org,p_member,p_at,null::uuid);
$$;
revoke all on function public.my_leads_queue_rows(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

-- Reason precedence when the lead is not in the member's queue (first match wins):
--   not_found        no such property in the org, or soft-deleted
--   unassigned       assigned_user_id is null
--   other_rep        assigned to someone other than p_member
--   closed_dead_dnc  status in (closed,dead,dnc) or is_dnc_locked
--   archived         acquisition_queue_states.archived_at is set
--   no_active_episode no open assignment episode for p_member (also the residual
--                    code if the lead changed between the two statements)
-- Only the code is returned; never another rep's identity.
create or replace function public.fn_get_my_leads_queue_row(p_org_id uuid,p_member_id uuid,p_property_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_at timestamptz:=statement_timestamp();
  v_row jsonb;
  v_prop record;
  v_archived boolean;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if p_property_id is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select r.row_data into v_row from public.my_leads_queue_rows_for(p_org_id,p_member_id,v_at,p_property_id) r
    where r.property_id=p_property_id;
  if v_row is not null then
    return jsonb_build_object('status','found','row',v_row,'snapshotAt',v_at);
  end if;
  select p.assigned_user_id,p.status,p.is_dnc_locked into v_prop from public.properties p
    where p.org_id=p_org_id and p.id=p_property_id and p.deleted_at is null;
  if not found then return jsonb_build_object('status','unavailable','reason','not_found'); end if;
  if v_prop.assigned_user_id is null then return jsonb_build_object('status','unavailable','reason','unassigned'); end if;
  if v_prop.assigned_user_id<>p_member_id then return jsonb_build_object('status','unavailable','reason','other_rep'); end if;
  if v_prop.is_dnc_locked or v_prop.status in ('closed','dead','dnc') then
    return jsonb_build_object('status','unavailable','reason','closed_dead_dnc');
  end if;
  select exists(select 1 from public.acquisition_queue_states q where q.org_id=p_org_id and q.property_id=p_property_id and q.archived_at is not null)
    into v_archived;
  if v_archived then return jsonb_build_object('status','unavailable','reason','archived'); end if;
  return jsonb_build_object('status','unavailable','reason','no_active_episode');
end;
$$;
revoke all on function public.fn_get_my_leads_queue_row(uuid,uuid,uuid) from public,anon;
grant execute on function public.fn_get_my_leads_queue_row(uuid,uuid,uuid) to authenticated;

commit;
