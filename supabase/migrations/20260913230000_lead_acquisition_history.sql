begin;
-- Canonical lead history reads authoritative facts; no activity is synthesized.
create function public.fn_get_lead_acquisition_history(p_property_id uuid, p_limit integer default 50, p_before_at timestamptz default null, p_before_kind text default null, p_before_id uuid default null)
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
  select a.occurred_at at,'attempt'::text kind,a.id,jsonb_build_object('kind','attempt','id',a.id,'at',a.occurred_at,'actorId',a.actor_user_id,'source',a.source,'attemptKind',a.attempt_kind,'outcome',a.outcome,'note',a.note,'recordingUrl',a.recording_url,'callActivityId',a.call_activity_id) row
  from public.acquisition_attempts a where a.org_id=v_org and a.property_id=p_property_id
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
commit;
