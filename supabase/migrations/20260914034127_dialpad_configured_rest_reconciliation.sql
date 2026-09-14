begin;
-- Only immutable configured history authorizes routing. Revocation/current
-- settings do not erase already-bound call history. Legacy unsnapshotted calls
-- have no generic fallback and must not be routed with a current credential.
create function public.dialpad_reconciliation_has_frozen_configuration(p_org_id uuid,p_intent_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
 select 1 from public.dialpad_voice_intents i
 join public.dialpad_intent_configuration s on s.org_id=i.org_id and s.intent_id=i.id
 join public.dialpad_connection_revisions r on r.org_id=s.org_id and r.connection_id=s.connection_id and r.config_version=s.connection_version
 join public.dialpad_member_bindings b on b.org_id=s.org_id and b.id=s.binding_id and b.revision=s.binding_revision
 join public.dialpad_number_grants g on g.org_id=s.org_id and g.id=s.grant_id and g.revision=s.grant_revision
 where i.org_id=p_org_id and i.id=p_intent_id and i.provider_call_id is not null
 and b.member_user_id=i.actor_user_id and b.provider_user_id=i.dialpad_user_id
 and b.connection_id=s.connection_id and b.connection_version=s.connection_version
 and g.binding_id=b.id and g.number_e164=i.caller_id_e164
 );
$$;
revoke all on function public.dialpad_reconciliation_has_frozen_configuration(uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.fn_claim_dialpad_rest_reconciliation(p_org_id uuid)
returns setof public.dialpad_rest_reconciliation_jobs language plpgsql security definer set search_path='' as $$
declare v_next timestamptz; v_id uuid;
begin
 if p_org_id is null then raise exception 'DIALPAD_RECON_SCOPE' using errcode='23514'; end if;
 insert into public.dialpad_rest_reconciliation_jobs(org_id,activity_id,intent_id,provider_call_id)
 select c.org_id,c.id,i.id,c.provider_call_id from public.call_activities c
 join public.dialpad_voice_intents i on i.org_id=c.org_id and i.provider_call_id=c.provider_call_id
 where c.org_id=p_org_id and c.provider='dialpad' and public.dialpad_reconciliation_has_frozen_configuration(i.org_id,i.id)
 and c.operator_user_id=i.actor_user_id and c.property_id=i.property_id
 and not exists(select 1 from public.dialpad_rest_reconciliation_jobs j where j.org_id=c.org_id and j.provider_call_id=c.provider_call_id)
 order by c.started_at,c.id limit 100
 on conflict(org_id,provider_call_id) do nothing;
 insert into public.dialpad_detail_api_budget(org_id) values(p_org_id) on conflict do nothing;
 select next_allowed_at into v_next from public.dialpad_detail_api_budget where org_id=p_org_id for update;
 if v_next>clock_timestamp() then return; end if;
 select j.id into v_id from public.dialpad_rest_reconciliation_jobs j where j.org_id=p_org_id
 and ((j.status='pending' and j.next_attempt_at<=clock_timestamp()) or (j.status='processing' and j.lease_expires_at<=clock_timestamp()))
 order by j.next_attempt_at,j.id for update skip locked limit 1;
 if v_id is null then return; end if;
 update public.dialpad_detail_api_budget set next_allowed_at=clock_timestamp()+interval '7 seconds',updated_at=clock_timestamp() where org_id=p_org_id;
 return query update public.dialpad_rest_reconciliation_jobs j set status='processing',lease_token=extensions.gen_random_uuid(),
 lease_expires_at=clock_timestamp()+interval '120 seconds',attempt_count=j.attempt_count+1 where j.id=v_id returning j.*;
end; $$;

create or replace function public.fn_apply_dialpad_rest_reconciliation(p_job_id uuid,p_lease_token uuid,p_payload jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.dialpad_rest_reconciliation_jobs%rowtype; i public.dialpad_voice_intents%rowtype;
 c public.call_activities%rowtype; segment jsonb; v_start numeric; v_event numeric;
begin
 select * into j from public.dialpad_rest_reconciliation_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp() then return false; end if;
 select * into i from public.dialpad_voice_intents where id=j.intent_id for update;
 select * into c from public.call_activities where id=j.activity_id for update;
 -- Intent/activity locks may wait past lease expiry. No receipt or mutation
 -- belongs to an expired worker, even in a transaction with a frozen now().
 if j.lease_expires_at<=clock_timestamp() then return false; end if;
 -- Rejected identities still retain authenticated raw provenance.
 insert into public.dialpad_rest_reconciliation_receipts(job_id,payload) values(j.id,p_payload);
 if not public.dialpad_reconciliation_has_frozen_configuration(j.org_id,j.intent_id)
 or i.org_id is distinct from j.org_id or c.org_id is distinct from j.org_id
 or c.provider is distinct from 'dialpad'
 or i.provider_call_id is distinct from j.provider_call_id or c.provider_call_id is distinct from j.provider_call_id
 or c.operator_user_id is distinct from i.actor_user_id or c.property_id is distinct from i.property_id
 or p_payload->>'call_id' is distinct from j.provider_call_id
 or lower(p_payload#>>'{target,type}') is distinct from 'user' or p_payload#>>'{target,id}' is distinct from i.dialpad_user_id
 or p_payload->>'direction' is distinct from 'outbound'
 or p_payload->>'internal_number' is distinct from i.caller_id_e164 or p_payload->>'external_number' is distinct from i.destination_e164
 or coalesce(p_payload->>'date_started','') !~ '^[0-9]+$' or coalesce(p_payload->>'event_timestamp','') !~ '^[0-9]+$'
 then
 update public.dialpad_rest_reconciliation_jobs set status='quarantined',last_error_code='identity_rejected',lease_token=null,lease_expires_at=null where id=j.id; return true;
 end if;
 v_start:=(p_payload->>'date_started')::numeric; v_event:=(p_payload->>'event_timestamp')::numeric;
 if v_start<>extract(epoch from c.started_at)*1000 or v_event<v_start or v_event>extract(epoch from now())*1000+300000
 or (p_payload ? 'recording_details' and jsonb_typeof(p_payload->'recording_details')<>'array') then
 update public.dialpad_rest_reconciliation_jobs set status='quarantined',last_error_code='snapshot_rejected',lease_token=null,lease_expires_at=null where id=j.id; return true;
 end if;
 for segment in select value from jsonb_array_elements(coalesce(p_payload->'recording_details','[]'::jsonb)) loop
 if jsonb_typeof(segment)<>'object' or nullif(btrim(segment->>'id'),'') is null or nullif(btrim(segment->>'recording_type'),'') is null then
 update public.dialpad_rest_reconciliation_jobs set status='quarantined',last_error_code='manifest_rejected',lease_token=null,lease_expires_at=null where id=j.id; return true;
 end if;
 end loop;
 perform public.dialpad_enrich_activity(c.id,p_payload);
 for segment in select value from jsonb_array_elements(coalesce(p_payload->'recording_details','[]'::jsonb)) loop
 insert into public.dialpad_recording_artifacts(org_id,provider_call_id,provider_recording_id,recording_kind,intent_id,status)
 values(j.org_id,j.provider_call_id,segment->>'id',segment->>'recording_type',i.id,'pending')
 on conflict(org_id,provider_call_id,provider_recording_id) do nothing;
 update public.dialpad_recording_artifacts set intent_id=i.id where org_id=j.org_id and provider_call_id=j.provider_call_id
 and provider_recording_id=segment->>'id' and intent_id is null;
 end loop;
 -- A terminal call receives a 24-hour enrichment window; paused is not proof
 -- of recording completeness. Active calls never age out or release a lease.
 select * into c from public.call_activities where id=j.activity_id;
 update public.dialpad_rest_reconciliation_jobs set
 status=case when c.provider_ended_at<=now()-interval '24 hours' then 'paused' else 'pending' end,
 attempt_count=0,next_attempt_at=now()+interval '15 minutes',lease_token=null,lease_expires_at=null,
 last_error_code=case when c.provider_ended_at<=now()-interval '24 hours' then 'polling_window_ended' else null end where id=j.id;
 return true;
end; $$;

commit;
