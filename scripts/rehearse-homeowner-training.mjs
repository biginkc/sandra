#!/usr/bin/env node
// Disposable local PostgreSQL only. Exercises the actual migration and existing
// provider enrichment function; never reads hosted credentials or contacts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster = mkdtempSync(join(tmpdir(), 'sandra-training-'));
const socket = mkdtempSync('/tmp/stsock-');
const port = 17000 + Math.floor(Math.random() * 1000);
let started = false;
const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sql = (query) => run('psql', ['-h', socket, '-p', String(port), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', query]).trim();
const source = readFileSync(new URL('../supabase/migrations/20260825010000_jitter_softphone_artifact_writeback_match.sql', import.meta.url), 'utf8');
const rpc = source.slice(source.indexOf('create or replace function public.jitter_writeback_call_activity_softphone('), source.indexOf('revoke all on function public.jitter_writeback_call_activity_softphone'));
const prefix = "select set_config('request.jwt.claim.role','service_role',false); ";
const org = '00000000-0000-0000-0000-000000000bbb';
const call = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
try {
  run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  run('pg_ctl', ['-D', cluster, '-l', join(cluster, 'server.log'), '-o', `-k ${socket} -p ${port} -h ''`, '-w', 'start']); started = true;
  sql(`create schema auth; create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create table call_activities (id uuid primary key, org_id uuid not null, property_id uuid, contact_id uuid,
      dialer_batch_item_id uuid, jitter_attempt_id text, jitter_session_id text, operator_user_id uuid,
      started_at timestamptz, ended_at timestamptz, duration_seconds integer, outcome text, disposition text,
      do_not_call_requested boolean not null default false, provider text not null, provider_call_id text,
      recording_status text, transcript_status text, error_code text, error_message text, raw_event_count integer default 0,
      notes text, recording_path text, phone_e164 text, wrap_token uuid);
    create table webhook_events (org_id uuid, provider text, event_type text, external_id text, payload jsonb,
      processing_status text, processed_at timestamptz, request_hash text);
    create table call_transcripts (id uuid default gen_random_uuid(), call_activity_id uuid unique, status text, text text, language text, error_code text, error_message text, summary text, summary_status text, summary_error_code text, summary_error_message text);
    create table properties(id uuid, org_id uuid); create table contacts(id uuid, org_id uuid);
  `);
  sql(readFileSync(new URL('../supabase/migrations/20260907120000_homeowner_training_call_purpose.sql', import.meta.url), 'utf8'));
  sql(rpc);
  sql(source.slice(source.indexOf('create or replace function public.jitter_upsert_call_transcript('), source.indexOf('revoke all on function public.jitter_upsert_call_transcript')));
  const insert = `insert into call_activities(id,org_id,jitter_attempt_id,provider,phone_e164,call_purpose) values('${call}','${org}','sandra-${call}','sandra_softphone','+18165550199','internal_training')`;
  assert.throws(() => sql(insert), /Only the server/);
  sql(prefix + insert);
  for (const change of ["property_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'", "contact_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'", "disposition='callback_requested'", 'do_not_call_requested=true', "call_purpose='customer'", "phone_e164='+18165550198'"]) {
    assert.throws(() => sql(`update call_activities set ${change} where id='${call}'`));
  }
  // Real provider RPC before wrap-up, then after wrap-up, then a later delivery.
  for (const iteration of [1, 2, 3]) {
    sql(prefix + `insert into webhook_events values('${org}','jitter','call_activity_writeback','event-${iteration}',null,'pending',null,'hash');
      select public.jitter_writeback_call_activity_softphone('sandra-${call}',
      '{"org_id":"${org}","provider":"sandra_softphone","jitter_session_id":"sandra-softphone-session-${call}:run","duration_seconds":60,"disposition":"callback_requested","do_not_call_requested":true}'::jsonb,
      null,'event-${iteration}','provider notes','${org}',null,'hash');`);
    assert.equal(sql(`select call_purpose || ':' || coalesce(property_id::text,'null') || ':' || coalesce(disposition,'null') || ':' || do_not_call_requested from call_activities`), 'internal_training:null:null:false');
    sql(`update call_activities set notes='Training wrap', wrap_token='cccccccc-cccc-4ccc-8ccc-cccccccccccc' where id='${call}'`);
  }
  sql(prefix + `insert into webhook_events values('${org}','jitter','call_transcript_writeback','transcript',null,'pending',null,'hash');
    select public.jitter_upsert_call_transcript('${call}','${org}','available','Fictional training dialogue','en',null,null,null,'none',null,null,'transcript','hash');`);
  assert.equal(sql('select text from call_transcripts'), 'Fictional training dialogue');
  assert.equal(sql('select count(*) from call_activities'), '1');
  assert.equal(sql('select raw_event_count from call_activities'), '3');
  assert.equal(sql('select notes from call_activities'), 'Training wrap');
  console.log('PASS: server-only training creation, immutable purpose/identity, customer isolation, real writeback before/after wrap, repeated delivery and transcript retention.');
} finally {
  if (started) run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
  rmSync(cluster, { recursive: true, force: true }); rmSync(socket, { recursive: true, force: true });
}
