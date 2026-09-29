import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url'

const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/postgres')
const orgId = '00000000-0000-0000-0000-000000000102'
const makeId = () => crypto.randomUUID()
const clockId = '00000000-0000-4000-8000-000000000003'

type Fixture = { captureId: string; batchId: string }
let pg: Client

async function seed(): Promise<Fixture> {
  const captureId = makeId()
  const batchId = makeId()
  const intentId = makeId()
  const repId = makeId()
  const callId = makeId()
  await pg.query('set session_replication_role = replica')
  await pg.query('insert into public.dialpad_recording_captures(id,org_id,intent_id,rep_user_id,call_activity_id,provider_call_id) values ($1,$2,$3,$4,$5,$6)', [captureId, orgId, intentId, repId, callId, '123'])
  await pg.query('insert into public.dialpad_recording_ingest_grants(id,org_id,capture_id,rep_user_id,epoch,token_hash,created_at,expires_at,consumed_at,consumed_by) values ($1,$2,$3,$4,1,$5,now()-interval \'1 minute\',now()+interval \'1 minute\',now(),\'timing-test\')', [makeId(), orgId, captureId, repId, `${makeId().replaceAll('-', '')}${makeId().replaceAll('-', '')}`])
  await pg.query('set session_replication_role = origin')
  return { captureId, batchId }
}

function anchor(track: 'tab' | 'mic', seq: number, kind: 'start' | 'periodic' | 'final' = 'start') {
  const sourceCursor = seq * 128
  const outputCursor = Math.trunc(sourceCursor * 16_000 / 48_000)
  return { kind: 'anchor', track, seq, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, anchor: kind, contextFrame: sourceCursor, sourceCursor, blockLength: kind === 'final' ? 0 : 128, sourceRateHz: 48_000, outputCursor, outputFrameIndex: Math.trunc(outputCursor / 320), phaseNumerator: (outputCursor * 48_000) % 16_000, continuity: 'continuous', previousContextEndFrame: seq === 0 ? null : sourceCursor, discardedTailSamples: kind === 'final' ? outputCursor - Math.trunc(outputCursor / 320) * 320 : null }
}

function context(track: 'tab' | 'mic', seq: number, observation: 'start' | 'final', browserTimeOriginMs = 4) {
  return { kind: 'context_clock', track, seq, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, observation, browserBeforeMs: 1 + seq, contextTimeMs: 2 + seq, browserAfterMs: 3 + seq, browserTimeOriginMs, state: 'running' }
}

function exchange() {
  return { kind: 'exchange', seq: 0, serverClockId: clockId, browserSendMs: 1, browserReceiveMs: 3, serverReceiveMonoMs: 1.5, serverSendMonoMs: 2, serverReceiveWallMs: 10, serverSendWallMs: 9 }
}

function sparseAnchor(track: 'tab' | 'mic', seq: number, anchorKind: 'start' | 'periodic' | 'final', gapped = false) {
  const contextId = `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`
  if (seq === 0) return anchor(track, 0)
  if (anchorKind === 'periodic') {
    return { ...anchor(track, seq), anchor: 'periodic' as const, contextFrame: 480_128, sourceCursor: 480_128, blockLength: 128, outputCursor: 160_042, outputFrameIndex: 500, previousContextEndFrame: 480_128, contextId }
  }
  return { ...anchor(track, seq, 'final'), contextFrame: gapped ? 480_100 : 480_256, sourceCursor: gapped ? 480_100 : 480_256, outputCursor: gapped ? 160_033 : 160_085, outputFrameIndex: 500, phaseNumerator: 0, previousContextEndFrame: gapped ? 480_100 : 480_256, discardedTailSamples: gapped ? 33 : 85, contextId }
}

function sparseCompleteRecords(gapped = false) {
  return [
    sparseAnchor('tab', 0, 'start', gapped), sparseAnchor('tab', 1, 'periodic', gapped), sparseAnchor('tab', 2, 'final', gapped),
    sparseAnchor('mic', 0, 'start', gapped), sparseAnchor('mic', 1, 'periodic', gapped), sparseAnchor('mic', 2, 'final', gapped),
    context('tab', 0, 'start'), context('tab', 1, 'final'), context('mic', 0, 'start'), context('mic', 1, 'final'), exchange(),
  ]
}

async function append(fixture: Fixture, records: unknown[], batchId = fixture.batchId) {
  await pg.query('set role service_role')
  try {
    return (await pg.query<{ value: unknown }>('select public.fn_append_dialpad_recording_timing($1,$2,1,$3,$4) as value', [orgId, fixture.captureId, batchId, JSON.stringify(records)])).rows[0]!.value
  } finally { await pg.query('reset role') }
}

describe('Dialpad timing migration', () => {
  beforeAll(async () => { pg = new Client({ connectionString: dbUrl }); await pg.connect() })
  afterAll(async () => { await pg.end() })
  afterEach(async () => {
    await pg.query('set session_replication_role = replica')
    try {
      await pg.query('delete from public.dialpad_recording_timing_state where org_id=$1', [orgId])
      await pg.query('delete from public.dialpad_recording_timing_records where org_id=$1', [orgId])
      await pg.query('delete from public.dialpad_recording_timing_batches where org_id=$1', [orgId])
      await pg.query('delete from public.dialpad_recording_ingest_grants where org_id=$1', [orgId])
      await pg.query('delete from public.dialpad_recording_captures where org_id=$1', [orgId])
    } finally { await pg.query('set session_replication_role = origin') }
  })

  it('persists exact records, replays an identical batch, rejects changed replay and requires final evidence', async () => {
    const fixture = await seed()
    const records = [anchor('tab', 0), anchor('tab', 1, 'periodic'), anchor('tab', 2, 'final')]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded', recordCount: 3 })
    expect(await append(fixture, records)).toMatchObject({ status: 'replayed' })
    await expect(append(fixture, [anchor('tab', 0, 'final')])).rejects.toMatchObject({ code: '40001' })
    await pg.query('set role service_role')
    let result!: { rows: { value: { status: string; reasons: string[] } }[] }
    try {
      result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }), 'collected', '[]'])
    } finally { await pg.query('reset role') }
    expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['missing_final'] })
    expect(await append(fixture, records)).toMatchObject({ status: 'replayed' })
    await expect(append(fixture, [anchor('tab', 0, 'final')])).rejects.toMatchObject({ code: '40001' })
    await pg.query('set role service_role')
    try {
      await expect(pg.query<{ value: unknown }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }), 'incomplete', '["missing_final"]'])).rejects.toMatchObject({ code: '40001' })
    } finally { await pg.query('reset role') }
  })

  it('accepts a complete collected barrier only after both tracks, clocks and exchange exist', async () => {
    const fixture = await seed()
    const records = [anchor('tab', 0), anchor('tab', 1, 'final'), anchor('mic', 0), anchor('mic', 1, 'final'), context('tab', 0, 'start'), context('tab', 1, 'final'), context('mic', 0, 'start'), context('mic', 1, 'final'), exchange()]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded', recordCount: 9 })
    await pg.query('set role service_role')
    let result!: { rows: { value: { status: string; reasons: string[] } }[] }
    try {
      result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
    } finally { await pg.query('reset role') }
    expect(result.rows[0]!.value).toMatchObject({ status: 'collected', reasons: [], persistedSequences: { tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 }, lastSequences: { tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 } })
  })

  it('accepts sparse periodic anchors when the final geometry is monotonic', async () => {
    const fixture = await seed()
    const records = sparseCompleteRecords()
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded', recordCount: records.length })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'collected', reasons: [] })
    } finally { await pg.query('reset role') }
  })

  it('downgrades a genuine final geometry gap while preserving the persisted watermark', async () => {
    const fixture = await seed()
    const records = sparseCompleteRecords(true)
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded', recordCount: records.length })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[]; persistedSequences: Record<string, number> } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['sequence_gap'], persistedSequences: { tabAnchor: 2, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 0 } })
    } finally { await pg.query('reset role') }
  })

  it('persists actual P separately when an incomplete browser watermark B is behind it', async () => {
    const fixture = await seed()
    expect(await append(fixture, [anchor('tab', 0)])).toMatchObject({ status: 'recorded' })
    const request = JSON.stringify({ tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; persistedSequences: Record<string, number>; lastSequences: Record<string, number>; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, request, 'incomplete', '["missing_final"]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', persistedSequences: { tabAnchor: 0, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }, lastSequences: { tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }, reasons: ['missing_final'] })
      const state = await pg.query<{ persisted_sequences: Record<string, number>; last_sequences: Record<string, number> }>('select persisted_sequences,last_sequences from public.dialpad_recording_timing_state where capture_id=$1 and epoch=1', [fixture.captureId])
      expect(state.rows[0]).toEqual({ persisted_sequences: { tabAnchor: 0, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }, last_sequences: { tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 } })
      await expect(pg.query('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5)', [orgId, fixture.captureId, request, 'incomplete', '["missing_final"]'])).resolves.toBeTruthy()
      await expect(pg.query('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5)', [orgId, fixture.captureId, JSON.stringify({ ...JSON.parse(request), tabAnchor: 0 }), 'incomplete', '["missing_final"]'])).rejects.toMatchObject({ code: '40001' })
    } finally { await pg.query('reset role') }
  })

  it('serializes same-batch appends across independent clients', async () => {
    const fixture = await seed()
    const other = new Client({ connectionString: dbUrl }); await other.connect()
    const payload = JSON.stringify([anchor('tab', 0)])
    const run = async (client: Client) => { await client.query('set role service_role'); try { return (await client.query('select public.fn_append_dialpad_recording_timing($1,$2,1,$3,$4) as value', [orgId, fixture.captureId, fixture.batchId, payload])).rows[0]!.value } finally { await client.query('reset role') } }
    const results = await Promise.all([run(pg), run(other)])
    await other.end()
    expect(results.map((value) => (value as { status: string }).status).sort()).toEqual(['recorded', 'replayed'])
  })

  it('enforces batch limits and service-only execution', async () => {
    const fixture = await seed()
    await expect(append(fixture, Array.from({ length: 17 }, (_, seq) => anchor('tab', seq)))).rejects.toMatchObject({ code: '22023' })
    await pg.query('set role anon')
    await expect(pg.query('select public.fn_append_dialpad_recording_timing($1,$2,1,$3,$4)', [orgId, fixture.captureId, fixture.batchId, JSON.stringify([anchor('tab', 0)])])).rejects.toMatchObject({ code: '42501' })
    await pg.query('reset role')
    expect((await pg.query<{ insert_ok: boolean; select_ok: boolean; update_ok: boolean; delete_ok: boolean; truncate_ok: boolean }>("select has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'INSERT') as insert_ok, has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'SELECT') as select_ok, has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'UPDATE') as update_ok, has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'DELETE') as delete_ok, has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'TRUNCATE') as truncate_ok")).rows[0]).toEqual({ insert_ok: false, select_ok: true, update_ok: false, delete_ok: false, truncate_ok: false })
    expect((await pg.query<{ execute_ok: boolean; anon_execute: boolean }>("select has_function_privilege('service_role', 'public.fn_append_dialpad_recording_timing(uuid,uuid,integer,uuid,jsonb)', 'EXECUTE') as execute_ok, has_function_privilege('anon', 'public.fn_append_dialpad_recording_timing(uuid,uuid,integer,uuid,jsonb)', 'EXECUTE') as anon_execute")).rows[0]).toEqual({ execute_ok: true, anon_execute: false })
  })

  it('rejects cross-track context reuse and finish sequence mismatches', async () => {
    const fixture = await seed()
    const tab = anchor('tab', 0)
    const reused = { ...anchor('mic', 0), contextId: tab.contextId }
    await expect(append(fixture, [tab, reused])).rejects.toMatchObject({ code: '22023' })
    expect((await pg.query('select count(*)::int as n from public.dialpad_recording_timing_batches where capture_id=$1', [fixture.captureId])).rows[0]!.n).toBe(0)

    expect(await append(fixture, [anchor('tab', 0)])).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      await expect(pg.query('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5)', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }), 'incomplete', '[]'])).rejects.toMatchObject({ code: '22023' })
    } finally { await pg.query('reset role') }
  })

  it('fences new evidence to the latest consumed epoch while allowing exact replay', async () => {
    const fixture = await seed()
    await pg.query('set session_replication_role = replica')
    await pg.query('insert into public.dialpad_recording_ingest_grants(id,org_id,capture_id,rep_user_id,epoch,token_hash,created_at,expires_at,consumed_at,consumed_by) values ($1,$2,$3,$4,2,$5,now()-interval \'1 minute\',now()+interval \'1 minute\',now(),\'timing-test-next\')', [makeId(), orgId, fixture.captureId, makeId(), `${makeId().replaceAll('-', '')}${makeId().replaceAll('-', '')}`])
    await pg.query('set session_replication_role = origin')
    await expect(append(fixture, [anchor('tab', 0)], makeId())).rejects.toMatchObject({ code: '55000' })
  })

  it('charges batch metadata against the bounded observation quota', async () => {
    const fixture = await seed()
    await pg.query('set session_replication_role = replica')
    await pg.query("insert into public.dialpad_recording_timing_batches(capture_id,org_id,epoch,batch_id,content_hash,record_count,payload_bytes) select $1,$2,1,gen_random_uuid(),repeat('a',64),1,1 from generate_series(1,8192)", [fixture.captureId, orgId])
    await pg.query('set session_replication_role = origin')
    await expect(append(fixture, [anchor('tab', 0)], makeId())).rejects.toMatchObject({ code: '22023' })
  })

  it('charges bytes for a new record in addition to batch payload bytes', async () => {
    const fixture = await seed()
    await pg.query('set session_replication_role = replica')
    await pg.query("insert into public.dialpad_recording_timing_records(capture_id,org_id,epoch,stream,seq,content_hash,record,payload_bytes) select $1,$2,1,'tab:anchor',seq,repeat('a',64),'{}'::jsonb,2048 from generate_series(0,8190) seq", [fixture.captureId, orgId])
    await pg.query("insert into public.dialpad_recording_timing_batches(capture_id,org_id,epoch,batch_id,content_hash,record_count,payload_bytes) values ($1,$2,1,$3,repeat('b',64),1,1500)", [fixture.captureId, orgId, makeId()])
    await pg.query('set session_replication_role = origin')
    await expect(append(fixture, [anchor('tab', 8191)], makeId())).rejects.toMatchObject({ code: '22023' })
  })

  it('keeps a clock-origin disagreement observational and incomplete', async () => {
    const fixture = await seed()
    const records = [anchor('tab', 0), anchor('tab', 1, 'final'), anchor('mic', 0), anchor('mic', 1, 'final'), context('tab', 0, 'start'), context('tab', 1, 'final'), context('mic', 0, 'start', 4), context('mic', 1, 'final', 5), exchange()]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['clock_discontinuity'], persistedSequences: { tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 } })
    } finally { await pg.query('reset role') }
  })

  it('rejects nullable identity and unsafe numeric input, and detects conflicting server clocks', async () => {
    const invalidIdentity = await seed()
    await expect(append(invalidIdentity, [{ ...anchor('tab', 0), track: null }])).rejects.toMatchObject({ code: '22023' })
    const invalidNumber = await seed()
    await expect(append(invalidNumber, [{ ...anchor('tab', 0), sourceCursor: 9_007_199_254_740_992 }])).rejects.toMatchObject({ code: '22023' })

    const clocks = await seed()
    const secondClock = { ...exchange(), seq: 1, serverClockId: '00000000-0000-4000-8000-000000000004' }
    const records = [...sparseCompleteRecords(), secondClock]
    expect(await append(clocks, records)).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, clocks.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 1 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['clock_discontinuity'] })
    } finally { await pg.query('reset role') }

    const wall = await seed()
    const backwardsWall = { ...exchange(), seq: 1, browserSendMs: 4, browserReceiveMs: 6, serverReceiveMonoMs: 3.5, serverSendMonoMs: 4, serverReceiveWallMs: 8, serverSendWallMs: 7 }
    expect(await append(wall, [...sparseCompleteRecords(), backwardsWall])).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, wall.captureId, JSON.stringify({ tabAnchor: 2, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 1 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['clock_discontinuity'] })
    } finally { await pg.query('reset role') }
  })

  it('rejects an anchor stream with a post-final record', async () => {
    const fixture = await seed()
    const records = [...sparseCompleteRecords(), { ...anchor('tab', 3), anchor: 'periodic' as const, contextFrame: 480_384, sourceCursor: 480_384, outputCursor: 160_120, outputFrameIndex: 500, previousContextEndFrame: 480_384 }]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 3, micAnchor: 2, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toMatchObject({ status: 'incomplete', reasons: ['sequence_gap'] })
    } finally { await pg.query('reset role') }
  })

  it('rejects new writes after the signed drain deadline', async () => {
    const fixture = await seed()
    await pg.query('set session_replication_role = replica')
    await pg.query("update public.dialpad_recording_captures set status='closing', closed_at=now(), close_reason='rep_closed', drain_deadline_at=now()-interval '1 second' where id=$1", [fixture.captureId])
    await pg.query('set session_replication_role = origin')
    await expect(append(fixture, [anchor('tab', 0)], makeId())).rejects.toMatchObject({ code: '55000' })
    await pg.query('set role service_role')
    try {
      await expect(pg.query('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5)', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }), 'incomplete', '[]'])).rejects.toMatchObject({ code: '55000' })
    } finally { await pg.query('reset role') }
  })
})
