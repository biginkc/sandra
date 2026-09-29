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
let pgSnapshot: Client;
let captureId = '';
let intentId = '';
let callActivityId = '';
let providerCallId = '';
type SeedOptions = {
  providerConnectedMs?: number;
  providerDurationMs?: number;
  contextOriginMs?: number;
  exchangeWallOriginMs?: number;
  driftPpm?: number;
  captureMarginUs?: number;
  providerStartMarginUs?: number;
  providerEndMarginUs?: number;
  domainStartSample?: number;
  domainEndSample?: number;
  exchangeCount?: number;
  policyVersion?: string;
};
type FinalizerSummary = Record<string, unknown> & {
  mappingLowerSlopeUsPerSample?: number;
  mappingUpperSlopeUsPerSample?: number;
  mappingLowerInterceptUs?: number;
  mappingUpperInterceptUs?: number;
};
type FinalizerJson = {
  inputDigest?: string;
  replayed?: boolean;
  status?: string;
  eligibleSamples?: number;
  sampleWindow: { lowerSample: number; upperSample: number };
  candidates: Array<{ captureId: string; orgId: string; policyVersion: string }>;
  nextCursor: { resultAt: string; captureId: string } | null;
  currentAtRead?: boolean;
  selectedSummary?: FinalizerSummary;
  [key: string]: unknown;
};
type FinalizerRow = { v: FinalizerJson };

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

async function seedCapture(vadEnd = 4_800_320, options: SeedOptions = {}) {
  await replica('delete from public.dialpad_call_events where org_id=$1',[ORG]);
  captureId = uuid(); intentId = uuid(); callActivityId = uuid(); providerCallId = String(BigInt('0x' + captureId.replaceAll('-', '').slice(-12)) % BigInt('1000000000000000000'));
  const contact = uuid(); const property = uuid(); const batch = uuid(); const item = uuid();
  await replica(`insert into public.organizations(id,name) values ($1,'finalizer fixture') on conflict do nothing`, [ORG]);
  await replica(`insert into auth.users(id) values ($1) on conflict do nothing`, [OWNER]);
  await replica(`insert into public.contacts(id,org_id,first_name) values ($1,$2,'Fixture')`, [contact, ORG]);
  await replica(`insert into public.properties(id,org_id,address,state,homeowner_contact_id) values ($1,$2,'1 Finalizer Way','MO',$3)`, [property, ORG, contact]);
  await replica(`insert into public.dialer_batches(id,org_id,source_kind) values ($1,$2,'selected_ids')`, [batch, ORG]);
  await replica(`insert into public.dialer_batch_items(id,batch_id,property_id,contact_id,phone_e164,phone_label,state,timezone) values ($1,$2,$3,$4,'+18165550142','homeowner.phone_1','queued','America/Chicago')`, [item,batch,property,contact]);
  await replica(`insert into public.call_activities(id,org_id,property_id,contact_id,dialer_batch_item_id,jitter_attempt_id,provider,provider_call_id,recording_status,started_at,ended_at) values ($1,$2,$3,$4,$5,$6,'dialpad','${providerCallId}','available',now()-interval '10 minutes',now()-interval '1 minute')`, [callActivityId,ORG,property,contact,item,uuid()]);
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
  const providerConnectedMs = options.providerConnectedMs ?? 1_700_000_000_000;
  const finalOutput = vadEnd + 1;
  const providerEndedMs = providerConnectedMs + (options.providerDurationMs ?? Math.ceil(finalOutput / 16) + 3);
  const contextOriginMs = options.contextOriginMs ?? providerConnectedMs;
  const exchangeWallOriginMs = options.exchangeWallOriginMs ?? providerConnectedMs - 1_250;
  const timingRecords: Array<Record<string, unknown>> = (['tab', 'mic'] as const).flatMap((track) => {
    const contextId = `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`;
    const contextOriginFrames = track === 'tab' ? 48_000 : 96_000;
    const finalContextTimeMs = contextOriginFrames / 48 + finalOutput / 16;
    const finalSourceCursor = finalOutput * 3;
    return [
      { kind: 'anchor', track, seq: 0, contextId, anchor: 'start', contextFrame: contextOriginFrames, sourceCursor: 0, blockLength: 128, sourceRateHz: 48_000, outputCursor: 0, outputFrameIndex: 0, phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: null, discardedTailSamples: null },
      { kind: 'anchor', track, seq: 1, contextId, anchor: 'final', contextFrame: finalSourceCursor + contextOriginFrames, sourceCursor: finalSourceCursor, blockLength: 0, sourceRateHz: 48_000, outputCursor: finalOutput, outputFrameIndex: Math.trunc(finalOutput / 320), phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: finalSourceCursor + contextOriginFrames, discardedTailSamples: 1 },
      { kind: 'context_clock', track, seq: 0, contextId, observation: 'start', browserBeforeMs: contextOriginFrames / 48 + 249.5, contextTimeMs: contextOriginFrames / 48, browserAfterMs: contextOriginFrames / 48 + 250.5, browserTimeOriginMs: contextOriginMs, state: 'running' },
      { kind: 'context_clock', track, seq: 1, contextId, observation: 'final', browserBeforeMs: finalContextTimeMs + 249.5, contextTimeMs: finalContextTimeMs, browserAfterMs: finalContextTimeMs + 250.5, browserTimeOriginMs: contextOriginMs, state: 'closed' },
    ];
  });
  const exchangeCount = options.exchangeCount ?? 3;
  for (let seq = 0; seq < exchangeCount; seq += 1) {
    const browserSendMs = seq * 100;
    const browserReceiveMs = browserSendMs + 1;
    timingRecords.push({ kind: 'exchange', seq, serverClockId: '00000000-0000-4000-8000-000000000003', browserSendMs, browserReceiveMs, serverReceiveMonoMs: browserSendMs, serverSendMonoMs: browserSendMs + 1, serverReceiveWallMs: exchangeWallOriginMs + browserReceiveMs, serverSendWallMs: exchangeWallOriginMs + browserReceiveMs + 1 });
  }
  for (const record of timingRecords) {
    const stream = record.kind === 'anchor' ? `${String(record.track)}:anchor` : record.kind === 'context_clock' ? `${String(record.track)}:context` : 'exchange';
    await replica(`insert into public.dialpad_recording_timing_records(capture_id,org_id,epoch,stream,seq,content_hash,record,payload_bytes) values ($1,$2,1,$3,$4,$5,$6,$7)`, [captureId,ORG,stream,record.seq,hash(JSON.stringify(record)),JSON.stringify(record),JSON.stringify(record).length]);
  }
  await replica(`insert into public.dialpad_recording_timing_state(capture_id,org_id,epoch,status,persisted_sequences,last_sequences,reasons,final_request_hash,finalized_at) values ($1,$2,1,'collected',$3,$3,'[]',$4,now())`, [captureId,ORG,JSON.stringify({tabAnchor:1,micAnchor:1,tabContext:1,micContext:1,exchange:exchangeCount - 1}),hash('timing-final')]);
  for (const [state, payload] of [['connected', {date_connected:String(providerConnectedMs)}], ['hangup', {date_ended:String(providerEndedMs), date_connected:String(providerConnectedMs)}]] as const) {
    await replica(`insert into public.dialpad_call_events(id,org_id,connection_id,provider_call_id,event_state,event_timestamp_ms,payload,payload_sha256,signature_alg,secret_version,disposition,matched_intent_id) values ($1,$2,$3,'${providerCallId}',$4,$5,$6,$7,'HS256',1,'matched',$8)`, [uuid(),ORG,uuid(),state,state === 'hangup' ? providerEndedMs : providerConnectedMs,JSON.stringify(payload),hash(state),intentId]);
  }
  const matchedEvent = await pg.query<{id:string}>(`select id from public.dialpad_call_events where org_id=$1 and provider_call_id='${providerCallId}' order by event_timestamp_ms desc limit 1`,[ORG]);
  await replica(`update public.dialpad_call_intents set status='matched',matched_provider_call_id='${providerCallId}',matched_event_id=$2,matched_at=now() where id=$1`, [intentId, matchedEvent.rows[0]!.id]);
  const fixturePolicy = options.policyVersion ?? POLICY;
  await replica(`insert into public.dialpad_recording_provider_window_policies(org_id,policy_version,algorithm_version,policy_hash,mapping_method,time_unit,sample_rate_hz,domain_start_sample,domain_end_sample,lower_slope_us_per_sample,lower_intercept_us,upper_slope_us_per_sample,upper_intercept_us,classification_overcount_samples,supported_duration_max_seconds,supported_anchor_cadence_ms,supported_stall_max_ms,supported_drift_ppm,supported_capture_margin_us,supported_provider_start_margin_us,supported_provider_end_margin_us,evidence_digest,evidence_refs,acceptance_note,accepted_at,accepted_by) values ($1,$2,'fixture-affine-v1',$3,'affine_sample_support_v1','microseconds',16000,$10,$11,62.5,0,62.5,0,0,10800,600000,1000,$6,$7,$8,$9,$4,'["fixture"]','Measured fixture only',now(),$5) on conflict do nothing`, [ORG,fixturePolicy,hash(`policy-${fixturePolicy}`),hash('evidence'),OWNER,options.driftPpm ?? 0,options.captureMarginUs ?? 0,options.providerStartMarginUs ?? 0,options.providerEndMarginUs ?? 0,options.domainStartSample ?? 0,options.domainEndSample ?? 10_000_000]);
  await replica(`insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner') on conflict do nothing`, [OWNER, ORG]);
  await replica(`insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true) on conflict do nothing`, [ORG]);
  await replica(`insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,call_activity_id,idempotency_key) values ($1,$2,$3,'call','dialpad','reached',now()-interval '1 minute',$4,$5)`, [ORG,property,OWNER,callActivityId,uuid()]);
}

describe('provider-window finalizer migration', () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: dbUrl });
    pgSnapshot = new Client({ connectionString: dbUrl });
    await pg.connect();
    await pgSnapshot.connect();
  });
  afterAll(async () => {
    await pgSnapshot.end();
    await pg.end();
  });
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
    await pg.query('delete from public.dialpad_recording_provider_window_results where org_id=$1', [ORG]);
    await pg.query('delete from public.dialpad_recording_provider_window_policies where org_id=$1', [ORG]);
    await seedCapture();
  });

  it('clips exact samples, finalizes through the real RPC, and replays without changing evaluated_at', async () => {
    const candidatesBefore = await pg.query<{v:FinalizerJson}>('select public.fn_list_dialpad_recording_provider_window_candidates($1) v',[10]);
    expect(candidatesBefore.rows[0]!.v).toEqual([{ orgId: ORG, captureId, policyVersion: POLICY }]);
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('eligible');
    expect(input.rows[0]!.v.observedSamples).toBe(4_800_320);
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_320);
    expect(input.rows[0]!.v.selectedSummary?.mappingLowerSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.selectedSummary?.mappingUpperSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.sampleWindow).toEqual({ lowerSample: 0, upperSample: 4_800_320 });
    const done = await pg.query<{v:FinalizerJson}>('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4) v',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    const evaluated = await pg.query<{evaluated_at:string}>('select evaluated_at from public.dialpad_recording_provider_window_results where capture_id=$1',[captureId]);
    expect(done.rows[0]!.v.replayed).toBe(false);
    const replay = await pg.query<{v:FinalizerJson}>('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4) v',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    expect(replay.rows[0]!.v.replayed).toBe(true);
    await pg.query('set role service_role');
    try {
      const serviceInput = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
      const serviceReplay = await pg.query<{v:FinalizerJson}>('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4) v',[ORG,captureId,POLICY,serviceInput.rows[0]!.v.inputDigest]);
      expect(serviceReplay.rows[0]!.v.replayed).toBe(true);
    } finally {
      await pg.query('reset role');
    }
    await pg.query('set role authenticated');
    await pg.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [OWNER]);
    let kpis;
    try {
      kpis = await pg.query<{v:FinalizerJson}>('select public.fn_get_acquisition_kpis($1,$2,now()-interval \'1 day\',now()+interval \'1 day\') v',[ORG,OWNER]);
    } finally {
      await pg.query('reset role');
    }
    expect(kpis.rows[0]!.v.conversationsOverFiveMinutes).toBe(1);
    expect((await pg.query<{v:FinalizerJson}>('select public.fn_list_dialpad_recording_provider_window_candidates($1) v',[10])).rows[0]!.v).toEqual([]);
    expect((await pg.query<{evaluated_at:string}>('select evaluated_at from public.dialpad_recording_provider_window_results where capture_id=$1',[captureId])).rows[0]!.evaluated_at.toString()).toBe(evaluated.rows[0]!.evaluated_at.toString());
    const browser = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_browser_status($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(browser.rows[0]!.v.finalResult).toMatchObject({ status: 'eligible', eligibleSamples: 4_800_320 });
    expect(browser.rows[0]!.v).not.toHaveProperty('selectedSummary');
  });

  it('invalidates the awarded KPI after a late provider conflict at a repeatable-read boundary', async () => {
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);

    const setMember = async (client: Client) => {
      await client.query('set role authenticated');
      await client.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [OWNER]);
    };
    await pgSnapshot.query('begin isolation level repeatable read');
    try {
      await setMember(pgSnapshot);
      const snapshotBefore = await pgSnapshot.query<{v:FinalizerJson}>('select public.fn_get_acquisition_kpis($1,$2,now()-interval \'1 day\',now()+interval \'1 day\') v',[ORG,OWNER]);
      expect(snapshotBefore.rows[0]!.v.conversationsOverFiveMinutes).toBe(1);

      const hangup = await pg.query<{id:string; connection_id:string; event_timestamp_ms:string; payload:Record<string, unknown>}>('select id,connection_id,event_timestamp_ms,payload from public.dialpad_call_events where org_id=$1 and provider_call_id=$2 and event_state=\'hangup\' and disposition=\'matched\'', [ORG, providerCallId]);
      expect(hangup.rows).toHaveLength(1);
      await replica(`insert into public.dialpad_call_events(id,org_id,connection_id,provider_call_id,event_state,event_timestamp_ms,payload,payload_sha256,signature_alg,secret_version,disposition,disposition_reason,conflicts_with_event_id) values ($1,$2,$3,$4,'hangup',$5,$6,$7,'HS256',1,'conflict','late resolver conflict',$8)`, [uuid(),ORG,hangup.rows[0]!.connection_id,providerCallId,Number(hangup.rows[0]!.event_timestamp_ms)+1,JSON.stringify(hangup.rows[0]!.payload),hash('late-conflict'),hangup.rows[0]!.id]);
      const afterConflict = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
      expect(afterConflict.rows[0]!.v.status).toBe('unknown');
      expect(afterConflict.rows[0]!.v.reasons).toContain('provider_evidence_conflict');

      const snapshotDuringConflict = await pgSnapshot.query<{v:FinalizerJson}>('select public.fn_get_acquisition_kpis($1,$2,now()-interval \'1 day\',now()+interval \'1 day\') v',[ORG,OWNER]);
      expect(snapshotDuringConflict.rows[0]!.v.conversationsOverFiveMinutes).toBe(1);
      await pgSnapshot.query('commit');
    } catch (error) {
      await pgSnapshot.query('rollback');
      throw error;
    } finally {
      await pgSnapshot.query('reset role');
    }

    await setMember(pgSnapshot);
    try {
      const refreshed = await pgSnapshot.query<{v:FinalizerJson}>('select public.fn_get_acquisition_kpis($1,$2,now()-interval \'1 day\',now()+interval \'1 day\') v',[ORG,OWNER]);
      expect(refreshed.rows[0]!.v.conversationsOverFiveMinutes).toBe(0);
    } finally {
      await pgSnapshot.query('reset role');
    }
  });

  it('derives the provider window from each capture origin under one accepted policy', async () => {
    const first = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(first.rows[0]!.v.status).toBe('eligible');
    expect(first.rows[0]!.v.sampleWindow.lowerSample).toBe(0);
    const base = 1_700_000_000_000;
    await seedCapture(4_800_320, { providerConnectedMs: base + 100, contextOriginMs: base, exchangeWallOriginMs: base - 1_250 });
    const shifted = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(shifted.rows[0]!.v.status).toBe('ineligible');
    expect(shifted.rows[0]!.v.sampleWindow.lowerSample).toBeGreaterThan(0);
    // The lower edge uses the measured 249.5 ms browser bracket and the
    // causal exchange lower edge, so 1592 is the exact conservative result.
    expect(shifted.rows[0]!.v.sampleWindow.lowerSample).toBe(1_592);
    expect(shifted.rows[0]!.v.sampleWindow).toEqual({ lowerSample: 1_592, upperSample: 4_800_320 });
  });

  it('applies an accepted nonzero drift envelope without changing the nominal slope', async () => {
    const driftPolicy = 'fixture-affine-drift-v1';
    await seedCapture(4_800_320, { driftPpm: 50, policyVersion: driftPolicy });
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,driftPolicy]);
    expect(input.rows[0]!.v.status).toBe('ineligible');
    expect(input.rows[0]!.v.reasons).not.toContain('timing_mapping_unsupported');
    expect(input.rows[0]!.v.selectedSummary?.mappingLowerSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.selectedSummary?.mappingUpperSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.selectedSummary?.mappingLowerInterceptUs).not.toBe(input.rows[0]!.v.selectedSummary?.mappingUpperInterceptUs);
  });

  it('expands drift for observations outside a narrow supported domain', async () => {
    const narrowPolicy = 'fixture-affine-narrow-drift-v1';
    await seedCapture(4_800_320, {
      driftPpm: 50,
      domainStartSample: 4_800_000,
      domainEndSample: 4_800_016,
      policyVersion: narrowPolicy,
    });
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,narrowPolicy]);
    expect(input.rows[0]!.v.reasons).not.toContain('timing_mapping_unsupported');
    expect(input.rows[0]!.v.selectedSummary!.mappingUpperInterceptUs! - input.rows[0]!.v.selectedSummary!.mappingLowerInterceptUs!).toBeGreaterThan(20_000);
  });

  it('rejects an interior context-clock discontinuity while preserving asynchronous brackets', async () => {
    await replica(`update public.dialpad_recording_timing_records set record=record || '{"browserBeforeMs":999999,"browserAfterMs":999999}'::jsonb where capture_id=$1 and org_id=$2 and stream='tab:context' and seq=1`, [captureId, ORG]);
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('unknown');
    expect(input.rows[0]!.v.reasons).toContain('timing_mapping_unsupported');
  });

  it('widens an asymmetric exchange bracket without inventing an RTT midpoint', async () => {
    await seedCapture(4_900_320, { exchangeCount: 1 });
    await replica(`update public.dialpad_recording_timing_records set record=record || '{"browserReceiveMs":20,"serverReceiveWallMs":1700000000002,"serverSendWallMs":1700000000003}'::jsonb where capture_id=$1 and org_id=$2 and stream='exchange' and seq=0`, [captureId, ORG]);
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('eligible');
    expect(input.rows[0]!.v.selectedSummary!.mappingLowerInterceptUs!).toBeLessThan(input.rows[0]!.v.selectedSummary!.mappingUpperInterceptUs!);
  });

  it('accepts repeated exchange brackets and rejects a genuinely disjoint jump', async () => {
    const valid = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(valid.rows[0]!.v.status).toBe('eligible');
    await replica(`update public.dialpad_recording_timing_records
      set record = jsonb_set(jsonb_set(record, '{serverReceiveWallMs}', to_jsonb((record->>'serverReceiveWallMs')::numeric + 5000)), '{serverSendWallMs}', to_jsonb((record->>'serverSendWallMs')::numeric + 5000))
      where capture_id=$1 and org_id=$2 and stream='exchange' and seq=2`, [captureId, ORG]);
    const jumped = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(jumped.rows[0]!.v.status).toBe('unknown');
    expect(jumped.rows[0]!.v.reasons).toContain('timing_mapping_unsupported');
  });

  it('returns exact threshold as ineligible and rejects stale finalization after evidence changes', async () => {
    const thresholdPolicy = 'fixture-threshold-v1';
    await seedCapture(4_800_320, { providerDurationMs: 300_002, providerEndMarginUs: 500, policyVersion: thresholdPolicy });
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,thresholdPolicy]);
    expect(input.rows[0]!.v.status).toBe('ineligible');
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_000);
    expect(input.rows[0]!.v.selectedSummary?.mappingLowerSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.selectedSummary?.mappingUpperSlopeUsPerSample).toBe(62.5);
    expect(input.rows[0]!.v.sampleWindow).toEqual({ lowerSample: 0, upperSample: 4_800_000 });
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,thresholdPolicy,'0'.repeat(64)])).rejects.toMatchObject({code:'40001'});
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,thresholdPolicy,input.rows[0]!.v.inputDigest]);
    await replica(`update public.dialpad_recording_timing_records set record=record || '{"lateNote":"changed"}'::jsonb where capture_id=$1 and org_id=$2 and stream='exchange' and seq=0`, [captureId, ORG]);
    const timingChanged = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,thresholdPolicy]);
    expect(timingChanged.rows[0]!.v.inputDigest).not.toBe(input.rows[0]!.v.inputDigest);
    const stale = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_provider_window_result($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(stale.rows[0]!.v).toMatchObject({ status: 'stale', currentAtRead: false });
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,thresholdPolicy,input.rows[0]!.v.inputDigest])).rejects.toMatchObject({code:'40001'});
    await replica(`insert into public.dialpad_recording_vad_ranges(capture_id,org_id,track,epoch,batch_id,range_index,start_sample,end_sample,evidence_ref) select capture_id,org_id,'tab',epoch,batch_id,1,4_800_000,4_800_001,'late' from public.dialpad_recording_vad_ranges where capture_id=$1 limit 1`,[captureId]);
    await expect(pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,thresholdPolicy,input.rows[0]!.v.inputDigest])).rejects.toMatchObject({code:'40001'});
  });

  it('preserves the strict threshold for a valid 320-frame EOF at 4800001', async () => {
    const thresholdPlusOnePolicy = 'fixture-threshold-plus-one-v1';
    await seedCapture(4_800_320, {
      providerDurationMs: 300_002,
      providerEndMarginUs: 437.5,
      policyVersion: thresholdPlusOnePolicy,
    });
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,thresholdPlusOnePolicy]);
    expect(input.rows[0]!.v.status).toBe('eligible');
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_001);
    expect(input.rows[0]!.v.sampleWindow.upperSample).toBe(4_800_001);
    const eof = await pg.query<{pcm_eof_sample:string}>('select pcm_eof_sample from public.dialpad_recording_pcm_progress where capture_id=$1 and track=\'tab\'',[captureId]);
    expect(eof.rows[0]!.pcm_eof_sample).toBe('4800320');
  });

  it('keeps unaccepted policy unknown and revocation removes eligibility', async () => {
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,'missing-policy']);
    expect(input.rows[0]!.v.status).toBe('unknown');
    expect(input.rows[0]!.v.eligibleSamples).toBeNull();
    const accepted = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)',[ORG,captureId,POLICY,accepted.rows[0]!.v.inputDigest]);
    await pg.query('update public.dialpad_recording_provider_window_policies set revoked_at=now() where org_id=$1',[ORG]);
    expect((await pg.query<{v:boolean}>('select public.dialpad_recording_provider_window_is_eligible($1,$2,$3) v',[ORG,captureId,callActivityId])).rows[0]!.v).toBe(false);
  });

  it('rejects nonfinite numeric policy values before they can be accepted', async () => {
    await expect(pg.query(`insert into public.dialpad_recording_provider_window_policies(
      org_id,policy_version,algorithm_version,policy_hash,mapping_method,time_unit,sample_rate_hz,
      domain_start_sample,domain_end_sample,lower_slope_us_per_sample,lower_intercept_us,
      upper_slope_us_per_sample,upper_intercept_us,classification_overcount_samples,
      supported_duration_max_seconds,supported_anchor_cadence_ms,supported_stall_max_ms,
      supported_drift_ppm,supported_capture_margin_us,supported_provider_start_margin_us,
      supported_provider_end_margin_us,evidence_digest,evidence_refs,acceptance_note,accepted_at,accepted_by
    ) select org_id,'fixture-infinite-v1',algorithm_version,repeat('c',64),mapping_method,time_unit,sample_rate_hz,
      domain_start_sample,domain_end_sample,lower_slope_us_per_sample,lower_intercept_us,
      upper_slope_us_per_sample,upper_intercept_us,classification_overcount_samples,
      supported_duration_max_seconds,supported_anchor_cadence_ms,supported_stall_max_ms,
      'Infinity'::numeric,supported_capture_margin_us,supported_provider_start_margin_us,
      supported_provider_end_margin_us,evidence_digest,evidence_refs,acceptance_note,accepted_at,accepted_by
      from public.dialpad_recording_provider_window_policies where org_id=$1 and policy_version=$2`, [ORG,POLICY])).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a per-capture timing sequence gap even when start and final records remain', async () => {
    await replica(`update public.dialpad_recording_timing_records set seq=2 where capture_id=$1 and org_id=$2 and stream in ('tab:anchor','mic:anchor') and seq=1`, [captureId, ORG]);
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('unknown');
    expect(input.rows[0]!.v.reasons).toContain('timing_discontinuity');
  });

  it('returns a bounded keyset page and keeps empty VAD status provisional', async () => {
    const page = await pg.query<{v:FinalizerJson}>('select public.fn_list_dialpad_recording_provider_window_candidates($1,$2,$3) v',[1,null,null]);
    expect(page.rows[0]!.v.candidates).toEqual([{ orgId: ORG, captureId, policyVersion: POLICY }]);
    expect(page.rows[0]!.v.nextCursor).toMatchObject({ captureId });
    await replica('delete from public.dialpad_recording_vad_totals where org_id=$1 and capture_id=$2',[ORG,captureId]);
    const browser = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_browser_status($1,$2,$3) v',[ORG,OWNER,captureId]);
    expect(browser.rows[0]!.v).toMatchObject({ totalSamples: 0, measurementStatus: 'provisional' });
  });

  it('walks every pending row with limit one and restarts only after the bounded page is exhausted', async () => {
    const pendingIds = [captureId];
    for (let index = 0; index < 3; index += 1) {
      await seedCapture(4_800_320, { providerConnectedMs: 1_700_000_000_000 + (index + 1) * 10_000 });
      pendingIds.push(captureId);
    }
    const ordered = (await pg.query<{id:string}>('select id from public.dialpad_recording_captures where org_id=$1 order by result_at,id', [ORG])).rows.map((row) => row.id);
    const seen: string[] = [];
    let afterAt: string | null = null;
    let afterId: string | null = null;
    for (let page = 0; page < ordered.length; page += 1) {
      const pageResult: { rows: FinalizerRow[] } = await pg.query<FinalizerRow>('select public.fn_list_dialpad_recording_provider_window_candidates($1,$2,$3) v', [1, afterAt, afterId]);
      expect(pageResult.rows[0]!.v.candidates).toHaveLength(1);
      seen.push(pageResult.rows[0]!.v.candidates[0].captureId);
      afterAt = pageResult.rows[0]!.v.nextCursor!.resultAt;
      afterId = pageResult.rows[0]!.v.nextCursor!.captureId;
    }
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual([...ordered].sort());
    const wrapped = await pg.query<{v:FinalizerJson}>('select public.fn_list_dialpad_recording_provider_window_candidates($1,$2,$3) v', [1, null, null]);
    expect(wrapped.rows[0]!.v.candidates[0].captureId).toBe(seen[0]);
  });

  it('accepts a valid timing append and finish through the service RPCs', async () => {
    const existing = await pg.query<{record:Record<string, unknown>; stream:string; seq:number}>('select record,stream,seq from public.dialpad_recording_timing_records where capture_id=$1 and org_id=$2 order by stream,seq', [captureId, ORG]);
    // The authenticated exchange ACK must cover both final context brackets.
    // This fixture's mic context browser offset is 250 ms, so the ACK arrives
    // just after the final 302270.5625 ms observation on both tracks.
    const records = existing.rows.map(({ record, stream: streamName, seq }) => streamName === 'exchange' && seq === 2
      ? { ...record, browserSendMs: 302_270, browserReceiveMs: 302_271, serverReceiveMonoMs: 302_270, serverSendMonoMs: 302_271, serverReceiveWallMs: Number(record.serverReceiveWallMs) + 302_070, serverSendWallMs: Number(record.serverSendWallMs) + 302_070 }
      : record);
    await replica('update public.dialpad_recording_captures set status=\'open\' where id=$1 and org_id=$2', [captureId, ORG]);
    await replica('delete from public.dialpad_recording_timing_state where capture_id=$1 and org_id=$2', [captureId, ORG]);
    await replica('delete from public.dialpad_recording_timing_batches where capture_id=$1 and org_id=$2', [captureId, ORG]);
    await replica('delete from public.dialpad_recording_timing_records where capture_id=$1 and org_id=$2', [captureId, ORG]);
    await pg.query('set role service_role');
    try {
      const appended = await pg.query<{v:FinalizerJson}>('select public.fn_append_dialpad_recording_timing($1,$2,$3,$4,$5) v', [ORG, captureId, 1, uuid(), JSON.stringify(records)]);
      expect(appended.rows[0]!.v.status).toBe('recorded');
      const finished = await pg.query<{v:FinalizerJson}>('select public.fn_finish_dialpad_recording_timing($1,$2,$3,$4,$5,$6) v', [ORG, captureId, 1, JSON.stringify({ tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 2 }), 'collected', '[]']);
      expect(finished.rows[0]!.v.status).toBe('collected');
    } finally {
      await pg.query('reset role');
    }
    await replica('update public.dialpad_recording_captures set status=\'sealed\' where id=$1 and org_id=$2', [captureId, ORG]);
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    expect(input.rows[0]!.v.status).toBe('eligible');
    expect(input.rows[0]!.v.eligibleSamples).toBe(4_800_320);
    await pg.query('select public.fn_finalize_dialpad_recording_provider_window($1,$2,$3,$4)', [ORG,captureId,POLICY,input.rows[0]!.v.inputDigest]);
    await pg.query('set role authenticated');
    await pg.query('select set_config(\'request.jwt.claim.sub\',$1,false)', [OWNER]);
    try {
      const kpis = await pg.query<{v:FinalizerJson}>('select public.fn_get_acquisition_kpis($1,$2,now()-interval \'1 day\',now()+interval \'1 day\') v',[ORG,OWNER]);
      expect(kpis.rows[0]!.v.conversationsOverFiveMinutes).toBe(1);
    } finally {
      await pg.query('reset role');
    }
  });

  it('keeps the finalizer service-only and enforces representative ownership', async () => {
    const input = await pg.query<{v:FinalizerJson}>('select public.fn_get_dialpad_recording_final_input($1,$2,$3) v',[ORG,captureId,POLICY]);
    await pg.query('set role anon');
    await expect(pg.query('select public.fn_get_dialpad_recording_final_input($1,$2,$3)', [ORG,captureId,POLICY])).rejects.toMatchObject({ code: '42501' });
    await pg.query('reset role');
    await pg.query('set role authenticated');
    await expect(pg.query('select public.fn_get_dialpad_recording_final_input($1,$2,$3)', [ORG,captureId,POLICY])).rejects.toMatchObject({ code: '42501' });
    await pg.query('reset role');
    expect((await pg.query<{service_ok:boolean; anon_ok:boolean; authenticated_ok:boolean}>("select has_function_privilege('service_role','public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text)','EXECUTE') as service_ok, has_function_privilege('anon','public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text)','EXECUTE') as anon_ok, has_function_privilege('authenticated','public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text)','EXECUTE') as authenticated_ok")).rows[0]).toEqual({ service_ok: true, anon_ok: false, authenticated_ok: false });
    await expect(pg.query('select public.fn_get_dialpad_recording_provider_window_result($1,$2,$3)', [ORG, uuid(), captureId])).rejects.toMatchObject({ code: 'P0002' });
    await expect(pg.query('select public.fn_get_dialpad_recording_provider_window_result($1,$2,$3)', ['00000000-0000-0000-0000-00000000f399', OWNER, captureId])).rejects.toMatchObject({ code: 'P0002' });
    expect(input.rows[0]!.v.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
