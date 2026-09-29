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

function anchor(track: 'tab' | 'mic', seq: number, kind: 'start' | 'final' = 'start') {
  return { kind: 'anchor', track, seq, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, anchor: kind, contextFrame: seq * 128, sourceCursor: seq * 128, blockLength: kind === 'final' ? 0 : 128, sourceRateHz: 48_000, outputCursor: seq * 40, outputFrameIndex: 0, phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: seq === 0 ? null : (seq - 1) * 128, discardedTailSamples: kind === 'final' ? 0 : null }
}

function context(track: 'tab' | 'mic', seq: number, observation: 'start' | 'final', browserTimeOriginMs = 4) {
  return { kind: 'context_clock', track, seq, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, observation, browserBeforeMs: 1 + seq, contextTimeMs: 2 + seq, browserAfterMs: 3 + seq, browserTimeOriginMs, state: 'running' }
}

function exchange() {
  return { kind: 'exchange', seq: 0, serverClockId: clockId, browserSendMs: 1, browserReceiveMs: 3, serverReceiveMonoMs: 1.5, serverSendMonoMs: 2, serverReceiveWallMs: 10, serverSendWallMs: 9 }
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
    const records = [anchor('tab', 0), anchor('tab', 1), anchor('tab', 2, 'final')]
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
    expect(result.rows[0]!.value).toEqual({ status: 'collected', reasons: [] })
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
    expect((await pg.query<{ insert_ok: boolean; select_ok: boolean }>("select has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'INSERT') as insert_ok, has_table_privilege('service_role', 'public.dialpad_recording_timing_batches', 'SELECT') as select_ok")).rows[0]).toEqual({ insert_ok: false, select_ok: true })
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

  it('keeps a clock-origin disagreement observational and incomplete', async () => {
    const fixture = await seed()
    const records = [anchor('tab', 0), anchor('tab', 1, 'final'), anchor('mic', 0), anchor('mic', 1, 'final'), context('tab', 0, 'start'), context('tab', 1, 'final'), context('mic', 0, 'start', 4), context('mic', 1, 'final', 5), exchange()]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded' })
    await pg.query('set role service_role')
    try {
      const result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 1, micAnchor: 1, tabContext: 1, micContext: 1, exchange: 0 }), 'collected', '[]'])
      expect(result.rows[0]!.value).toEqual({ status: 'incomplete', reasons: ['clock_discontinuity'] })
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
