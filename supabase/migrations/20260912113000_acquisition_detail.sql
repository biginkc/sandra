begin;
create or replace function public.my_leads_detail_rows(p_org uuid,p_property uuid,p_group text)
returns table(id uuid,occurred_at timestamptz,fact jsonb)
language sql stable security definer set search_path='' as $$
  select n.id,n.created_at,jsonb_build_object('id',n.id,'actorId',n.author_user_id,'body',n.body,'at',n.created_at)
    from public.lead_notes n where p_group='notes' and n.org_id=p_org and n.property_id=p_property
  union all
  select a.id,a.occurred_at,jsonb_build_object('id',a.id,'actorId',a.actor_user_id,'outcome',a.outcome,'source',a.source,'at',a.occurred_at,'recordingUrl',a.recording_url,'callActivityId',a.call_activity_id)
    from public.acquisition_attempts a where p_group='attempts' and a.org_id=p_org and a.property_id=p_property
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

create or replace function public.fn_get_acquisition_detail(p_org_id uuid,p_member_id uuid,p_property_id uuid,p_group text default null,p_cursor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_group text;v_rows jsonb;v_next uuid;v_groups jsonb:='{}';v_cursor public.acquisition_query_cursors%rowtype;
  v_at timestamptz:=statement_timestamp();v_last_id uuid;v_last_at timestamptz;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if not exists(select 1 from public.properties where id=p_property_id and org_id=p_org_id and assigned_user_id=p_member_id and deleted_at is null and not is_dnc_locked) then
    raise exception 'STALE_ASSIGNMENT' using errcode='42501';
  end if;
  if p_group is not null and p_group not in ('notes','attempts','appointments','offers','history') then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  if p_cursor is not null then
    select * into v_cursor from public.acquisition_query_cursors where token=p_cursor;
    if not found or v_cursor.org_id<>p_org_id or v_cursor.viewer_id<>auth.uid() or v_cursor.member_id<>p_member_id
      or v_cursor.stage is distinct from 'detail:'||p_property_id::text||':'||p_group or v_cursor.expires_at<=v_at then
      raise exception 'CURSOR_EXPIRED' using errcode='22023';
    end if;
    v_at:=v_cursor.snapshot_at;
  end if;
  foreach v_group in array case when p_group is null then array['notes','attempts','appointments','offers','history'] else array[p_group] end loop
    select coalesce(jsonb_agg(r.fact order by r.occurred_at desc,r.id desc),'[]') into v_rows
      from (select * from public.my_leads_detail_rows(p_org_id,p_property_id,v_group) d
        where p_cursor is null or (d.occurred_at,d.id)<(v_cursor.assignment_sort,v_cursor.property_id)
        order by d.occurred_at desc,d.id desc limit 21) r;
    v_next:=null;
    if jsonb_array_length(v_rows)>20 then
      v_rows:=v_rows-20;
      v_last_id:=(v_rows->19->>'id')::uuid;v_last_at:=(v_rows->19->>'at')::timestamptz;
      insert into public.acquisition_query_cursors(org_id,viewer_id,member_id,stage,search,snapshot_at,expires_at,warning_rank,assignment_sort,property_id)
        values(p_org_id,auth.uid(),p_member_id,'detail:'||p_property_id::text||':'||v_group,'',v_at,v_at+interval '5 minutes',0,v_last_at,v_last_id)
        returning token into v_next;
    end if;
    v_groups:=v_groups||jsonb_build_object(v_group,jsonb_build_object('rows',v_rows,'cursor',v_next,'hasMore',v_next is not null));
  end loop;
  return jsonb_build_object('groups',v_groups);
end;
$$;
revoke all on function public.fn_get_acquisition_detail(uuid,uuid,uuid,text,uuid) from public,anon;
grant execute on function public.fn_get_acquisition_detail(uuid,uuid,uuid,text,uuid) to authenticated;
commit;
