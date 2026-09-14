begin;
-- Signed recording evidence may arrive before a verified call is bound to its
-- frozen intent. Keep it pending until event or REST reconciliation links it.
create or replace function public.fn_claim_dialpad_recording(p_org_id uuid,p_lease_seconds integer default 180)
returns setof public.dialpad_recording_artifacts language plpgsql security definer set search_path='' as $$
declare v_next timestamptz; v_id uuid;
begin
  if p_org_id is null or p_lease_seconds is null or p_lease_seconds<30 or p_lease_seconds>900 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  insert into public.dialpad_detail_api_budget(org_id) values(p_org_id) on conflict do nothing;
  select next_allowed_at into v_next from public.dialpad_detail_api_budget where org_id=p_org_id for update;
  if v_next>clock_timestamp() then return; end if;
  select id into v_id from public.dialpad_recording_artifacts where org_id=p_org_id and intent_id is not null and
    ((status in ('pending','retry') and next_attempt_at<=clock_timestamp()) or (status='processing' and lease_expires_at<=clock_timestamp()))
    order by next_attempt_at,created_at,id for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.dialpad_detail_api_budget set next_allowed_at=clock_timestamp()+interval '7 seconds',updated_at=clock_timestamp() where org_id=p_org_id;
  return query update public.dialpad_recording_artifacts set status='processing',attempt_count=attempt_count+1,
    lease_token=extensions.gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=v_id returning *;
end;
$$;
commit;
