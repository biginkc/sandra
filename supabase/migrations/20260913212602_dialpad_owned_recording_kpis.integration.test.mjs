// Disposable Postgres component proof; fixture relation shapes, not full migration replay.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Dialpad KPI requires complete private owned recording manifest; legacy semantics unchanged', () => {
  const cluster=mkdtempSync(join(tmpdir(),'dialpad-kpi-pg-'));
  const socket=mkdtempSync('/tmp/dpkpi-sock-');
  const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const sql=q=>run('psql',['-h',socket,'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',q]).trim();
  let started=false;
  try {
    run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
    run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -c listen_addresses=''`,'-w','start']);started=true;
    sql(`create role anon; create role authenticated; create role service_role; create schema storage;
      create table storage.buckets(id text primary key,public boolean);
      create table dialpad_voice_intents(id uuid,org_id uuid,provider_call_id text,dialpad_user_id text,caller_id_e164 text,destination_e164 text);
      create table dialpad_voice_event_inbox(org_id uuid,payload jsonb);
      create table dialpad_recording_artifacts(id uuid,org_id uuid,provider_call_id text,provider_recording_id text,status text,verified_at timestamptz,
        byte_count bigint,decoded_duration_seconds numeric,content_sha256 text,media_type text,storage_bucket text,storage_path text);
      create table acquisition_attempts(org_id uuid,property_id uuid,actor_user_id uuid,occurred_at timestamptz,outcome text,recording_url text,attempt_kind text,call_activity_id uuid);
      create table acquisition_offers(org_id uuid,actor_user_id uuid,sent_at timestamptz);
      create table call_activities(id uuid,org_id uuid,property_id uuid,provider text,provider_call_id text,recording_expected boolean,provider_ended_at timestamptz,ended_at timestamptz,recording_path text,talk_duration_seconds integer);
      create table call_recordings(call_activity_id uuid,status text,storage_path text);
      create table tasks(id uuid,org_id uuid,related_property_id uuid,type text,status text,due_at timestamptz,snoozed_until timestamptz,assignee_id uuid,outcome text);
      create table acquisition_assignment_episodes(org_id uuid,assignee_user_id uuid,eligible boolean,episode_kind text,assigned_at timestamptz,first_call_started_at timestamptz);
      create table acquisition_appointment_attribution(org_id uuid,task_id uuid,accountable_user_id uuid);
      create function my_leads_require_read_scope(uuid,uuid) returns void language plpgsql as $$ begin return; end $$;
      create function my_leads_queue_rows(uuid,uuid,timestamptz) returns table(stage text,property_id uuid,warning_rank integer) language sql as $$ select null::text,null::uuid,0 where false $$;`);
    const migration=readFileSync(new URL('./20260913212602_dialpad_owned_recording_kpis.sql',import.meta.url),'utf8');
    sql(migration);
    sql(readFileSync(new URL('./20260913214109_dialpad_recording_completeness_read.sql',import.meta.url),'utf8'));
    const org=randomUUID(),other=randomUUID(),rep=randomUUID(),property=randomUUID(),call=randomUUID(),intent=randomUUID();
    const callId='12345', hash='b'.repeat(64);
    sql(`insert into storage.buckets values('private',false),('public',true);
      insert into dialpad_voice_intents values('${intent}','${org}','${callId}','456','+18165550101','+18165550102');
      insert into call_activities values('${call}','${org}','${property}','dialpad','${callId}',true,now()-interval '10 minutes',now()-interval '10 minutes','https://external.test/audio',301);
      insert into acquisition_attempts values('${org}','${property}','${rep}',now()-interval '20 minutes','reached','https://external.test/audio','call','${call}');
      insert into call_recordings values('${call}','available','external-provider-path');`);
    const kpis=()=>JSON.parse(sql(`select fn_get_acquisition_kpis('${org}','${rep}',now()-interval '1 day',now()+interval '1 hour')`));
    const missing=n=>assert.equal(kpis().missingRecordings,n);
    const complete=()=>sql(`select dialpad_has_complete_owned_recording('${org}','${callId}')`);
    missing(1); // Neither external link nor legacy available child can pass.
    assert.equal(complete(),'f');
    const payload={state:'recording',call_id:callId,direction:'outbound',custom_data:intent,target:{type:'User',id:'456'},internal_number:'+18165550101',external_number:'+18165550102',recording_details:[{id:'one'},{id:'two'}]};
    const putManifest=(p=payload,o=org)=>sql(`insert into dialpad_voice_event_inbox values('${o}','${JSON.stringify(p)}')`);
    putManifest({...payload,recording_details:[]});missing(1);
    const absentDetails={...payload};delete absentDetails.recording_details;putManifest(absentDetails);missing(1);
    putManifest();
    function artifact(segment,o=org) {
      const id=randomUUID(),path=`${o}/${callId}/${id}/${hash}.mp3`;
      sql(`insert into dialpad_recording_artifacts values('${id}','${o}','${callId}','${segment}','available',now(),100,10,'${hash}','audio/mpeg','private','${path}')`);
      return id;
    }
    const one=artifact('one');missing(1);assert.equal(complete(),'f');
    const two=artifact('two');missing(0);assert.equal(complete(),'t'); assert.match(sql(`set role service_role;select fn_dialpad_recording_complete('${org}','${callId}')`), /t$/); // Recovers despite earlier empty/absent details.
    assert.equal(kpis().attempts,1);assert.equal(kpis().reached,1);assert.equal(kpis().averageTalkSeconds,301);assert.equal(kpis().conversationsOverFiveMinutes,1);
    sql(`update dialpad_recording_artifacts set status='denied' where id='${two}'`);missing(1);
    sql(`update dialpad_recording_artifacts set status='available',storage_bucket='public' where id='${two}'`);missing(1);
    sql(`update dialpad_recording_artifacts set storage_bucket='private' where id='${two}'`);missing(0);
    sql(`update storage.buckets set public=true where id='private'`);missing(1);
    sql(`update storage.buckets set public=false where id='private'`);missing(0);
    for(const patch of ["verified_at=null","byte_count=0","decoded_duration_seconds='NaN'","storage_path='https://external.test/audio'","content_sha256='bad'"]) {
      assert.match(sql('begin;'+`update dialpad_recording_artifacts set ${patch} where id='${one}';`+`select dialpad_has_complete_owned_recording('${org}','${callId}');rollback;`), /\nf\n/);
    }
    sql(`delete from dialpad_recording_artifacts where id='${two}'`);artifact('two',other);missing(1);
    artifact('two');missing(0);
    assert.equal(sql(`select dialpad_has_complete_owned_recording('${other}','${callId}')`),'f');
    // Late previously unknown segment invalidates earlier completeness until owned.
    putManifest({...payload,recording_details:[{id:'one'},{id:'two'},{id:'three'}]});missing(1);
    artifact('three');missing(0);
    sql('delete from dialpad_voice_event_inbox');missing(1);
    putManifest({...payload,target:{type:'user',id:'999'}});missing(1);
    putManifest(payload,other);missing(1);
    putManifest({...payload,recording_details:[]});missing(1);
    sql('delete from dialpad_voice_event_inbox');putManifest({...payload,recording_details:[{id:'one'},{}]});missing(1);
    sql('delete from dialpad_voice_event_inbox');putManifest();missing(0);
    // Existing providers retain all three legacy availability alternatives.
    sql(`update call_activities set provider='jitter'`);missing(0);
    sql(`update call_activities set recording_path=null;update acquisition_attempts set recording_url=null`);missing(0);
    sql('delete from call_recordings');missing(1);
    sql(`update acquisition_attempts set recording_url='https://legacy.test/audio'`);missing(0);
    sql(`update acquisition_attempts set recording_url=null;update call_activities set recording_path='legacy/path'`);missing(0);
    sql(`update call_activities set recording_path=null,recording_expected=null`);missing(0);assert.equal(kpis().recordingExpectationUnknown,1);
    // Daily clock is call-only, Chicago-today, and independent of reporting bounds.
    sql(`delete from acquisition_attempts;
      insert into acquisition_attempts(org_id,actor_user_id,occurred_at,attempt_kind)
      values('${org}','${rep}',(date_trunc('day',now() at time zone 'America/Chicago') at time zone 'America/Chicago')-interval '1 second','call'),
        ('${org}','${rep}',now(),'sms');`);
    const historicalKpis=()=>JSON.parse(sql(`select fn_get_acquisition_kpis('${org}','${rep}',now()-interval '30 days',now()-interval '2 days')`));
    assert.equal(historicalKpis().lastAttemptAt,null);
    sql(`insert into acquisition_attempts(org_id,actor_user_id,occurred_at,attempt_kind)
      values('${org}','${rep}',date_trunc('day',now() at time zone 'America/Chicago') at time zone 'America/Chicago','call');`);
    const daily=historicalKpis();
    const today=Number(sql(`select extract(epoch from (date_trunc('day',now() at time zone 'America/Chicago') at time zone 'America/Chicago'))*1000`));
    assert.equal(Date.parse(daily.lastAttemptAt),today);
    assert.equal(daily.lastAttemptClockVersion,1);
    assert.equal(daily.attempts,0); // Report bounds still govern reporting metrics.
    for(const role of ['anon','authenticated','service_role']) assert.equal(sql(`select has_function_privilege('${role}','public.dialpad_has_complete_owned_recording(uuid,text)','EXECUTE')`),'f');
    for (const role of ['anon','authenticated']) assert.equal(sql(`select has_function_privilege('${role}','public.fn_dialpad_recording_complete(uuid,text)','EXECUTE')`),'f');
    assert.equal(sql(`select has_function_privilege('authenticated','public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz)','EXECUTE')`),'t');
  } finally {
    if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
    rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
  }
});
