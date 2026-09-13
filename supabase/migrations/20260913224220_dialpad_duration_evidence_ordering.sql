begin;
-- Private provider metric watermark. Existing app-generated types need no change.
create table public.dialpad_duration_evidence (
 call_activity_id uuid primary key references public.call_activities(id) on delete cascade,
 event_ms numeric not null check(event_ms>0 and event_ms<=253402300799000)
);
alter table public.dialpad_duration_evidence enable row level security;
revoke all on public.dialpad_duration_evidence from public,anon,authenticated,service_role;
create or replace function public.dialpad_enrich_activity(p_activity uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare c public.call_activities%rowtype; v_end timestamptz; v_duration integer;
 v_expected boolean; v_event numeric; v_duration_ms numeric; v_previous numeric;
begin
 select * into c from public.call_activities where id=p_activity and provider='dialpad' for update;
 if not found then return; end if;
 if coalesce(p_payload->>'date_ended','') ~ '^[0-9]+$'
 and (p_payload->>'date_ended')::numeric between 1 and 253402300799000 then
  v_end:=to_timestamp(((p_payload->>'date_ended')::numeric/1000)::double precision);
 end if;
 if coalesce(p_payload->>'event_timestamp','') ~ '^[0-9]+$'
 and (p_payload->>'event_timestamp')::numeric between 1 and 253402300799000 then
  v_event:=(p_payload->>'event_timestamp')::numeric;
 end if;
 -- A bad temporal envelope cannot populate either terminal or duration evidence.
 if v_end<c.started_at or v_end>statement_timestamp()+interval '5 minutes'
 or v_event is null or v_event<extract(epoch from v_end)*1000
 or v_event>extract(epoch from statement_timestamp()+interval '5 minutes')*1000 then
  v_end:=null;
 end if;
 if v_end is not null and (c.provider_ended_at is null or c.provider_ended_at=v_end)
 and coalesce(p_payload->>'duration','') ~ '^[0-9]+(\.[0-9]+)?$' then
  v_duration_ms:=(p_payload->>'duration')::numeric;
  if v_duration_ms<=2147483647000 and v_duration_ms<=extract(epoch from(v_end-c.started_at))*1000 then
   select event_ms into v_previous from public.dialpad_duration_evidence where call_activity_id=c.id;
   if v_previous is null or v_event>v_previous then
    v_duration:=floor(v_duration_ms/1000)::integer;
    insert into public.dialpad_duration_evidence(call_activity_id,event_ms) values(c.id,v_event)
    on conflict(call_activity_id) do update set event_ms=excluded.event_ms;
   end if;
  end if;
 end if;
 if p_payload->'was_recorded'='true'::jsonb then v_expected:=true; end if;
 if jsonb_typeof(p_payload->'recording_details')='array' and jsonb_array_length(p_payload->'recording_details')>0 then v_expected:=true; end if;
 update public.call_activities set provider_ended_at=coalesce(provider_ended_at,v_end),ended_at=coalesce(ended_at,v_end),
 duration_seconds=coalesce(v_duration,duration_seconds),
 recording_expected=case when v_expected is true then true else recording_expected end where id=c.id;
end; $$;
revoke all on function public.dialpad_enrich_activity(uuid,jsonb) from public,anon,authenticated,service_role;
commit;
