/** Component SQL proof with minimal source fixtures, not full deployment rehearsal. Isolated PG17 proof. Creates only a private local socket/database, never a hosted target. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
const bin = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const dir = mkdtempSync(path.join(tmpdir(), 'acq-evidence-'));
const data = path.join(dir, 'data');
let started = false;
let client;
try {
  assert.match(execFileSync(path.join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }), /PostgreSQL\) 17\./);
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'], { stdio: 'pipe' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'postgres.log'), '-o', `-k ${dir} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  client = new pg.Client({ host: dir, user: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}',email text default 'owned@example.invalid');
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    create table public.organizations(id uuid primary key);
    create table public.memberships(org_id uuid,user_id uuid,role text,access_status text default 'active',
      access_expires_at timestamptz,deletion_prepared_at timestamptz,primary key(org_id,user_id));
    create table public.contacts(id uuid primary key,org_id uuid,first_name text,last_name text,phone_1 text,phone_2 text,phone_3 text,do_not_contact boolean default false);
    create table public.properties(id uuid primary key,org_id uuid,assigned_user_id uuid,status text default 'new_lead',
      deleted_at timestamptz,is_dnc_locked boolean default false,address text,city text,state text,zip text,motivation_level text,
      homeowner_contact_id uuid,unique(id,org_id));
    create table public.call_activities(id uuid primary key,property_id uuid,org_id uuid,provider text,jitter_attempt_id text,operator_user_id uuid,outcome text,notes text,provider_call_id text);
    create table public.tasks(id uuid primary key,org_id uuid,related_property_id uuid,type text,status text,due_at timestamptz,snoozed_until timestamptz,assignee_id uuid,outcome text,title text);
    create table public.lead_notes(id uuid primary key,org_id uuid,property_id uuid,author_user_id uuid,body text,created_at timestamptz);
  `);
  for (const name of ['20260912080000_acquisition_time_helpers.sql','20260912090000_acquisition_settings.sql',
    '20260912090100_acquisition_queue_episodes.sql','20260912090200_acquisition_attempt_offer_facts.sql',
    '20260912100000_acquisition_call_evidence.sql','20260912101000_acquisition_manual_attempts.sql','20260912110000_acquisition_read_model.sql','20260912111000_acquisition_kpis.sql','20260912112000_acquisition_roster.sql','20260912113000_acquisition_detail.sql','20260912130000_acquisition_call_reconciliation.sql']) {
    await client.query(readFileSync(new URL('./'+name,import.meta.url),'utf8'));
  }
  await client.query(`alter table call_activities alter column id set default extensions.gen_random_uuid();
    alter table call_activities alter column jitter_attempt_id set not null;
    alter table call_activities add column started_at timestamptz,add column ended_at timestamptz,add column duration_seconds integer,
      add column direction text,add column phone_e164 text,add column wrap_token uuid unique,add column recording_status text,add column transcript_status text,add column recording_path text;
    create table call_recordings(call_activity_id uuid,status text,storage_path text);
    create schema storage;create table storage.buckets(id text primary key,public boolean);
    grant usage on schema public,extensions to service_role,authenticated;`);
  for(const name of ['20260913100000_my_leads_metrics.sql','20260913210206_dialpad_voice_persistence_foundation.sql','20260913210933_dialpad_acquisition_evidence.sql']) await client.query(readFileSync(new URL('./'+name,import.meta.url),'utf8'));
  const org=randomUUID(),rep=randomUUID(),other=randomUUID(),lead=randomUUID();
  let episode;
  await client.query('insert into organizations values($1)',[org]);
  await client.query('insert into auth.users(id) values($1),($2)',[rep,other]);
  await client.query("insert into memberships(org_id,user_id,role) values($1,$2,'member'),($1,$3,'owner')",[org,rep,other]);
  await client.query('insert into acquisition_org_settings(org_id,my_leads_enabled) values($1,true)',[org]);
  await client.query("insert into properties(id,org_id,assigned_user_id,status) values($1,$2,$3,'new_lead')",[lead,org,rep]);
  episode=(await client.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[lead])).rows[0].id;
  await client.query("update acquisition_assignment_episodes set eligible=true,episode_kind='live',assigned_at=now()-interval '1 hour',initialized_at=now()-interval '1 hour' where id=$1",[episode]);
  const makeIntent=async()=>{
    const id=randomUUID(),hash=createHash('sha256').update(id).digest('hex');
    await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4)',[org,lead,rep,hash]);
    await client.query(`insert into dialpad_voice_intents(id,org_id,actor_user_id,property_id,assignment_episode_id,binding_token_hash,dialpad_user_id,destination_e164,caller_id_e164,client_idempotency_key) values($1,$2,$3,$4,$5,$6,'4904023124647936','+18165550101','+18165550102',$1)`,[id,org,rep,lead,episode,hash]);
    return id;
  };
  const intent=await makeIntent();
  const start=Date.now();
  const payload={call_id:'9007199254740993',state:'calling',custom_data:intent,direction:'outbound',target:{id:'4904023124647936',type:'User'},internal_number:'+18165550102',external_number:'+18165550101',date_started:start,event_timestamp:start};
  const receipt=async body=>{
    const id=randomUUID();await client.query('insert into dialpad_voice_event_inbox(id,org_id,envelope_sha256,payload) values($1,$2,$3,$4)',[id,org,createHash('sha256').update(id).digest('hex'),body]);return id;
  };
  const apply=async(id,event)=>{await client.query('set role service_role');try{return (await client.query('select fn_record_dialpad_acquisition_call_start($1,$2) result',[id,event])).rows[0].result;}finally{await client.query('reset role');}};
  const event=await receipt(payload);
  await client.query('set role authenticated');
  await assert.rejects(client.query('select fn_record_dialpad_acquisition_call_start($1,$2)',[intent,event]),/permission denied/);await client.query('reset role');
  for(const patch of [{custom_data:randomUUID()},{internal_number:'+18165550103'},{direction:'inbound'},{target:{id:other,type:'user'}},{date_started:0},{state:'new'}]) await assert.rejects(apply(intent,await receipt({...payload,...patch})),/DIALPAD_START/);
  const result=await apply(intent,event);assert.equal(result.tracked,true);assert.equal(result.duplicate,false);
  assert.equal((await apply(intent,event)).duplicate,true);
  assert.equal((await client.query('select count(*)::int n from acquisition_attempts')).rows[0].n,1);
  const activity=(await client.query('select * from call_activities where id=$1',[result.callActivityId])).rows[0];
  assert.equal(activity.jitter_attempt_id,null);assert.equal(activity.operator_user_id,rep);assert.equal(activity.provider_call_id,payload.call_id);
  assert.equal((await client.query('select outcome from acquisition_attempts')).rows[0].outcome,null);
  const terminal=await receipt({...payload,state:'hangup',was_recorded:true,duration:1533.5,date_ended:start+1500,event_timestamp:start+1500});
  await apply(intent,terminal);await apply(intent,event);
  const enriched=(await client.query('select * from call_activities where id=$1',[result.callActivityId])).rows[0];
  assert.equal(enriched.recording_expected,true);assert.equal(enriched.duration_seconds,1);assert.equal(enriched.talk_duration_seconds,null);assert.equal(enriched.provider_ended_at.getTime(),start+1500);
  const second=await makeIntent();await assert.rejects(apply(second,await receipt({...payload,custom_data:second})),/DIALPAD_CALL_ALREADY_BOUND/);
  await assert.rejects(client.query('update call_activities set operator_user_id=$1 where id=$2',[other,result.callActivityId]),/ACQUISITION_CALL_IDENTITY_CONFLICT/);
  await assert.rejects(client.query("insert into call_activities(org_id,provider,provider_call_id) values($1,'jitter','123')",[org]),/dialpad_call_identity_check/);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[rep]);
  await client.query('set role authenticated');
  const refs=(await client.query('select fn_get_acquisition_call_references($1,$2,$3) result',[org,lead,rep])).rows[0].result;
  assert.equal(refs[0].source,'dialpad');
  const finalize={orgId:org,propertyId:lead,source:'dialpad',callActivityId:result.callActivityId,idempotencyKey:randomUUID(),outcome:'reached'};
  await client.query('select fn_finalize_acquisition_attempt($1)',[finalize]);await client.query('reset role');
  await apply(intent,terminal);
  assert.equal((await client.query('select outcome from acquisition_attempts')).rows[0].outcome,'reached');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);await client.query('set role authenticated');
  await assert.rejects(client.query('select fn_finalize_acquisition_attempt($1)',[{...finalize,idempotencyKey:randomUUID()}]),/PROVIDER_EVIDENCE_PENDING/);await client.query('reset role');
  // Delayed original-episode evidence cannot credit the new owner's episode.
  const delayedIntent=await makeIntent();const delayedStart=Date.now();const newEpisode=randomUUID();
  await client.query("update acquisition_assignment_episodes set ended_at=to_timestamp($2::double precision/1000)+interval '1 second' where id=$1",[episode,delayedStart]);
  await client.query('update properties set assigned_user_id=$2 where id=$1',[lead,other]);
  const actualNewEpisode=(await client.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[lead])).rows[0].id;
  await apply(delayedIntent,await receipt({...payload,call_id:'9007199254740995',custom_data:delayedIntent,date_started:delayedStart,event_timestamp:delayedStart}));
  assert.equal((await client.query('select first_call_started_at from acquisition_assignment_episodes where id=$1',[actualNewEpisode])).rows[0].first_call_started_at,null);
  const manual=await client.query(`insert into acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,idempotency_key) values($1,$2,$3,'call','dialpad','no_answer',now(),$4) returning id`,[org,lead,rep,randomUUID()]);assert.ok(manual.rows[0].id);
  await assert.rejects(client.query(`insert into acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,idempotency_key) values($1,$2,$3,'call','dialpad',now(),$4)`,[org,lead,rep,randomUUID()]),/pending_outcome_check/);
  const foreignOrg=randomUUID();await client.query('insert into organizations values($1)',[foreignOrg]);
  await client.query('insert into dialpad_voice_event_inbox(org_id,envelope_sha256,payload) values($1,$2,$3)',[foreignOrg,'f'.repeat(64),{}]);
  await client.query('set role service_role');
  const claimed=(await client.query('select * from fn_claim_dialpad_voice_events($1,1,10)',[org])).rows;assert.equal(claimed.length,1);assert.equal(claimed[0].attempt_count,1);assert.ok(claimed[0].lease_token);
  const again=(await client.query('select * from fn_claim_dialpad_voice_events($1,100,10)',[org])).rows;assert.ok(again.every(r=>r.id!==claimed[0].id));
  await client.query('update dialpad_voice_event_inbox set lease_expires_at=now()-interval \'1 second\' where id=$1',[claimed[0].id]);
  const reclaimed=(await client.query('select * from fn_claim_dialpad_voice_events($1,1,10)',[org])).rows;assert.equal(reclaimed[0].id,claimed[0].id);assert.notEqual(reclaimed[0].lease_token,claimed[0].lease_token);assert.equal(reclaimed[0].attempt_count,2);
  await client.query('reset role');
  assert.equal((await client.query('select status from dialpad_voice_event_inbox where org_id=$1',[foreignOrg])).rows[0].status,'pending');
  const jitterToken=randomUUID();const jitterHash=createHash('sha256').update(jitterToken).digest('hex');
  const jitterBinding=(await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4) result',[org,lead,rep,jitterHash])).rows[0].result;
  const jitterEvidence={orgId:org,propertyId:lead,actorUserId:rep,assignmentEpisodeId:jitterBinding.assignmentEpisodeId,occurredAt:new Date().toISOString(),tokenHash:jitterHash,evidence:'seller_call_create_succeeded',eventVersion:1,jitterCallId:'jitter-regression',sellerProviderCallId:'jitter-seller-regression'};
  const jitterResult=(await client.query('select fn_record_acquisition_call_start($1) result',[jitterEvidence])).rows[0].result;
  assert.equal(jitterResult.ok,true);
  assert.equal((await client.query('select source from acquisition_attempts where id=$1',[jitterResult.attemptId])).rows[0].source,'sandra');
  console.log('PASS: Dialpad evidence, immutable attribution, replay enrichment, finalization, reassignment, manual compatibility, leases (real disposable PostgreSQL).');
} finally {
  if(client)await client.end();
  if(started)execFileSync(path.join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{stdio:'pipe'});
  rmSync(dir,{recursive:true,force:true});
}
