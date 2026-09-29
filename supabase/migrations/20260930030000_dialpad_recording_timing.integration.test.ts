import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url'

const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/postgres')
const orgId = '00000000-0000-0000-0000-000000000102'
const makeId = () => crypto.randomUUID()
const nonce = 'a'.repeat(64)
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
  return { kind: 'anchor', track, seq, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, anchor: kind, contextFrame: seq * 128, sourceCursor: seq * 128, blockLength: kind === 'final' ? 0 : 128, sourceRateHz: 48_000, outputCursor: seq * 40, outputFrameIndex: 0, phaseNumerator: 0, continuity: 'continuous', previousContextEndFrame: seq === 0 ? null : (seq - 1) * 128, discardedTailSamples: kind === 'final' ? 0 : null, uncertainOutputStartSample: null, uncertainOutputEndSample: null }
}

function context(track: 'tab' | 'mic') {
  return { kind: 'context_clock', track, seq: 0, contextId: `00000000-0000-4000-8000-00000000000${track === 'tab' ? '1' : '2'}`, observation: 'final', browserBeforeMs: 1, contextTimeMs: 2, browserAfterMs: 3, browserTimeOriginMs: 4, state: 'running' }
}

function exchange() {
  return { kind: 'exchange', track: 'tab', seq: 0, serverClockId: clockId, nonce, browserSendMs: 1, browserReceiveMs: 3, serverReceiveMonoMs: 1.5, serverSendMonoMs: 2, serverReceiveWallMs: 10, serverSendWallMs: 11 }
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
  })

  it('accepts a complete collected barrier only after both tracks, clocks and exchange exist', async () => {
    const fixture = await seed()
    const records = [anchor('tab', 0, 'final'), anchor('mic', 0, 'final'), context('tab'), context('mic'), exchange()]
    expect(await append(fixture, records)).toMatchObject({ status: 'recorded', recordCount: 5 })
    await pg.query('set role service_role')
    let result!: { rows: { value: { status: string; reasons: string[] } }[] }
    try {
      result = await pg.query<{ value: { status: string; reasons: string[] } }>('select public.fn_finish_dialpad_recording_timing($1,$2,1,$3,$4,$5) as value', [orgId, fixture.captureId, JSON.stringify({ tabAnchor: 0, micAnchor: 0, tabContext: 0, micContext: 0, exchange: 0 }), 'collected', '[]'])
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
})
