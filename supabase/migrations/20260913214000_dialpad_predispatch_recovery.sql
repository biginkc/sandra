begin;
-- Created time is used only to decide when to abandon an unstarted reservation.
-- Safety comes from the same intent-row lock used by the dispatch RPC, not age.
create function public.fn_recover_dialpad_pre_dispatch(p_org_id uuid,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.dialpad_voice_intents%rowtype; result jsonb; recovered integer:=0; resumed integer:=0;
begin
  if p_org_id is null or p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'DIALPAD_RECOVERY_INVALID_INPUT' using errcode='22023';
  end if;
  for i in select candidate.* from public.dialpad_voice_intents candidate
    where candidate.org_id=p_org_id and candidate.status='prepared'
      and candidate.provider_call_id is null
      and candidate.created_at < statement_timestamp()-interval '10 minutes'
      and not exists(select 1 from public.dialpad_sequence_pause_controls c
        where c.intent_id=candidate.id and (c.dispatch_started or c.released))
    order by candidate.created_at,candidate.id limit p_limit
    for update of candidate skip locked
  loop
    -- The release RPC rechecks identity/state/control while holding this lock.
    -- Dispatch cannot claim between this check and the terminal release.
    result:=public.fn_release_dialpad_start(i.id,null);
    if result->>'released'='true' then
      recovered:=recovered+1;
      resumed:=resumed+coalesce((result->>'resumed')::integer,0);
    end if;
  end loop;
  return jsonb_build_object('recovered',recovered,'resumed',resumed);
end;
$$;
revoke all on function public.fn_recover_dialpad_pre_dispatch(uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_recover_dialpad_pre_dispatch(uuid,integer) to service_role;
commit;
