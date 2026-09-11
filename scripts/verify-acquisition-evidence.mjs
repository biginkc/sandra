/** Component SQL proof with minimal source fixtures, not full deployment rehearsal. Isolated PG17 proof. Creates only a private local socket/database, never a hosted target. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
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
    create role anon; create role authenticated; create role service_role;
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
    await client.query(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  }
  const org='10000000-0000-4000-8000-000000000001';
  const owner='10000000-0000-4000-8000-000000000002';
  const rep='10000000-0000-4000-8000-000000000003';
  const lead='10000000-0000-4000-8000-000000000004';
  await client.query('insert into organizations values($1)',[org]);
  await client.query('insert into auth.users(id) values($1),($2)',[owner,rep]);
  await client.query("insert into memberships(org_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",[org,owner,rep]);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await client.query('select fn_set_acquisition_designation($1,$2,true,false,extensions.gen_random_uuid())',[org,rep]);
  await client.query('select fn_set_acquisition_designation($1,$2,true,false,extensions.gen_random_uuid())',[org,owner]);
  await client.query('insert into acquisition_org_settings(org_id,my_leads_enabled) values($1,true)',[org]);
  await client.query("insert into properties(id,org_id,assigned_user_id,address) values($1,$2,$3,'Owned test lead')",[lead,org,rep]);
  const token='a'.repeat(64);
  const {rows:[binding]}=await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4) as fact',[org,lead,rep,token]);
  assert.equal(binding.fact.tracked,true);
  assert.equal((await client.query('select count(*)::int as n from acquisition_attempts')).rows[0].n,0);
  const occurredAt=(await client.query('select clock_timestamp()::text as at')).rows[0].at;
  await client.query('update properties set assigned_user_id=$1 where id=$2',[owner,lead]);
  const event={eventId:'10000000-0000-4000-8000-000000000005',eventVersion:1,orgId:org,propertyId:lead,actorUserId:rep,
    assignmentEpisodeId:binding.fact.assignmentEpisodeId,tokenHash:token,jitterCallId:'jitter-owned',sellerProviderCallId:'seller-owned',
    occurredAt,evidence:'seller_call_create_succeeded'};
  const apply=()=>client.query('select fn_record_acquisition_call_start($1::jsonb) as fact',[event]);
  const result=(await apply()).rows[0].fact;
  assert.equal(result.ok,true);
  assert.equal((await apply()).rows[0].fact.duplicate,true);
  assert.equal((await client.query('select count(*)::int as n from acquisition_attempts')).rows[0].n,1);
  const episodes=(await client.query('select assignee_user_id,first_call_started_at,ended_at from acquisition_assignment_episodes order by assigned_at')).rows;
  assert.equal(episodes.length,2);
  assert.equal(episodes[0].assignee_user_id,rep);
  assert.ok(episodes[0].first_call_started_at);
  assert.equal(episodes[1].first_call_started_at,null);
  assert.equal((await client.query('select count(*)::int as n from acquisition_queue_states')).rows[0].n,0);
  await assert.rejects(client.query('select fn_record_acquisition_call_start($1::jsonb)',[{...event,actorUserId:owner}]),e=>e.code==='42501');
  await client.query('grant usage on schema public,auth to authenticated');
  await client.query('grant execute on function auth.uid() to authenticated');
  await client.query('set role authenticated');
  await assert.rejects(client.query('select fn_record_acquisition_call_start($1::jsonb)',[event]),e=>e.code==='42501');
  const page=(await client.query('select fn_get_acquisition_queue_page($1,$2) as fact',[org,owner])).rows[0].fact;
  assert.equal(page.stages.not_contacted.rows.length,1);
  assert.equal(Object.keys(page.stages).length,5);
  await client.query('reset role');
  await client.query("insert into properties(id,org_id,assigned_user_id,address,status) values(extensions.gen_random_uuid(),$1,$2,'Second owned lead','new_lead'),(extensions.gen_random_uuid(),$1,$2,'Signed owned lead','under_contract')",[org,owner]);
  await client.query('set role authenticated');
  const first=(await client.query("select fn_get_acquisition_queue_page($1,$2,'',null,null,1) as fact",[org,owner])).rows[0].fact;
  const cursor=first.stages.not_contacted.cursor;
  assert.ok(cursor);
  assert.equal(first.stages.under_contract.rows.length,1);
  assert.equal(first.stages.not_contacted.totalCount,2);
  const second=(await client.query("select fn_get_acquisition_queue_page($1,$2,'','not_contacted',$3,1) as fact",[org,owner,cursor])).rows[0].fact;
  assert.equal(second.snapshotAt,first.snapshotAt);
  assert.notEqual(second.stages.not_contacted.rows[0].propertyId,first.stages.not_contacted.rows[0].propertyId);
  await assert.rejects(client.query("select fn_get_acquisition_queue_page($1,$2,'changed','not_contacted',$3,1)",[org,owner,cursor]),e=>e.code==='22023');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[rep]);
  await assert.rejects(client.query('select fn_get_acquisition_queue_page($1,$2)',[org,owner]),e=>e.code==='42501');
  await assert.rejects(client.query("select fn_get_acquisition_queue_page($1,$2,'','not_contacted',$3,1)",[org,rep,cursor]),e=>e.code==='22023');
  await client.query('reset role');
  const appointment='10000000-0000-4000-8000-000000000006';
  await client.query("insert into tasks(id,org_id,related_property_id,type,status,due_at,assignee_id) values($1,$2,$3,'appointment','open',now(),$4)",[appointment,org,lead,rep]);
  await client.query("update tasks set assignee_id=$1,status='completed',outcome='held' where id=$2",[owner,appointment]);
  const appointmentFact=(await client.query("select fact from public.my_leads_detail_rows($1,$2,'appointments') where id=$3",[org,lead,appointment])).rows[0].fact;
  assert.equal(appointmentFact.actorId,rep,'appointment detail retains booking-time actor after task reassignment');
  assert.equal(appointmentFact.currentAssigneeId,owner,'lifecycle action retains current assignee independently of credit');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await client.query('set role authenticated');
  const repKpis=(await client.query("select fn_get_acquisition_kpis($1,$2,now()-interval '1 day',now()+interval '1 day') as fact",[org,rep])).rows[0].fact;
  assert.equal(repKpis.attempts,1);
  assert.equal(repKpis.firstCallSamples,1);
  assert.equal(repKpis.appointmentsDue,1);
  assert.equal(repKpis.appointmentsHeld,1);
  await client.query('reset role');
  await client.query("insert into tasks(id,org_id,related_property_id,type,status,outcome,due_at,assignee_id) values(extensions.gen_random_uuid(),$1,$2,'appointment','completed','rescheduled',now(),$3)",[org,lead,rep]);
  await client.query('set role authenticated');
  const afterReschedule=(await client.query("select fn_get_acquisition_kpis($1,$2,now()-interval '1 day',now()+interval '1 day') as fact",[org,rep])).rows[0].fact;
  assert.equal(afterReschedule.appointmentsDue,1,'reschedule predecessors must not inflate the canonical appointment denominator');
  const ownerKpis=(await client.query("select fn_get_acquisition_kpis($1,$2,now()-interval '1 day',now()+interval '1 day') as fact",[org,owner])).rows[0].fact;
  assert.equal(ownerKpis.attempts,0);
  assert.equal(ownerKpis.appointmentsDue,0);
  await client.query('reset role');
  const currentEpisode=(await client.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[lead])).rows[0].id;
  const manual={propertyId:lead,expectedEpisodeId:currentEpisode,expectedQueueVersion:0,expectedSharedStatus:'new_lead',
    idempotencyKey:'10000000-0000-4000-8000-000000000007',source:'manual',kind:'outreach',outcome:'no_answer',
    occurredAt:(await client.query('select clock_timestamp()::text as at')).rows[0].at};
  await client.query('set role authenticated');
  const logged=(await client.query('select fn_log_acquisition_attempt($1::jsonb) as fact',[manual])).rows[0].fact;
  assert.equal(logged.stage,'contacted');
  assert.equal((await client.query('select fn_log_acquisition_attempt($1::jsonb) as fact',[manual])).rows[0].fact.duplicate,true);
  await client.query('reset role');
  assert.equal((await client.query('select first_call_started_at from acquisition_assignment_episodes where id=$1',[currentEpisode])).rows[0].first_call_started_at,null);
  const externalCall={...manual,expectedQueueVersion:logged.queueVersion,expectedSharedStatus:'contacted',source:'dialpad',kind:'call',
    idempotencyKey:'10000000-0000-4000-8000-000000000008',occurredAt:(await client.query('select clock_timestamp()::text as at')).rows[0].at};
  await client.query('set role authenticated');
  await client.query('select fn_log_acquisition_attempt($1::jsonb)',[externalCall]);
  await assert.rejects(client.query('select fn_log_acquisition_attempt($1::jsonb)',[{...externalCall,source:'sandra'}]),e=>e.code==='22023');
  await client.query('reset role');
  assert.ok((await client.query('select first_call_started_at from acquisition_assignment_episodes where id=$1',[currentEpisode])).rows[0].first_call_started_at);
  assert.equal((await client.query('select recording_url from acquisition_attempts where idempotency_key=$1',[externalCall.idempotencyKey])).rows[0].recording_url,null);
  // Wrap-up after seller evidence attaches facts without another attempt or reassignment.
  const beforeCount=(await client.query('select count(*)::int n from acquisition_attempts')).rows[0].n;
  const activity='10000000-0000-4000-8000-000000000009';
  await client.query("insert into call_activities values($1,$2,$3,'sandra_softphone','sandra-jitter-owned',$4,'connected_human','Owned call note','wrong-seller')",[activity,lead,org,rep]);
  assert.equal((await client.query('select call_activity_id from acquisition_attempts where provider_attempt_key=$1',[token])).rows[0].call_activity_id,null);
  await client.query("update call_activities set provider_call_id='seller-owned',operator_user_id=null where id=$1",[activity]);
  assert.equal((await client.query('select call_activity_id from acquisition_attempts where provider_attempt_key=$1',[token])).rows[0].call_activity_id,null);
  await client.query('update call_activities set operator_user_id=$1 where id=$2',[rep,activity]);
  let reconciled=(await client.query('select * from acquisition_attempts where provider_attempt_key=$1',[token])).rows[0];
  assert.equal(reconciled.call_activity_id,activity);assert.equal(reconciled.outcome,'reached');assert.equal(reconciled.actor_user_id,rep);
  assert.equal((await client.query('select count(*)::int n from acquisition_attempts')).rows[0].n,beforeCount);
  await assert.rejects(client.query("update call_activities set provider_call_id='conflicting-seller' where id=$1",[activity]),e=>e.code==='23514');
  // Retry cannot erase a specific outcome with a generic transport failure.
  await client.query("update call_activities set outcome='failed' where id=$1",[activity]);
  assert.equal((await client.query('select outcome from acquisition_attempts where provider_attempt_key=$1',[token])).rows[0].outcome,'reached');
  const token2='b'.repeat(64);
  const binding2=(await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4) fact',[org,lead,owner,token2])).rows[0].fact;
  await client.query("insert into call_activities values(extensions.gen_random_uuid(),$1,$2,'sandra_softphone','sandra-jitter-second',$3,'no_answer','Earlier writeback','seller-second')",[lead,org,owner]);
  await client.query('select fn_record_acquisition_call_start($1::jsonb)',[{...event,eventId:'10000000-0000-4000-8000-000000000010',actorUserId:owner,assignmentEpisodeId:binding2.assignmentEpisodeId,tokenHash:token2,jitterCallId:'jitter-second',sellerProviderCallId:'seller-second',occurredAt:(await client.query('select clock_timestamp()::text at')).rows[0].at}]);
  reconciled=(await client.query('select * from acquisition_attempts where provider_attempt_key=$1',[token2])).rows[0];
  assert.ok(reconciled.call_activity_id);assert.equal(reconciled.outcome,'no_answer');
  const finalize={orgId:org,propertyId:lead,callActivityId:activity,outcome:'reached',idempotencyKey:'10000000-0000-4000-8000-000000000011'};
  await client.query('set role authenticated');
  await assert.rejects(client.query('select fn_finalize_acquisition_attempt($1::jsonb)',[finalize]),e=>e.code==='42501');
  await client.query('reset role');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[rep]);
  await client.query('set role authenticated');
  assert.equal((await client.query('select fn_finalize_acquisition_attempt($1::jsonb) fact',[finalize])).rows[0].fact.ok,true);
  assert.equal((await client.query('select fn_finalize_acquisition_attempt($1::jsonb) fact',[finalize])).rows[0].fact.duplicate,true);
  await assert.rejects(client.query('select fn_finalize_acquisition_attempt($1::jsonb)',[{...finalize,outcome:'wrong_number'}]),e=>e.code==='40001');
  await client.query('reset role');
  // A bind blocked behind reassignment observes the newly committed episode.
  const peer=new pg.Client({host:dir,user:'postgres',database:'postgres'});
  await peer.connect();
  try {
    const peerPid=(await peer.query('select pg_backend_pid() pid')).rows[0].pid;
    await client.query('begin');
    await client.query('update properties set assigned_user_id=$1 where id=$2',[rep,lead]);
    const pending=peer.query('select fn_bind_acquisition_call_context($1,$2,$3,$4) fact',[org,lead,rep,'c'.repeat(64)]);
    let observedLock=false;
    for(let i=0;i<100;i++) {
      const state=(await client.query('select wait_event_type from pg_stat_activity where pid=$1',[peerPid])).rows[0];
      if(state?.wait_event_type==='Lock'){observedLock=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
      await client.query('select pg_stat_clear_snapshot()');
    }
    assert.equal(observedLock,true,'concurrent bind must wait for the reassignment lock');
    await client.query('commit');
    const bound=(await pending).rows[0].fact;
    const current=(await client.query('select id,assignee_user_id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[lead])).rows[0];
    assert.equal(bound.assignmentEpisodeId,current.id);assert.equal(current.assignee_user_id,rep);
  } finally {await client.query('rollback');await peer.end();}
  // Independent aggregate oracle: raw stored facts reduced in JS, not the KPI
  // projection or its SQL aggregates. Give the current rep one known stale lead.
  await client.query("insert into acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values($1,$2,'contacted',now()) on conflict(property_id,org_id) do update set stage='contacted',archived_at=null",[lead,org]);
  const start=new Date(Date.now()-86400000),end=new Date(Date.now()+86400000);
  const inRange=at=>at && new Date(at)>=start && new Date(at)<end;
  const attempts=(await client.query('select * from acquisition_attempts')).rows;
  const assignmentFacts=(await client.query('select * from acquisition_assignment_episodes')).rows;
  const offers=(await client.query('select * from acquisition_offers')).rows;
  const tasks=(await client.query('select * from tasks')).rows;
  const attribution=(await client.query('select * from acquisition_appointment_attribution')).rows;
  for(const member of [rep,owner]) {
    const a=attempts.filter(r=>r.org_id===org&&r.actor_user_id===member&&inRange(r.occurred_at));
    const e=assignmentFacts.filter(r=>r.org_id===org&&r.assignee_user_id===member&&r.eligible&&r.episode_kind==='live'&&inRange(r.assigned_at));
    const completed=e.filter(r=>r.first_call_started_at);
    const due=tasks.filter(t=>t.org_id===org&&t.type==='appointment'&&t.related_property_id&&t.status!=='cancelled'&&t.outcome!=='rescheduled'&&inRange(t.due_at));
    const credited=due.filter(t=>attribution.some(a=>a.task_id===t.id&&a.org_id===org&&a.accountable_user_id===member));
    const expected={attempts:a.length,reached:a.filter(r=>r.outcome==='reached').length,pendingOutcomes:a.filter(r=>r.outcome===null).length,
      firstCallSamples:completed.length,firstCallPending:e.length-completed.length,
      appointmentsDue:credited.length,appointmentsHeld:credited.filter(t=>t.outcome==='held').length,
      orgAppointmentsUnattributed:due.filter(t=>!attribution.some(a=>a.task_id===t.id&&a.org_id===org)).length,
      offersSent:offers.filter(r=>r.org_id===org&&r.actor_user_id===member&&inRange(r.sent_at)).length,
      staleLeads:member===rep?1:0};
    const seconds=completed.length?completed.reduce((sum,r)=>sum+(new Date(r.first_call_started_at)-new Date(r.assigned_at))/1000,0)/completed.length:null;
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await client.query('set role authenticated');
    const viewed=(await client.query('select fn_get_acquisition_kpis($1,$2,$3,$4) fact',[org,member,start,end])).rows[0].fact;
    for(const [key,value] of Object.entries(expected))assert.equal(viewed[key],value,`independent ${member} ${key}`);
    if(seconds===null)assert.equal(viewed.firstCallElapsedSeconds,null);
    else assert.ok(Math.abs(viewed.firstCallElapsedSeconds-seconds)<0.002,'elapsed mean matches raw timestamps');
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);
    const self=(await client.query('select fn_get_acquisition_kpis($1,$2,$3,$4) fact',[org,member,start,end])).rows[0].fact;
    assert.deepEqual(self,viewed,'owner and member get identical KPIs for the same rep and range');
    const historical=(await client.query("select fn_get_acquisition_kpis($1,$2,'2000-01-01','2000-01-02') fact",[org,member])).rows[0].fact;
    assert.equal(historical.attempts,0);assert.equal(historical.staleLeads,expected.staleLeads,'current distinct stale count ignores reporting period');
    await client.query('reset role');
  }
  console.log('PASS: independent raw-fact KPI aggregate, owner/self equality, period-independent distinct stale count');
  console.log('PASS: call reconciliation in both arrival orders, immutable performer, retry, no duplicate attempts');
  console.log('PASS: isolated PG17 fixture; migrations; bind without attempt; late-call attribution; replay; new-owner clock/stage preserved; service-only grant; five-stage read; cursor continuation/filter/viewer binding; member scope; original-rep appointment and call KPIs; manual outreach/call clock separation; optional recording');

} finally {
  await client?.end();
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
}
