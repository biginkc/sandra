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
  await client.query(readFileSync(new URL('./20260913212423_dialpad_active_intent_guard.sql',import.meta.url),'utf8'));
  const org=randomUUID(),rep=randomUUID(),other=randomUUID(),lead=randomUUID();
  await client.query('insert into organizations values($1)',[org]);
  await client.query('insert into auth.users(id) values($1),($2)',[rep,other]);
  await client.query("insert into memberships(org_id,user_id,role) values($1,$2,'member'),($1,$3,'owner')",[org,rep,other]);
  await client.query('insert into acquisition_org_settings(org_id,my_leads_enabled) values($1,true)',[org]);
  await client.query("insert into properties(id,org_id,assigned_user_id,status) values($1,$2,$3,'new_lead')",[lead,org,rep]);
  const makeIntent=async(actor=rep)=>{
    const id=randomUUID(),hash=createHash('sha256').update(id).digest('hex');
    const binding=(await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4) result',[org,lead,actor,hash])).rows[0].result;
    await client.query(`insert into dialpad_voice_intents(id,org_id,actor_user_id,property_id,assignment_episode_id,binding_token_hash,dialpad_user_id,destination_e164,caller_id_e164,client_idempotency_key) values($1,$2,$3,$4,$5,$6,'4904023124647936','+18165550101','+18165550102',$1)`,[id,org,actor,lead,binding.assignmentEpisodeId,hash]);
    return id;
  };
  await client.query(`create table sequence_enrollments(id uuid primary key default extensions.gen_random_uuid(),org_id uuid,property_id uuid,sequence_id uuid,status text,pause_reason text,next_run_at timestamptz,updated_at timestamptz default now());
    create table lead_events(id uuid default extensions.gen_random_uuid(),org_id uuid,property_id uuid,actor_type text,actor_id uuid,event_type text,payload jsonb,source_type text,source_id uuid,unique(source_type,source_id));`);
  await client.query(readFileSync(new URL('./20260913213319_dialpad_sequence_pause_ownership.sql',import.meta.url),'utf8'));
  const invoke=async(name,id,status)=>{
    await client.query('set role service_role');try {
      const args=status===undefined?[id]:[id,status];
      return (await client.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
    }finally{await client.query('reset role');}
  };
  const enroll=async(status='active',reason=null)=>{
    const id=randomUUID();await client.query("insert into sequence_enrollments(id,org_id,property_id,sequence_id,status,pause_reason,next_run_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour')",[id,org,lead,randomUUID(),status,reason]);return id;
  };
  const e=await enroll(),manual=await enroll('paused','manual');
  const schedule=(await client.query('select next_run_at from sequence_enrollments where id=$1',[e])).rows[0].next_run_at;
  const first=await makeIntent();
  assert.equal((await invoke('fn_prepare_dialpad_sequence_pause',first)).paused,1);
  assert.equal((await invoke('fn_prepare_dialpad_sequence_pause',first)).paused,1);
  assert.equal((await client.query("select count(*)::int n from lead_events where event_type='sequence_paused'")).rows[0].n,1);
  assert.equal((await invoke('fn_dispatch_dialpad_intent',first)).dispatched,true);
  assert.equal((await invoke('fn_dispatch_dialpad_intent',first)).dispatched,false);
  for(const status of [null,429,500])await assert.rejects(invoke('fn_release_dialpad_start',first,status),/DIALPAD_RELEASE_EVIDENCE_REQUIRED/);
  assert.equal((await invoke('fn_release_dialpad_start',first,422)).resumed,1);
  assert.equal((await invoke('fn_release_dialpad_start',first,422)).resumed,0);
  assert.equal((await client.query('select status from dialpad_voice_intents where id=$1',[first])).rows[0].status,'failed');
  assert.equal((await client.query('select next_run_at from sequence_enrollments where id=$1',[e])).rows[0].next_run_at.getTime(),schedule.getTime());
  assert.equal((await client.query('select pause_reason from sequence_enrollments where id=$1',[manual])).rows[0].pause_reason,'manual');
  // Even a reverted edit changes revision, so old ownership cannot resume it.
  const second=await makeIntent();await invoke('fn_prepare_dialpad_sequence_pause',second);
  await client.query("update sequence_enrollments set pause_reason='manual' where id=$1",[e]);
  await client.query("update sequence_enrollments set pause_reason='call_in_progress' where id=$1",[e]);
  assert.equal((await invoke('fn_release_dialpad_start',second,null)).resumed,0);
  const opted=await enroll(),completed=await enroll();
  const third=await makeIntent();await invoke('fn_prepare_dialpad_sequence_pause',third);
  await client.query("update sequence_enrollments set status='opted_out' where id=$1",[opted]);
  await client.query("update sequence_enrollments set status='completed' where id=$1",[completed]);
  assert.equal((await invoke('fn_release_dialpad_start',third,null)).resumed,0);
  const peerRow=await enroll();const fourth=await makeIntent();await invoke('fn_prepare_dialpad_sequence_pause',fourth);
  const peer=await makeIntent(other);await assert.rejects(invoke('fn_prepare_dialpad_sequence_pause',peer),/DIALPAD_START_ELIGIBILITY_CHANGED/);
  assert.equal((await invoke('fn_release_dialpad_start',fourth,null)).resumed,0);
  assert.equal((await invoke('fn_release_dialpad_start',peer,null)).resumed,0);
  assert.equal((await client.query('select status from sequence_enrollments where id=$1',[peerRow])).rows[0].status,'paused');
  const unprepared=await makeIntent();assert.equal((await invoke('fn_dispatch_dialpad_intent',unprepared)).dispatched,false);
  assert.equal((await invoke('fn_release_dialpad_start',unprepared,null)).released,true);
  const changed=await makeIntent();await invoke('fn_prepare_dialpad_sequence_pause',changed);
  await client.query('update properties set assigned_user_id=$2 where id=$1',[lead,other]);
  await assert.rejects(invoke('fn_dispatch_dialpad_intent',changed),/DIALPAD_START_ELIGIBILITY_CHANGED/);
  assert.equal((await invoke('fn_release_dialpad_start',changed,null)).released,true);
  await client.query('set role authenticated');await assert.rejects(client.query('select fn_prepare_dialpad_sequence_pause($1)',[unprepared]),/permission denied/);await client.query('reset role');
  console.log('PASS: owned sequence pause, dispatch CAS, definitive release, schedule, audit, revisions, opt-out and peer-call protection (real disposable PostgreSQL).');
} finally {
  if(client)await client.end();
  if(started)execFileSync(path.join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{stdio:'pipe'});
  rmSync(dir,{recursive:true,force:true});
}
