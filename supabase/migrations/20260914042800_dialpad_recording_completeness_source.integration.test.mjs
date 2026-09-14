import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'dp-completeness-source-'));
let started = false;
const bin = process.env.PG_BIN ?? execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const run = (name, args) => execFileSync(join(bin, name), args, { encoding: 'utf8', stdio: 'pipe' });
const sql = query => run('psql', ['-h', dir, '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
const org = '11111111-1111-4111-8111-111111111111';
const intent = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const wrongConnection = '44444444-4444-4444-8444-444444444444';
const source = '55555555-5555-4555-8555-555555555555';
const wrongSource = '66666666-6666-4666-8666-666666666666';
const artifact = '77777777-7777-4777-8777-777777777777';
const hash = 'a'.repeat(64);
const event = JSON.stringify({ call_id: '123', state: 'recording', target: { id: '201', type: 'User' },
  direction: 'outbound', custom_data: intent, internal_number: '+18165550101', external_number: '+18165550102',
  recording_details: [{ id: 'segment-1' }] });
try {
  run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres']);
  run('pg_ctl', ['-D', join(dir, 'data'), '-l', join(dir, 'log'), '-o', `-k ${dir} -c listen_addresses=''`, '-w', 'start']);
  started = true;
  sql(`create schema storage;
    create table storage.buckets(id text,public boolean);
    create table dialpad_voice_event_inbox(org_id uuid,payload jsonb,status text,webhook_source_id uuid);
    create table dialpad_voice_intents(org_id uuid,id uuid,provider_call_id text,dialpad_user_id text,caller_id_e164 text,destination_e164 text);
    create table dialpad_intent_configuration(org_id uuid,intent_id uuid,connection_id uuid,connection_version bigint);
    create table dialpad_connection_revisions(org_id uuid,connection_id uuid,config_version bigint,provider_company_id text);
    create table dialpad_voice_webhook_sources(org_id uuid,id uuid,connection_id uuid,connection_version bigint);
    create table dialpad_recording_artifacts(org_id uuid,provider_call_id text,provider_recording_id text,storage_bucket text,status text,
      verified_at timestamptz,byte_count bigint,decoded_duration_seconds numeric,content_sha256 text,media_type text,storage_path text,id uuid);
    insert into storage.buckets values('private',false);
    insert into dialpad_voice_intents values('${org}','${intent}','123','201','+18165550101','+18165550102');
    insert into dialpad_intent_configuration values('${org}','${intent}','${connection}',1);
    insert into dialpad_connection_revisions values('${org}','${connection}',1,'301'),('${org}','${wrongConnection}',1,'999');
    insert into dialpad_voice_webhook_sources values('${org}','${source}','${connection}',1),('${org}','${wrongSource}','${wrongConnection}',1);
    insert into dialpad_recording_artifacts values('${org}','123','segment-1','private','available',now(),100,1,'${hash}','audio/mpeg','${org}/123/${artifact}/${hash}.mp3','${artifact}');
    insert into dialpad_voice_event_inbox values('${org}','${event}'::jsonb,'processed',null);`);
  sql(readFileSync(new URL('./20260914042800_dialpad_recording_completeness_source.sql', import.meta.url), 'utf8'));
  const complete = () => sql(`select dialpad_has_complete_owned_recording('${org}','123')`);
  assert.equal(complete(), 'f', 'legacy source-less receipt cannot prove completeness');
  sql(`update dialpad_voice_event_inbox set webhook_source_id='${wrongSource}'`);
  assert.equal(complete(), 'f', 'another company cannot prove completeness');
  sql(`update dialpad_voice_event_inbox set webhook_source_id='${source}',status='quarantined'`);
  assert.equal(complete(), 'f', 'quarantined receipt cannot prove completeness');
  sql(`update dialpad_voice_event_inbox set status='processed'`);
  assert.equal(complete(), 't', 'processed same-company source and every private segment prove completeness');
  console.log('PASS recording completeness requires processed same-company source and every private segment');
} finally {
  if (started) run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(dir, { recursive: true, force: true });
}
