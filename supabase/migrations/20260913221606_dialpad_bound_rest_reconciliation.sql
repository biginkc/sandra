begin;
-- REST snapshots are never signed webhook receipts or acquisition-start evidence.
create table public.dialpad_rest_reconciliation_jobs (
 id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null,
 activity_id uuid not null references public.call_activities(id), intent_id uuid not null references public.dialpad_voice_intents(id),
 provider_call_id text not null, status text not null default 'pending' check(status in ('pending','processing','failed','quarantined','paused')),
 attempt_count integer not null default 0, next_attempt_at timestamptz not null default now(),
 lease_token uuid, lease_expires_at timestamptz, last_error_code text,
 unique(org_id,provider_call_id)
);
create index on public.dialpad_rest_reconciliation_jobs(org_id,next_attempt_at) where status in ('pending','processing');
create table public.dialpad_rest_reconciliation_receipts (
 id uuid primary key default extensions.gen_random_uuid(), job_id uuid not null references public.dialpad_rest_reconciliation_jobs(id),
 fetched_at timestamptz not null default now(), payload jsonb not null,
 source text not null default 'authenticated_rest_get_call' check(source='authenticated_rest_get_call')
);
alter table public.dialpad_rest_reconciliation_jobs enable row level security;
alter table public.dialpad_rest_reconciliation_receipts enable row level security;
revoke all on public.dialpad_rest_reconciliation_jobs,public.dialpad_rest_reconciliation_receipts from public,anon,authenticated,service_role;

create function public.fn_claim_dialpad_rest_reconciliation(p_org_id uuid)
returns setof public.dialpad_rest_reconciliation_jobs language plpgsql security definer set search_path='' as $$
declare v_next timestamptz; v_id uuid;
begin
 if p_org_id is null or p_org_id<>'00000000-0000-0000-0000-000000000bbb'::uuid then raise exception 'DIALPAD_RECON_SCOPE' using errcode='23514'; end if;
 insert into public.dialpad_rest_reconciliation_jobs(org_id,activity_id,intent_id,provider_call_id)
 select c.org_id,c.id,i.id,c.provider_call_id from public.call_activities c
 join public.dialpad_voice_intents i on i.org_id=c.org_id and i.provider_call_id=c.provider_call_id
 where c.org_id=p_org_id and c.provider='dialpad' and i.dialpad_user_id='4904023124647936'
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

create function public.fn_apply_dialpad_rest_reconciliation(p_job_id uuid,p_lease_token uuid,p_payload jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.dialpad_rest_reconciliation_jobs%rowtype; i public.dialpad_voice_intents%rowtype;
 c public.call_activities%rowtype; segment jsonb; v_start numeric; v_event numeric;
begin
 select * into j from public.dialpad_rest_reconciliation_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=now() then return false; end if;
 -- Retain rejected raw snapshots too; quarantine and receipt commit together.
 insert into public.dialpad_rest_reconciliation_receipts(job_id,payload) values(j.id,p_payload);
 select * into i from public.dialpad_voice_intents where id=j.intent_id for update;
 select * into c from public.call_activities where id=j.activity_id for update;
 if j.org_id<>'00000000-0000-0000-0000-000000000bbb'::uuid
 or i.org_id is distinct from j.org_id or c.org_id is distinct from j.org_id
 or c.provider is distinct from 'dialpad' or i.dialpad_user_id is distinct from '4904023124647936'
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

create function public.fn_fail_dialpad_rest_reconciliation(p_job_id uuid,p_lease_token uuid,p_permanent boolean,p_error_code text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.dialpad_rest_reconciliation_jobs set status=case when p_permanent then 'quarantined' when attempt_count>=8 then 'failed' else 'pending' end,
 next_attempt_at=now()+make_interval(secs=>least(3600,15*power(2,least(attempt_count,8)))::integer),
 last_error_code=case when p_error_code in ('provider_unavailable','snapshot_invalid','permission_denied') then p_error_code else 'reconciliation_failed' end,
 lease_token=null,lease_expires_at=null where id=p_job_id and status='processing' and lease_token=p_lease_token and lease_expires_at>now();
 return found;
end; $$;
revoke all on function public.fn_claim_dialpad_rest_reconciliation(uuid),public.fn_apply_dialpad_rest_reconciliation(uuid,uuid,jsonb),public.fn_fail_dialpad_rest_reconciliation(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_claim_dialpad_rest_reconciliation(uuid),public.fn_apply_dialpad_rest_reconciliation(uuid,uuid,jsonb),public.fn_fail_dialpad_rest_reconciliation(uuid,uuid,boolean,text) to service_role;
commit;
