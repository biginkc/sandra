#!/usr/bin/env node
// Real read model, reconciliation, and metrics migrations in disposable PostgreSQL.
// Minimal pre-acquisition fixture schema; no hosted credentials or durable writes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster=mkdtempSync(join(tmpdir(),'rep-sms-'));
const socket=mkdtempSync('/tmp/rsmsock-');
const port=19000+Math.floor(Math.random()*1000);
const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=q=>run('psql',['-h',socket,'-p',String(port),'-U','postgres','-v','ON_ERROR_STOP=1','-Atq','-c',q]).trim();
const migration=name=>sql(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),rep=id(2),other=id(3),owner=id(4),property=id(10);
const auth=`select set_config('request.jwt.claim.sub','${rep}',false); set role authenticated;`;
const kpi=()=>JSON.parse(sql(`${auth} select public.fn_get_acquisition_kpis('${org}','${rep}',date_trunc('day',now())-interval '1 day',date_trunc('day',now())+interval '1 day');`).split('\n').at(-1));
let started=false;
try {
 run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
 run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -p ${port} -h ''`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;
 create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(org_id uuid,user_id uuid,role text default 'member',access_status text default 'active',deletion_prepared_at timestamptz,access_expires_at timestamptz,acquisitions_enabled boolean default true);
 create table acquisition_org_settings(org_id uuid primary key,my_leads_enabled boolean);
 create table contacts(id uuid,org_id uuid,first_name text,last_name text,phone_1 text,phone_2 text,phone_3 text,do_not_contact boolean);
 create table properties(id uuid primary key,org_id uuid,assigned_user_id uuid,address text,city text,state text,zip text,status text default 'contacted',motivation_level text,homeowner_contact_id uuid,deleted_at timestamptz,is_dnc_locked boolean default false,unique(id,org_id));
 create table acquisition_assignment_episodes(id uuid primary key,org_id uuid,property_id uuid,assignee_user_id uuid,assigned_at timestamptz,initialized_at timestamptz default now(),ended_at timestamptz,eligible boolean default false,episode_kind text default 'live',first_call_started_at timestamptz,unique(id,property_id,org_id));
 create table acquisition_queue_states(property_id uuid,org_id uuid,stage text,version bigint default 1,stage_entered_at timestamptz default now(),motivation_kind text,motivation_text text,archived_at timestamptz,updated_at timestamptz default now());
 create table acquisition_commands(id uuid primary key default gen_random_uuid(),org_id uuid,actor_kind text,actor_user_id uuid,operation text,idempotency_key uuid,request_hash text,result jsonb);
 create table dialer_batch_items(id uuid primary key,property_id uuid,phone_e164 text);
 create table call_activities(id uuid primary key,org_id uuid,property_id uuid,operator_user_id uuid,dialer_batch_item_id uuid,provider text,jitter_attempt_id text,provider_call_id text,outcome text,notes text,recording_path text,ended_at timestamptz,duration_seconds integer);
 create table call_recordings(id uuid default gen_random_uuid(),call_activity_id uuid,status text,storage_path text);
 create table acquisition_attempts(id uuid primary key default gen_random_uuid(),org_id uuid,property_id uuid,assignment_episode_id uuid,actor_user_id uuid,attempt_kind text,source text,outcome text,occurred_at timestamptz,idempotency_key uuid default gen_random_uuid(),call_activity_id uuid,command_id uuid,note text,recording_url text,unique(id,org_id));
 create table acquisition_offers(id uuid primary key,org_id uuid,property_id uuid,actor_user_id uuid,sent_at timestamptz,amount_cents bigint,sent_via text,follow_up_at timestamptz,outcome text,outcome_at timestamptz);
 create table lead_notes(id uuid primary key,org_id uuid,property_id uuid,author_user_id uuid,body text,created_at timestamptz default now());
 create table tasks(id uuid primary key,org_id uuid,related_property_id uuid,assignee_id uuid,type text,status text,due_at timestamptz,snoozed_until timestamptz,outcome text,title text);
 create table acquisition_appointment_attribution(task_id uuid,org_id uuid,accountable_user_id uuid);
 create function hugo_has_active_org_access(uuid) returns boolean language sql stable as $$select true$$;
 create function acquisition_working_deadline(timestamptz) returns timestamptz language sql as $$select $1+interval '4 hours'$$;
 create function my_leads_command_hash(text,uuid,uuid,jsonb) returns text language sql as $$select md5($1||$2::text||$3::text||$4::text)$$;
 insert into auth.users values('${rep}'),('${other}'),('${owner}');insert into organizations values('${org}');
 insert into memberships(org_id,user_id,role) values('${org}','${rep}','member'),('${org}','${owner}','owner');
 insert into acquisition_org_settings values('${org}',true);
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 `);
 migration('20260912110000_acquisition_read_model.sql');
 migration('20260912113000_acquisition_detail.sql');

 migration('20260917080000_rep_sms_senders.sql');
 migration('20260912101000_acquisition_manual_attempts.sql');
 migration('20260913100000_my_leads_metrics.sql');
 migration('20260917100000_rep_sms_obligations.sql');
 migration('20260917110000_rep_sms_obligation_read_models.sql');
 sql(`grant select on memberships,properties to authenticated;
 insert into memberships(org_id,user_id,role) values('${org}','${other}','member');
 insert into properties(id,org_id,assigned_user_id,address,status) values('${property}','${org}','${rep}','1 Test St','contacted');
 insert into contacts(id,org_id,first_name,last_name,phone_1) values('${id(12)}','${org}','Home','Owner','+18165551234');
 update properties set homeowner_contact_id='${id(12)}',status='contacted' where id='${property}';
 insert into acquisition_assignment_episodes(id,org_id,property_id,assignee_user_id,assigned_at,initialized_at,eligible,episode_kind)
   values('${id(11)}','${org}','${property}','${rep}',now()-interval '1 hour',now()-interval '1 hour',true,'live');`);
 sql(`insert into acquisition_queue_states(property_id,org_id,stage,version) values('${property}','${org}','contacted',1)`);
 const as=(user,query)=>sql(`select set_config('request.jwt.claim.sub','${user}',false);set role authenticated;${query}`).split('\n').at(-1);
 const set=(user=rep,phone='+18163706846',def=true,active=true)=>`select fn_set_rep_sms_sender('${org}','${user}','sendillo','${phone}','account-1','sender-${user}','Rep phone',${def},${active})`;
 const context=()=>JSON.parse(as(rep,`select fn_get_rep_sms_context('${property}')`));
 assert.throws(()=>as(rep,set()));
 assert.throws(()=>sql(`set role anon;${set()}`));
 as(owner,set());
 as(owner,set(rep,'+18165550001',true));
 as(owner,set(other,'+18163706846',true));
 assert.equal(context().senders.length,2);
 assert.equal(context().senders[0].number,'+18165550001');
 assert.equal(context().senders.filter(s=>s.isDefault).length,1);
 assert.equal(as(rep,'select count(*) from rep_sms_sender_assignments'),'2');
 assert.equal(as(owner,'select count(*) from rep_sms_sender_assignments'),'3');
 assert.equal(as(other,'select count(*) from rep_sms_sender_assignments'),'1');
 assert.equal(as(rep,`select enabled from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`),'t');
 const enrollmentBefore=as(owner,`select enrolled_at from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`);
 as(owner,`select fn_set_rep_sms_enrollment('${org}','${rep}',false)`);
 assert.equal(as(rep,`select enabled from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`),'f');
 as(owner,`select fn_set_rep_sms_enrollment('${org}','${rep}',true)`);
 assert.equal(as(rep,`select enabled from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`),'t');
 assert.equal(as(owner,`select enrolled_by from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`),owner);
 assert.notEqual(as(owner,`select enrolled_at from rep_sms_rollout_enrollments where org_id='${org}' and user_id='${rep}'`),enrollmentBefore);
 assert.throws(()=>as(other,`select fn_get_rep_sms_context('${property}')`));
 for (const [change,restore] of [
 [`update memberships set acquisitions_enabled=false where user_id='${rep}'`,`update memberships set acquisitions_enabled=true where user_id='${rep}'`],
 [`update memberships set access_status='suspended' where user_id='${rep}'`,`update memberships set access_status='active' where user_id='${rep}'`],
 [`update acquisition_org_settings set my_leads_enabled=false`,`update acquisition_org_settings set my_leads_enabled=true`],
 [`update properties set assigned_user_id='${other}'`,`update properties set assigned_user_id='${rep}'`],
 [`update properties set is_dnc_locked=true`,`update properties set is_dnc_locked=false`],
 [`update acquisition_assignment_episodes set ended_at=now()`,`update acquisition_assignment_episodes set ended_at=null`],
 ]) {sql(change);assert.throws(context);sql(restore);}
 sql(`update acquisition_queue_states set archived_at=now() where property_id='${property}'`);
 assert.throws(context);sql('update acquisition_queue_states set archived_at=null');
 sql(`update memberships set access_status='suspended' where user_id='${rep}'`);
 assert.equal(as(rep,'select count(*) from rep_sms_sender_assignments'),'0');
 as(owner,set(rep,'+18165550001',false,false));
 assert.throws(()=>as(owner,set()));
 sql(`update memberships set access_status='active' where user_id='${rep}'`);
 assert.equal(context().senders.length,1);
 const logInput=(key,version)=>JSON.stringify({propertyId:property,expectedEpisodeId:id(11),expectedQueueVersion:version,
   expectedSharedStatus:'contacted',idempotencyKey:key,occurredAt:new Date().toISOString(),source:'manual',kind:'outreach',outcome:'no_answer',smsBody:'Checking in',
   followUp:{policyVersion:1,introId:'mel-standard',introVersion:1,templateId:'no-answer-callback',templateVersion:1,initialRemainder:'Checking in',remainder:'Checking in',body:'Checking in'}}).replaceAll("'","''");
 // Finalization path: an existing provider-backed attempt gets a durable
 // obligation in the same way as the direct/manual logger.
 sql(`insert into call_activities(id,org_id,property_id,operator_user_id,provider,jitter_attempt_id,provider_call_id)
   values('${id(13)}','${org}','${property}','${rep}','sandra_softphone','sandra-finalize-1','provider-finalize-1');
   insert into acquisition_attempts(id,org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,idempotency_key)
   values('${id(30)}','${org}','${property}','${id(11)}','${rep}','call','sandra',now()-interval '1 minute','${id(13)}','${id(31)}');`);
 const finalizeInput=JSON.stringify({orgId:org,propertyId:property,callActivityId:id(13),idempotencyKey:id(32),outcome:'no_answer'}).replaceAll("'","''");
 const finalized=JSON.parse(as(rep,`select fn_finalize_acquisition_attempt('${finalizeInput}'::jsonb)`));
 assert.equal(as(rep,`select state from rep_sms_obligations where attempt_id='${finalized.attemptId}'`),'required');
 // Provider reconciliation updates a previously pending Sandra attempt after
 // evidence arrives. The database trigger must create one obligation on that
 // transition, and the repeated update must remain idempotent.
 const reconciledAttempt=id(40);
 sql(`insert into dialer_batch_items(id,property_id,phone_e164) values('${id(42)}','${property}','+19995550101');
   insert into acquisition_commands(id,org_id,actor_kind,operation,idempotency_key,request_hash,result)
     values('${id(44)}','${org}','system','record_call_start','${id(45)}','reconcile-hash','{"jitterCallId":"reconcile-1","sellerProviderCallId":"provider-reconcile-1"}'::jsonb);
   insert into acquisition_attempts(id,org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,command_id,idempotency_key)
   values('${reconciledAttempt}','${org}','${property}','${id(11)}','${rep}','call','sandra',now()-interval '30 seconds',null,'${id(44)}','${id(41)}');
   insert into call_activities(id,org_id,property_id,operator_user_id,dialer_batch_item_id,provider,jitter_attempt_id,provider_call_id,outcome)
     values('${id(43)}','${org}','${property}','${rep}','${id(42)}','sandra_softphone','sandra-reconcile-1','provider-reconcile-1','voicemail');
   select my_leads_reconcile_call('${org}','reconcile-1');
   select my_leads_reconcile_call('${org}','reconcile-1');`);
 assert.equal(sql(`select outcome from acquisition_attempts where id='${reconciledAttempt}'`),'no_answer');
 assert.equal(sql(`select call_activity_id from acquisition_attempts where id='${reconciledAttempt}'`),id(43));
 assert.equal(as(rep,`select count(*) from rep_sms_obligations where attempt_id='${reconciledAttempt}'`),'1');
 assert.equal(as(rep,`select state from rep_sms_obligations where attempt_id='${reconciledAttempt}'`),'required');
 assert.equal(as(rep,`select to_number from rep_sms_obligations where attempt_id='${reconciledAttempt}'`),'+19995550101');
 const detail=JSON.parse(as(rep,`select fn_get_acquisition_detail('${org}','${rep}','${property}','attempts',null)`));
 const detailAttempt=detail.groups.attempts.rows.find(row=>row.id===reconciledAttempt);
 assert.equal(detailAttempt.followUpStatus,'required');
 assert.equal(detailAttempt.followUpObligationId,as(rep,`select id from rep_sms_obligations where attempt_id='${reconciledAttempt}'`));
 const history=JSON.parse(as(rep,`select fn_get_lead_acquisition_history('${property}',50,null,null,null)`));
 const historyAttempt=history.rows.find(row=>row.id===reconciledAttempt);
 assert.equal(historyAttempt.followUpStatus,'required');
 assert.equal(historyAttempt.followUpObligationId,detailAttempt.followUpObligationId);
 const resumableContext=context();
 assert.equal(resumableContext.obligation.status,'required');
 assert.equal(resumableContext.obligation.id,detailAttempt.followUpObligationId);
 const firstAttempt=JSON.parse(as(rep,`select fn_log_acquisition_attempt('${logInput(id(20),1)}'::jsonb)`));
 assert.equal(as(rep,`select state from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`),'required');
 assert.equal(as(rep,`select message_body from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`),'Checking in');
 assert.equal(as(rep,`select composition->>'templateId' from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`),'no-answer-callback');
 assert.equal(as(rep,`select composition->>'body' from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`),'Checking in');
 assert.equal(as(rep,`select to_number from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`),'+18165551234');
 as(owner,set(rep,'+18163706846',false,false));
 const secondAttempt=JSON.parse(as(rep,`select fn_log_acquisition_attempt('${logInput(id(21),2)}'::jsonb)`));
 assert.equal(as(rep,`select state from rep_sms_obligations where attempt_id='${secondAttempt.attemptId}'`),'blocked');
 assert.equal(as(rep,`select blocked_reason from rep_sms_obligations where attempt_id='${secondAttempt.attemptId}'`),'sender_grant_missing');
 assert.throws(()=>as(rep,`insert into rep_sms_obligations(org_id,property_id,attempt_id,actor_user_id) values('${org}','${property}','${secondAttempt.attemptId}','${rep}')`));
 as(owner,set(rep,'+18163706846',false,true));
 const firstObligationId=as(rep,`select id from rep_sms_obligations where attempt_id='${firstAttempt.attemptId}'`);
 const composition=JSON.stringify({policyVersion:1,introId:'mel-standard',introVersion:1,templateId:'no-answer-callback',templateVersion:1,initialRemainder:'Checking in',remainder:'Checking in',body:"Hey, this is Mel, Maria's assistant. Checking in"}).replaceAll("'","''");
 const claim=JSON.parse(sql(`set role service_role; select fn_claim_authorize_rep_sms_obligation('${org}','${firstObligationId}','${rep}','${composition}'::jsonb)`));
 assert.equal(claim.state,'sending');
 assert.equal(claim.providerAccountId,'account-1');
 assert.equal(Number(claim.claimGeneration),1);
 const fence=JSON.parse(sql(`set role service_role; select fn_assert_rep_sms_obligation_dispatch('${claim.obligationId}','${claim.claimToken}',${claim.claimGeneration},'${rep}')`));
 assert.equal(fence.ok,true);
 assert.equal(fence.providerAccountId,'account-1');
 assert.equal(as(rep,`select count(*) from rep_sms_obligation_audit where obligation_id='${claim.obligationId}' and action='dispatch_fence'`),'1');
 assert.throws(()=>sql(`set role service_role; select fn_assert_rep_sms_obligation_dispatch('${claim.obligationId}','${id(99)}',${claim.claimGeneration},'${rep}')`));
 const accepted=JSON.parse(sql(`set role service_role; select fn_record_rep_sms_obligation_result('${claim.obligationId}','${claim.claimToken}','accepted','provider-1','accepted',null,null,'{}')`));
 assert.equal(accepted.state,'accepted');
 const wrongAccount=JSON.parse(sql(`set role service_role; select fn_record_rep_sms_delivery('sendillo','wrong-account','provider-1','delivered','delivered',null,'{}')`));
 assert.equal(wrongAccount.matched,false);
 const delivered=JSON.parse(sql(`set role service_role; select fn_record_rep_sms_delivery('sendillo','account-1','provider-1','delivered','delivered',null,'{}')`));
 assert.equal(delivered.state,'delivered');
 assert.equal(as(rep,`select count(*) from rep_sms_obligation_audit where obligation_id='${claim.obligationId}'`),'4');
 // A current assignee can read outstanding history, while the original actor
 // remains visible for audit. This tests the transfer side of RLS directly.
 sql(`update properties set assigned_user_id='${other}' where id='${property}'`);
 assert.equal(as(other,`select count(*) from rep_sms_obligations where org_id='${org}'`),'4');
 assert.equal(as(rep,`select count(*) from rep_sms_obligations where org_id='${org}'`),'4');
 sql(`update properties set assigned_user_id='${rep}' where id='${property}'`);
 // Once authorization has durably reached `sending`, an expired claim is
 // ambiguous because the provider may already have received the request.
 sql(`update rep_sms_obligations set next_attempt_at=now() where attempt_id='${finalized.attemptId}'`);
 const finalizedObligationId=sql(`select id from rep_sms_obligations where attempt_id='${finalized.attemptId}'`);
 assert.match(finalizedObligationId,/^[0-9a-f-]{36}$/);
 const expiredClaim=JSON.parse(sql(`set role service_role; select fn_claim_authorize_rep_sms_obligation('${org}','${finalizedObligationId}','${rep}','${composition}'::jsonb)`));
 assert.equal(expiredClaim.state,'sending');
 sql(`update rep_sms_obligations set lease_expires_at=now()-interval '1 second' where id='${expiredClaim.obligationId}'`);
 const stale=JSON.parse(sql(`set role service_role; select fn_claim_authorize_rep_sms_obligation('${org}','${expiredClaim.obligationId}','${rep}','${composition}'::jsonb)`));
 assert.equal(stale.state,'unknown');
 assert.equal(as(rep,`select state from rep_sms_obligations where id='${expiredClaim.obligationId}'`),'unknown');
 assert.equal(as(rep,`select count(*) from rep_sms_obligation_audit where obligation_id='${expiredClaim.obligationId}' and action='lease_expired' and from_state='sending' and to_state='unknown'`),'1');
 sql(`update rep_sms_obligations set provider_message_id='provider-unknown-fail',provider_account_id='account-1' where id='${expiredClaim.obligationId}'`);
 const lateFailed=JSON.parse(sql(`set role service_role; select fn_record_rep_sms_delivery('sendillo','account-1','provider-unknown-fail','delivery_failed','failed','late provider failure','{}')`));
 assert.equal(lateFailed.state,'delivery_failed');
 assert.equal(as(rep,`select state from rep_sms_obligations where id='${expiredClaim.obligationId}'`),'delivery_failed');
 // A separate expired claim proves the other authoritative late transition.
 const queueVersion=sql(`select version from acquisition_queue_states where org_id='${org}' and property_id='${property}'`);
 const thirdAttempt=JSON.parse(as(rep,`select fn_log_acquisition_attempt('${logInput(id(22),queueVersion)}'::jsonb)`));
 const thirdObligationId=as(rep,`select id from rep_sms_obligations where attempt_id='${thirdAttempt.attemptId}'`);
 const thirdClaim=JSON.parse(sql(`set role service_role; select fn_claim_authorize_rep_sms_obligation('${org}','${thirdObligationId}','${rep}','${composition}'::jsonb)`));
 sql(`update rep_sms_obligations set lease_expires_at=now()-interval '1 second' where id='${thirdObligationId}'`);
 assert.throws(()=>sql(`set role service_role; select fn_assert_rep_sms_obligation_dispatch('${thirdClaim.obligationId}','${thirdClaim.claimToken}',${thirdClaim.claimGeneration},'${rep}')`));
 const thirdStale=JSON.parse(sql(`set role service_role; select fn_claim_authorize_rep_sms_obligation('${org}','${thirdObligationId}','${rep}','${composition}'::jsonb)`));
 assert.equal(thirdStale.state,'unknown');
 sql(`update rep_sms_obligations set provider_message_id='provider-unknown-delivered',provider_account_id='account-1' where id='${thirdObligationId}'`);
 const lateDelivered=JSON.parse(sql(`set role service_role; select fn_record_rep_sms_delivery('sendillo','account-1','provider-unknown-delivered','delivered','delivered',null,'{}')`));
 assert.equal(lateDelivered.state,'delivered');
 assert.equal(sql(`select count(*) from pg_indexes where schemaname='public' and indexname='acquisition_attempts_id_org_idx'`),'1');
 assert.equal(sql(`select count(*) from pg_indexes where schemaname='public' and indexname='rep_sms_obligations_provider_callback_idx'`),'1');
 assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('fn_claim_rep_sms_obligations','fn_authorize_rep_sms_obligation')`),'0');
 sql(`update memberships set access_status='suspended' where user_id='${owner}'`);
 assert.throws(()=>as(owner,set()));
 console.log('Rep SMS SQL: owner grants, RLS, default selection, revocation and current-queue checks passed.');
} finally {
 if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
 rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
}
