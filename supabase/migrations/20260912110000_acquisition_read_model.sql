begin;
create table public.acquisition_query_cursors (
  token uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  viewer_id uuid not null,
  member_id uuid not null,
  stage text not null,
  search text not null,
  snapshot_at timestamptz not null,
  expires_at timestamptz not null,
  warning_rank integer not null,
  assignment_sort timestamptz not null,
  property_id uuid not null
);
create index acquisition_query_cursors_expiry_idx on public.acquisition_query_cursors(expires_at);
alter table public.acquisition_query_cursors enable row level security;
revoke all on public.acquisition_query_cursors from public,anon,authenticated,service_role;

create or replace function public.my_leads_require_read_scope(p_org uuid,p_member uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
    and (m.user_id=p_member or m.role='owner')) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not exists(select 1 from public.acquisition_org_settings where org_id=p_org and my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode='42501';
  end if;
  if not exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=p_member
    and (p_member=auth.uid() or m.acquisitions_enabled or exists(select 1 from public.acquisition_assignment_episodes e
      where e.org_id=p_org and e.assignee_user_id=p_member and (e.eligible or e.episode_kind='launch')))) then
    raise exception 'NOT_FOUND' using errcode='P0002';
  end if;
end;
$$;
revoke all on function public.my_leads_require_read_scope(uuid,uuid) from public,anon,authenticated,service_role;

-- Internal row projection. Wrapper RPCs alone may call this function.
create or replace function public.my_leads_queue_rows(p_org uuid,p_member uuid,p_at timestamptz)
returns table(property_id uuid,stage text,assignment_sort timestamptz,warning_rank integer,next_warning_at timestamptz,search_text text,row_data jsonb)
language sql stable security definer set search_path='' as $$
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
    where p.org_id=p_org and p.assigned_user_id=p_member and p.deleted_at is null and not p.is_dnc_locked
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
$$;
revoke all on function public.my_leads_queue_rows(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.fn_get_acquisition_queue_page(
  p_org_id uuid,p_member_id uuid,p_search text default '',p_stage text default null,p_cursor uuid default null,p_limit integer default 20
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_at timestamptz:=statement_timestamp();
  v_search text:=lower(btrim(coalesce(p_search,'')));
  v_limit integer:=least(50,greatest(1,coalesce(p_limit,20)));
  v_cursor public.acquisition_query_cursors%rowtype;
  v_stage text;
  v_pages jsonb:='{}';
  v_rows jsonb;
  v_count bigint;
  v_all bigint;
  v_next uuid;
  v_last record;
  v_next_warning timestamptz;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if length(v_search)>200 or (p_stage is not null and p_stage not in ('not_contacted','contacted','needs_offer','offer_sent','under_contract')) then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.acquisition_query_cursors where token=p_cursor;
    if not found or v_cursor.org_id<>p_org_id or v_cursor.viewer_id<>auth.uid() or v_cursor.member_id<>p_member_id
      or v_cursor.stage is distinct from p_stage or v_cursor.search<>v_search or v_cursor.expires_at<=v_at then
      raise exception 'CURSOR_EXPIRED' using errcode='22023';
    end if;
    v_at:=v_cursor.snapshot_at;
  end if;
  delete from public.acquisition_query_cursors where token in (
    select token from public.acquisition_query_cursors where expires_at<statement_timestamp() order by expires_at limit 100
  );
  foreach v_stage in array case when p_stage is null then array['not_contacted','contacted','needs_offer','offer_sent','under_contract'] else array[p_stage] end loop
    select count(*),count(*) filter(where position(v_search in lower(r.search_text))>0) into v_all,v_count
      from public.my_leads_queue_rows(p_org_id,p_member_id,v_at) r where r.stage=v_stage;
    select coalesce(jsonb_agg(page.row_data order by page.warning_rank desc,page.assignment_sort desc,page.property_id desc),'[]') into v_rows
      from (select r.* from public.my_leads_queue_rows(p_org_id,p_member_id,v_at) r
        where r.stage=v_stage and position(v_search in lower(r.search_text))>0
        and (p_cursor is null or (r.warning_rank,r.assignment_sort,r.property_id)<(v_cursor.warning_rank,v_cursor.assignment_sort,v_cursor.property_id))
        order by r.warning_rank desc,r.assignment_sort desc,r.property_id desc limit v_limit+1) page;
    v_next:=null;
    if jsonb_array_length(v_rows)>v_limit then
      v_rows:=v_rows-v_limit;
      select r.* into v_last from public.my_leads_queue_rows(p_org_id,p_member_id,v_at) r
        where r.property_id=(v_rows->(v_limit-1)->>'propertyId')::uuid;
      insert into public.acquisition_query_cursors(org_id,viewer_id,member_id,stage,search,snapshot_at,expires_at,warning_rank,assignment_sort,property_id)
        values(p_org_id,auth.uid(),p_member_id,v_stage,v_search,v_at,v_at+interval '5 minutes',v_last.warning_rank,v_last.assignment_sort,v_last.property_id)
        returning token into v_next;
    end if;
    v_pages:=v_pages||jsonb_build_object(v_stage,jsonb_build_object('rows',v_rows,'totalCount',v_all,'filteredCount',v_count,'cursor',v_next,'hasMore',v_next is not null));
  end loop;
  select min(next_warning_at) into v_next_warning from public.my_leads_queue_rows(p_org_id,p_member_id,v_at);
  return jsonb_build_object('stages',v_pages,'snapshotAt',v_at,'nextWarningAt',v_next_warning,'search',v_search);
end;
$$;
revoke all on function public.fn_get_acquisition_queue_page(uuid,uuid,text,text,uuid,integer) from public,anon;
grant execute on function public.fn_get_acquisition_queue_page(uuid,uuid,text,text,uuid,integer) to authenticated;
commit;
