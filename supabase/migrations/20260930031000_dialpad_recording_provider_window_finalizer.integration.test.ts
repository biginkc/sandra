import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url';

const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/postgres');
const ORG = '00000000-0000-0000-0000-00000000f310';
const OWNER = '00000000-0000-0000-0000-00000000f311';
const POLICY = 'fixture-affine-v1';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();
let pg: Client;
let captureId = '';
let intentId = '';
let callActivityId = '';
let providerCallId = '';

async function replica(sql: string, params: unknown[] = []) {
  await pg.query('begin');
  try {
    await pg.query('set local session_replication_role = replica');
    const result = await pg.query(sql, params);
    await pg.query('commit');
    return result;
  } catch (error) {
    await pg.query('rollback');
    throw error;
  }
}

async function seedCapture(vadEnd = 4_800_001) {
  await replica('delete from public.dialpad_call_events where org_id=$1',[ORG]);
  captureId = uuid(); intentId = uuid(); callActivityId = uuid(); providerCallId = String(BigInt('0x' + captureId.replaceAll('-', '').slice(-12)) % BigInt('1000000000000000000'));
  const contact = uuid(); const property = uuid(); const batch = uuid(); const item = uuid();
  await replica(`insert into public.organizations(id,name) values ($1,'finalizer fixture') on conflict do nothing`, [ORG]);
  await replica(`insert into auth.users(id) values ($1) on conflict do nothing`, [OWNER]);
  await replica(`insert into public.contacts(id,org_id,first_name) values ($1,$2,'Fixture')`, [contact, ORG]);
  await replica(`insert into public.properties(id,org_id,address,state,homeowner_contact_id) values ($1,$2,'1 Finalizer Way','MO',$3)`, [property, ORG, contact]);
  await replica(`insert into public.dialer_batches(id,org_id,source_kind) values ($1,$2,'selected_ids')`, [batch, ORG]);
  await replica(`insert into public.dialer_batch_items(id,batch_id,property_id,contact_id,phone_e164,phone_label,state,timezone) values ($1,$2,$3,$4,'+18165550142','homeowner.phone_1','queued','America/Chicago')`, [item,batch,property,contact]);
  await replica(`insert into public.call_activities(id,org_id,property_id,contact_id,dialer_batch_item_id,jitter_attempt_id,provider,provider_call_id,recording_status) values ($1,$2,$3,$4,$5,$6,'dialpad','${providerCallId}','available')`, [callActivityId,ORG,property,contact,item,uuid()]);
  await replica(`insert into public.dialpad_call_intents(id,org_id,connection_id,rep_user_id,binding_id,dialpad_user_id,property_id,contact_id,phone_slot,destination_e164,assignment_episode_id,custom_data,idempotency_key,request_hash,status,expires_at) values ($1,$2,$3,$4,$5,'5150000000000001',$6,$7,1,'+18165550142',$8,'sandra.dialpad.v1.${captureId.replaceAll('-', '').padEnd(48,'a').slice(0,48)}',$9,$10,'prepared',now()+interval '1 hour')`, [intentId,ORG,uuid(),OWNER,uuid(),property,contact,uuid(),uuid(),hash('intent')]);
  await replica(`insert into public.dialpad_recording_captures(id,org_id,intent_id,rep_user_id,call_activity_id,provider_call_id,status,closed_at,close_reason,drain_deadline_at,result_at) values ($1,$2,$3,$4,$5,'${providerCallId}','sealed',now(),'call_ended',now()+interval '30 seconds',now())`, [captureId,ORG,intentId,OWNER,callActivityId]);
  await replica(`insert into public.dialpad_recording_ingest_grants(id,org_id,capture_id,rep_user_id,epoch,token_hash,created_at,expires_at,consumed_at,consumed_by) values ($1,$2,$3,$4,1,$5,now()-interval '1 minute',now()+interval '1 minute',now(),'fixture')`, [uuid(),ORG,captureId,OWNER,hash(captureId)]);
  for (const track of ['tab','mic']) {
    await replica(`insert into public.dialpad_recording_track_finals(capture_id,org_id,track,epoch,completeness,decode_ok,eof_verified,contiguous,source_chunk_count,source_bytes,source_last_seq,storage_path,size_bytes,sha256,codec,sample_rate_hz,channels,decoded_duration_ms,registered_by) values ($1,$2,$3,1,'complete',true,true,true,1,100,0,$4,100,$5,'opus',48000,1,300000,'fixture')`, [captureId,ORG,track,`${ORG}/${captureId}/final/1/${track}`,hash(track)]);
    await replica(`insert into public.dialpad_recording_pcm_progress(capture_id,org_id,track,epoch,processed_through_sample,pcm_eof_sample,source_sample_rate_hz,source_channels,source_codec,degraded_reasons) values ($1,$2,$3,1,$4,$4,48000,1,'opus','[]')`, [captureId,ORG,track,vadEnd]);
  }
  await replica(`insert into public.dialpad_recording_vad_batches(batch_id,capture_id,org_id,track,epoch,range_count,ranges_sha256) values ($1,$2,$3,'tab',1,1,$4)`, [uuid(),captureId,ORG,hash('ranges')]);
  const vadBatch = await pg.query<{batch_id:string}>('select batch_id from public.dialpad_recording_vad_batches where capture_id=$1', [captureId]);
  await replica(`insert into public.dialpad_recording_vad_ranges(capture_id,org_id,track,epoch,batch_id,range_index,start_sample,end_sample,evidence_ref) values ($1,$2,'tab',1,$3,0,0,$4,'fixture')`, [captureId,ORG,vadBatch.rows[0]!.batch_id,vadEnd]);
  await replica(`insert into public.dialpad_recording_vad_totals(capture_id,org_id,voiced_samples,high_water_epoch,high_water_end_sample) values ($1,$2,$3,1,$3)`, [captureId,ORG,vadEnd]);
  const providerConnectedMs = 1_700_000_000_000;
  const providerEndedMs = providerConnectedMs + 300_000;
  const timingRecords: Array<Record<string, unknown>> = (['tab', 'mic'] as const).flatMap((track) => {
    const contextId = `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`;
    return [
      { kind: 'anchor', track, seq: 0, contextId, anchor: 'start', contextFrame: 0, sourceCursor: 0, blockLength: 14_400_003, sourceRateHz: 48_000, outputCursor: 0, outputFrameIndex: 0, phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: null, discardedTailSamples: null },
      { kind: 'anchor', track, seq: 1, contextId, anchor: 'final', contextFrame: 14_400_003, sourceCursor: 14_400_003, blockLength: 0, sourceRateHz: 48_000, outputCursor: vadEnd, outputFrameIndex: Math.trunc(vadEnd / 320), phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: 14_400_003, discardedTailSamples: vadEnd - Math.trunc(vadEnd / 320) * 320 },
      { kind: 'context_clock', track, seq: 0, contextId, observation: 'start', browserBeforeMs: 0, contextTimeMs: 0, browserAfterMs: 0, browserTimeOriginMs: providerConnectedMs, state: 'running' },
      { kind: 'context_clock', track, seq: 1, contextId, observation: 'final', browserBeforeMs: 300_000, contextTimeMs: 300_000, browserAfterMs: 300_000, browserTimeOriginMs: providerConnectedMs, state: 'closed' },
    ];
  });
  timingRecords.push({ kind: 'exchange', seq: 0, serverClockId: '00000000-0000-4000-8000-000000000003', browserSendMs: 0, browserReceiveMs: 300_001, serverReceiveMonoMs: 0, serverSendMonoMs: 1, serverReceiveWallMs: providerConnectedMs * 1000, serverSendWallMs: providerEndedMs * 1000 });
  for (const record of timingRecords) {
    const stream = record.kind === 'anchor' ? `${String(record.track)}:anchor` : record.kind === 'context_clock' ? `${String(record.track)}:context` : 'exchange';
    await replica(`insert into public.dialpad_recording_timing_records(capture_id,org_id,epoch,stream,seq,content_hash,record,payload_bytes) values ($1,$2,1,$3,$4,$5,$6,$7)`, [captureId,ORG,stream,record.seq,hash(JSON.stringify(record)),JSON.stringify(record),JSON.stringify(record).length]);
  }
  await replica(`insert into public.dialpad_recording_timing_state(capture_id,org_id,epoch,status,persisted_sequences,last_sequences,reasons,final_request_hash,finalized_at) values ($1,$2,1,'collected',$3,$3,'[]',$4,now())`, [captureId,ORG,JSON.stringify({tabAnchor:1,micAnchor:1,tabContext:1,micContext:1,exchange:0}),hash('timing-final')]);
  for (const [state, payload] of [['connected', {date_connected:String(providerConnectedMs)}], ['hangup', {date_ended:String(providerEndedMs), date_connected:String(providerConnectedMs)}]] as const) {
    await replica(`insert into public.dialpad_call_events(id,org_id,connection_id,provider_call_id,event_state,event_timestamp_ms,payload,payload_sha256,signature_alg,secret_version,disposition,matched_intent_id) values ($1,$2,$3,'${providerCallId}',$4,$5,$6,$7,'HS256',1,'matched',$8)`, [uuid(),ORG,uuid(),state,state === 'hangup' ? providerEndedMs : providerConnectedMs,JSON.stringify(payload),hash(state),intentId]);
  }
  const matchedEvent = await pg.query<{id:string}>(`select id from public.dialpad_call_events where org_id=$1 and provider_call_id='${providerCallId}' order by event_timestamp_ms desc limit 1`,[ORG]);
  await replica(`update public.dialpad_call_intents set status='matched',matched_provider_call_id='${providerCallId}',matched_event_id=$2,matched_at=now() where id=$1`, [intentId, matchedEvent.rows[0]!.id]);
  await replica(`insert into public.dialpad_recording_provider_window_policies(org_id,policy_version,algorithm_version,policy_hash,mapping_method,time_unit,sample_rate_hz,domain_start_sample,domain_end_sample,lower_slope_us_per_sample,lower_intercept_us,upper_slope_us_per_sample,upper_intercept_us,classification_overcount_samples,supported_duration_max_seconds,supported_anchor_cadence_ms,supported_stall_max_ms,supported_drift_ppm,evidence_digest,evidence_refs,acceptance_note,accepted_at,accepted_by) values ($1,$2,'fixture-affine-v1',$3,'affine_sample_support_v1','microseconds',16000,0,10000000,1,1700000000000000,1,1700000000000000,0,10800,600000,1000,50,$4,'["fixture"]','Measured fixture only',now(),$5) on conflict do nothing`, [ORG,POLICY,hash('policy'),hash('evidence'),OWNER]);
}

describe('provider-window finalizer migration', () => {
  beforeAll(async () => { pg = new Client({ connectionString: dbUrl }); await pg.connect(); });
  afterAll(async () => { await pg.end(); });
  beforeEach(async () => {
    await pg.query('begin');
    try {
      await pg.query('set local session_replication_role = replica');
      await pg.query('delete from public.dialpad_recording_captures where org_id=$1', [ORG]);
      await pg.query('delete from public.dialpad_call_events where org_id=$1', [ORG]);
      await pg.query('commit');
    } catch (error) {
      await pg.query('rollback');
      throw error;
    }
    await pg.query('truncate public.dialpad_recording_provider_window_results, public.dialpad_recording_provider_window_policies cascade');
    await seedCapture();
  });

  it('clips exact samples, finalizes through the real RPC, and replays without changing evaluated_at', async () => {
    const candidatesBefore = await pg.query<{v:any}>('select public.fn_list_dialpad_recording_provider_window_candidates($1) v',[10]);
    expect(candidatesBefore.rows[0]!.v).toEqual([{ orgId: ORG, captureId, policyVersion: POLICY }]);
    const input = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('eligible');
    expect(input.rows[0]!.v.observedSamples).toBe(4_800_001);
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_001);
    const done = await pg.query<{v:any}>('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4) v',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    const evaluated = await pg.query<{evaluated_at:string}>('select evaluated_at from public.dialpad_recording_provider_window_results where capture_id=$1',[captureId]);
    expect(done.rows[0]!.v.replayed).toBe(false);
    const replay = await pg.query<{v:any}>('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4) v',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    expect(replay.rows[0]!.v.replayed).toBe(true);
    expect((await pg.query<{v:any}>('select public.fn_list_dialpad_recording_provider_window_candidates($1) v',[10])).rows[0]!.v).toEqual([]);
    expect((await pg.query<{evaluated_at:string}>('select evaluated_at from public.dialpad_recording_provider_window_results where capture_id=$1',[captureId])).rows[0]!.evaluated_at.toString()).toBe(evaluated.rows[0]!.evaluated_at.toString());
    const browser = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_browser_status($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(browser.rows[0]!.v.finalResult).toMatchObject({ status: 'eligible', eligibleSamples: 4_800_001 });
    expect(browser.rows[0]!.v).not.toHaveProperty('selectedSummary');
  });

  it('returns exact threshold as ineligible and rejects stale finalization after evidence changes', async () => {
    await seedCapture(4_800_000);
    const input = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('ineligible');
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_000);
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,'0'.repeat(64)])).rejects.toMatchObject({code:'40001'});
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    await replica(`update public.dialpad_recording_timing_records set record=record || '{"browserReceiveMs":300002}'::jsonb where capture_id=$1 and org_id=$2 and stream='exchange'`, [captureId, ORG]);
    const timingChanged = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(timingChanged.rows[0]!.v.inputDigest).not.toBe(input.rows[0]!.v.inputDigest);
    const stale = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_provider_window_result($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(stale.rows[0]!.v).toMatchObject({ status: 'stale', currentAtRead: false });
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest])).rejects.toMatchObject({code:'40001'});
    await replica(`insert into public.dialpad_recording_vad_ranges(capture_id,org_id,track,epoch,batch_id,range_index,start_sample,end_sample,evidence_ref) select capture_id,org_id,'tab',epoch,batch_id,1,4_800_000,4_800_001,'late' from public.dialpad_recording_vad_ranges where capture_id=$1 limit 1`,[captureId]);
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest])).rejects.toMatchObject({code:'40001'});
  });

  it('keeps unaccepted policy unknown and revocation removes eligibility', async () => {
    const input = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,'missing-policy']);
    expect(input.rows[0]!.v.status).toBe('unknown');
    expect(input.rows[0]!.v.eligibleSamples).toBeNull();
    const accepted = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,accepted.rows[0]!.v.inputDigest]);
    await pg.query('update public.dialpad_recording_provider_window_policies set revoked_at=now() where org_id=$1',[ORG]);
    expect((await pg.query<{v:boolean}>('select public.dialpad_recording_provider_window_is_eligible($1,$2,$3) v',[ORG,captureId,callActivityId])).rows[0]!.v).toBe(false);
  });

  it('returns a bounded keyset page and keeps empty VAD status provisional', async () => {
    const page = await pg.query<{v:any}>('select public.fn_list_dialpad_recording_provider_window_candidates($1,$2,$3) v',[1,null,null]);
    expect(page.rows[0]!.v.candidates).toEqual([{ orgId: ORG, captureId, policyVersion: POLICY }]);
    expect(page.rows[0]!.v.nextCursor).toMatchObject({ captureId });
    await replica('delete from public.dialpad_recording_vad_totals where org_id=$1 and capture_id=$2',[ORG,captureId]);
    const browser = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_browser_status($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(browser.rows[0]!.v).toMatchObject({ totalSamples: 0, measurementStatus: 'provisional' });
  });

  it('keeps the finalizer service-only and enforces representative ownership', async () => {
    const input = await pg.query<{v:any}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    await pg.query('set role anon');
    await expect(pg.query('select public.fn_get_dialpad_recording_final_input($1,$2,$3)', [ORG,captureId,POLICY])).rejects.toMatchObject({ code: '42501' });
    await pg.query('reset role');
    expect((await pg.query<{service_ok:boolean; anon_ok:boolean}>("select has_function_privilege('service_role','public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text)','EXECUTE') as service_ok, has_function_privilege('anon','public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text)','EXECUTE') as anon_ok")).rows[0]).toEqual({ service_ok: true, anon_ok: false });
    await expect(pg.query('select public.fn_get_dialpad_recording_provider_window_result($1,$2,$3)', [ORG, uuid(), captureId])).rejects.toMatchObject({ code: 'P0002' });
    expect(input.rows[0]!.v.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
