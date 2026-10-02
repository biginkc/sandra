import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import WebSocket from 'ws'
import { assertSecret, createCoachToken, createWatchdogToken, verifyCoachToken } from '../src/auth.js'
import { parseMedia, parseStart } from '../src/media.js'
import { MediaIntegrityError, MediaOrderBuffer } from '../src/order.js'
import { computeScriptDigest, type ScriptBundle } from '../src/script-bundle.js'
import { CoachSession } from '../src/session.js'
import { SupabaseDirectCoachDb } from '../src/db.js'
import { SupabaseCoachPublisher } from '../src/publisher.js'
import { createCoachServer } from '../src/server.js'
import type { CoachClaims, CoachLogger, CoachPublisher, DirectCoachBinding, DirectCoachDb } from '../src/types.js'
import type { DeepgramLiveBridge, DeepgramLiveBridgeOptions } from '../src/approved/deepgram-live.js'
import type { ObjectionPromptCall } from '../src/approved/objection-prompt/index.js'
import type { CoachWireMessage } from '../src/approved/wire-contract.js'

const SECRET = '01234567890123456789012345678901'
const claims: CoachClaims = { callId: 'call-1', sellerLegId: 'seller-leg-1', expiresAtMs: 1_000_000 }
const bundle: ScriptBundle = { schema_version: 3, script: { version: '1.2.3' }, sections: { sections: [] } }
const binding: DirectCoachBinding = { ...claims, ownerUserId: 'owner', orgId: 'org', scriptSlug: 'closr-outbound', scriptRevision: 1, scriptDigest: 'a'.repeat(64), bundle }
const logger: CoachLogger = { info() {}, warn() {}, error() {} }

test('capability token verifies with exact timing-safe claims and rejects tampering/expiry', () => {
  const token = createCoachToken(claims, SECRET)
  assert.deepEqual(verifyCoachToken(token, SECRET, 900_000), claims)
  assert.throws(() => verifyCoachToken(`${token.slice(0, -1)}x`, SECRET, 900_000))
  assert.throws(() => verifyCoachToken(createCoachToken({ ...claims, expiresAtMs: 899_999 }, SECRET), SECRET, 900_000))
  assert.throws(() => verifyCoachToken(createCoachToken({ ...claims, expiresAtMs: 1_110_001 }, SECRET), SECRET, 900_000))
  assert.throws(() => assertSecret('short'))
})

test('media format and call-control binding fail closed before a bridge is created', () => {
  assert.deepEqual(parseStart({ call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } }), { callControlId: 'seller-leg-1', encoding: 'pcmu', sampleRate: 8000, channels: 1 })
  assert.throws(() => parseStart({ call_control_id: 'seller-leg-1', media_format: { encoding: 'L16', sample_rate: 16000, channels: 1 } }))
  assert.deepEqual(parseMedia({ media: { chunk: '1', track: 'inbound', payload: Buffer.from([0x7f]).toString('base64') } }, 123).payload, Buffer.from([0x7f]))
})

test('global media chunks reorder across tracks and persistent gaps are errors', () => {
  const delivered: number[] = []
  const order = new MediaOrderBuffer((media) => delivered.push(media.chunk), { maxGapMs: 10 })
  order.push({ chunk: 2, track: 'outbound', payload: Buffer.from([2]), receivedAtMs: 100 }, 100)
  order.push({ chunk: 1, track: 'inbound', payload: Buffer.from([1]), receivedAtMs: 101 }, 101)
  assert.deepEqual(delivered, [1, 2])
  const gap = new MediaOrderBuffer(() => {}, { maxGapMs: 1 })
  gap.push({ chunk: 1, track: 'inbound', payload: Buffer.from([1]), receivedAtMs: 0 }, 0)
  gap.push({ chunk: 3, track: 'outbound', payload: Buffer.from([3]), receivedAtMs: 2 }, 2)
  assert.throws(() => gap.push({ chunk: 4, track: 'outbound', payload: Buffer.from([4]), receivedAtMs: 4 }, 4), MediaIntegrityError)
  assert.throws(() => gap.finish(), MediaIntegrityError)
})

test('session admits only a matching start and routes seller/rep tracks with seller-only interim coaching', async () => {
  let now = Date.now()
  let readCount = 0
  const db: DirectCoachDb = { readBinding: async () => { readCount += 1; return binding }, isActive: async () => true, close: async () => {} }
  const published: CoachWireMessage[] = []
  const publisher: CoachPublisher = { publish: async (_callId, message) => { published.push(message) }, close: async () => {}, closeAll: async () => {} }
  const bridges: DeepgramLiveBridgeOptions[] = []
  const bridge: DeepgramLiveBridge = { send() {}, close: async () => {} }
  const interim: string[] = []
  const finals: string[] = []
  const finalAnchors: Array<number | undefined> = []
  const fakeObjection = { onInterim: (text: string) => interim.push(text), onFinal: (_speaker: string, text: string, _receivedAt: number, _words: unknown, anchor?: number) => { finals.push(text); finalAnchors.push(anchor) }, close() {} } as unknown as ObjectionPromptCall
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: (options) => { bridges.push(options); return bridge },
    objectionFactory: () => fakeObjection,
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'wrong-leg', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  assert.equal(bridges.length, 0)
  const valid = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    now: () => now++,
    bridgeFactory: (options) => { bridges.push(options); return bridge }, objectionFactory: () => fakeObjection,
  })
  try {
    valid.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
    await tick()
    await tick()
    assert.equal(readCount >= 1, true)
    assert.equal(bridges.length, 2)
    bridges[0]!.onOpen?.(111)
    bridges[1]!.onOpen?.(222)
    bridges[0]!.onTranscript?.({ isFinal: false, text: 'seller interim phrase', words: [], confidence: 1 })
    bridges[1]!.onTranscript?.({ isFinal: false, text: 'rep interim phrase', words: [], confidence: 1 })
    bridges[0]!.onTranscript?.({ isFinal: true, text: 'seller final', words: [], confidence: 1 })
    bridges[1]!.onTranscript?.({ isFinal: true, text: 'rep final', words: [], confidence: 1 })
    await tick()
    await tick()
    assert.deepEqual(interim, ['seller interim phrase'])
    assert.deepEqual(finals, ['seller final', 'rep final'])
    assert.deepEqual(finalAnchors, [111, 222])
    assert.deepEqual(published.map((message) => message.type), ['transcript', 'transcript'])
    assert.equal(published.some((message) => message.type === 'transcript' && message.text === 'seller final'), true)
    assert.equal(published.some((message) => message.type === 'transcript' && message.text === 'rep final'), true)
  } finally { await valid.finish('test') }
})

test('connected preamble is ignored and a prestart timeout releases the session', async () => {
  let closed = 0
  const db: DirectCoachDb = { readBinding: async () => binding, isActive: async () => true, close: async () => {} }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => { closed += 1 }, closeAll: async () => {} }
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger, preStartTimeoutMs: 5,
    bridgeFactory: () => ({ send() {}, close: async () => {} }), objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'connected' })))
  await tick()
  assert.equal(closed, 0)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(closed, 1)
})

test('disconnect during binding read does not allocate paid bridges', async () => {
  let resolveBinding: ((value: DirectCoachBinding) => void) | undefined
  const db: DirectCoachDb = { readBinding: () => new Promise((resolve) => { resolveBinding = resolve }), isActive: async () => true, close: async () => {} }
  let bridgeCount = 0
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: () => { bridgeCount += 1; return { send() {}, close: async () => {} } }, objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  const finishing = session.finish('disconnect')
  resolveBinding?.(binding)
  await finishing
  assert.equal(bridgeCount, 0)
})

test('pre-start buffering retains 320 real frames while authorization exceeds three seconds', async () => {
  let resolveBinding!: (value: DirectCoachBinding) => void
  const db: DirectCoachDb = { readBinding: () => new Promise((resolve) => { resolveBinding = resolve }), isActive: async () => true, close: async () => {} }
  const sent: number[] = []
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: () => ({ send: (payload: Buffer) => { sent.push(payload.length) }, close: async () => {} }),
    objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  const payload = Buffer.alloc(160, 0x7f).toString('base64')
  for (let chunk = 1; chunk <= 320; chunk += 1) session.handle(Buffer.from(JSON.stringify({ event: 'media', media: { chunk: String(chunk), track: 'inbound', payload } })))
  await new Promise((resolve) => setTimeout(resolve, 3_050))
  assert.deepEqual(sent, [])
  resolveBinding(binding)
  await tick()
  await tick()
  assert.equal(sent.length, 320)
  assert.equal(sent.every((size) => size === 160), true)
  await session.finish('test')
})

test('graceful close drains a real final transcript before output closes', async () => {
  const db: DirectCoachDb = { readBinding: async () => binding, isActive: async () => true, close: async () => {} }
  const published: CoachWireMessage[] = []
  const publisher: CoachPublisher = { publish: async (_id, message) => { published.push(message) }, close: async () => {}, closeAll: async () => {} }
  const bridgeOptions: DeepgramLiveBridgeOptions[] = []
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: (options) => { bridgeOptions.push(options); return { send() {}, close: async () => { options.onTranscript?.({ isFinal: true, text: 'final seller statement', words: [], confidence: 1 }) } } },
    objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  await session.finish('provider_stop')
  assert.equal(bridgeOptions.length, 2)
  assert.equal(published.some((message) => message.type === 'transcript' && message.isFinal), true)
})

test('session closes on stream limits and never sends more after closure', async () => {
  const db: DirectCoachDb = { readBinding: async () => binding, isActive: async () => true, close: async () => {} }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  let closed = false
  const bridge: DeepgramLiveBridge = { send() {}, close: async () => { closed = true } }
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: () => bridge, objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  const payload = Buffer.alloc(64_000, 0x7f).toString('base64')
  for (let chunk = 1; chunk <= 50; chunk += 1) session.handle(Buffer.from(JSON.stringify({ event: 'media', media: { chunk: String(chunk), track: chunk % 2 ? 'inbound' : 'outbound', payload } })))
  await tick()
  assert.equal(closed, true)
})

test('approved digest canonicalization remains deterministic', () => {
  const expected = createHash('sha256').update(JSON.stringify({ a: 1, schema_version: 3, script: { version: '1.2.3' }, sections: { sections: [] }, z: { a: 2, b: 3 } })).digest('hex')
  assert.equal(computeScriptDigest({ ...bundle, z: { b: 3, a: 2 }, a: 1 }), expected)
})

test('digest matches the installed approved closr-outbound fixture and captured chunks prove global interleave', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/closr-outbound-123.bundle.json', import.meta.url), 'utf8')) as ScriptBundle
  assert.equal(computeScriptDigest(fixture), 'a01ff92373c6da03906a788badd84567dd35d69c084b75b235cc0eca2429a6d6')
  const prefix = readFileSync(new URL('./fixtures/media-prefix.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { track: string; chunk: number; sequence: number })
  assert.deepEqual(prefix.slice(0, 6), [
    { track: 'inbound', chunk: 1, sequence: 0 }, { track: 'outbound', chunk: 2, sequence: 1 },
    { track: 'inbound', chunk: 3, sequence: 2 }, { track: 'outbound', chunk: 4, sequence: 3 },
    { track: 'inbound', chunk: 5, sequence: 4 }, { track: 'outbound', chunk: 6, sequence: 5 },
  ])
  assert.equal(new Set(prefix.map((row) => row.chunk)).size, prefix.length)
  assert.deepEqual(prefix.map((row) => row.sequence), [...prefix.keys()])
})

test('Supabase binding fails closed on membership/query timeout and accepts the exact reviewed tuple', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/closr-outbound-123.bundle.json', import.meta.url), 'utf8')) as ScriptBundle
  const digest = computeScriptDigest(fixture)
  const rows: Record<string, unknown> = {
    direct_calls: { id: claims.callId, seller_leg_id: claims.sellerLegId, operator_user_id: 'owner', org_id: 'org', status: 'connected' },
    memberships: { user_id: 'owner', org_id: 'org', acquisitions_enabled: true, access_status: 'active', access_expires_at: null, deletion_prepared_at: null },
    coach_call_index: { client_call_id: claims.callId, operator_user_id: 'owner', script_slug: 'closr-outbound', script_revision: 1, script_digest: digest },
    coach_script_revisions: { slug: 'closr-outbound', revision: 1, digest, bundle: fixture, import_status: 'reviewed' },
  }
  const client = { from(table: string) { const row = rows[table]; return { select() { return this }, eq() { return this }, in() { return this }, abortSignal() { return this }, maybeSingle: async () => ({ data: row, error: null }) } } }
  const db = new SupabaseDirectCoachDb(client as never, 20)
  const result = await db.readBinding(claims)
  assert.equal(result?.scriptDigest, digest)
  ;(rows.memberships as Record<string, unknown>).acquisitions_enabled = false
  assert.equal(await db.readBinding(claims), null)
  const hangingSignals: AbortSignal[] = []
  const hanging = { from() { return { select() { return this }, eq() { return this }, in() { return this }, abortSignal(signal: AbortSignal) { hangingSignals.push(signal); return this }, maybeSingle: () => new Promise<never>(() => {}) } } }
  assert.equal(await new SupabaseDirectCoachDb(hanging as never, 5).readBinding(claims), null)
  assert.equal(hangingSignals.length, 1)
  assert.equal(hangingSignals[0]?.aborted, true)
})

test('active-state auth errors fail closed on the first recheck', async () => {
  let activeChecks = 0
  let publisherClosed = 0
  const db: DirectCoachDb = { readBinding: async () => binding, isActive: async () => { activeChecks += 1; throw new Error('membership unavailable') }, close: async () => {} }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => { publisherClosed += 1 }, closeAll: async () => {} }
  const session = new CoachSession({} as never, { ...claims, expiresAtMs: Date.now() + 100_000 }, binding, {
    db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    bridgeFactory: () => ({ send() {}, close: async () => {} }), objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
  })
  session.handle(Buffer.from(JSON.stringify({ event: 'start', start: { call_control_id: 'seller-leg-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })))
  await tick()
  await tick()
  await (session as unknown as { recheckActive(): Promise<void> }).recheckActive()
  await (session as unknown as { recheckActive(): Promise<void> }).recheckActive()
  assert.equal(activeChecks, 1)
  assert.equal(publisherClosed, 1)
})

test('publisher removes a wedged subscription and does not retain a pending call', async () => {
  const removed: unknown[] = []
  const client = {
    channel() { return { subscribe() {}, send: async () => 'ok', } },
    removeChannel(channel: unknown) { removed.push(channel); return Promise.resolve('ok') },
  }
  const publisher = new SupabaseCoachPublisher(client as never, 5)
  await assert.rejects(() => publisher.publish(claims.callId, { scriptVersion: '1.2.3', scriptDigest: 'a'.repeat(64), matcherVersion: 'poc-approved-classifier', type: 'transcript', speaker: 'seller', text: 'x', isFinal: true, ts: new Date().toISOString() }))
  await publisher.closeAll()
  assert.equal(removed.length >= 1, true)
})

test('publisher close fences a retry after an in-flight send and never recreates the channel', async () => {
  let channelCount = 0
  let sendStarted!: () => void
  let rejectSend!: (error: Error) => void
  const started = new Promise<void>((resolve) => { sendStarted = resolve })
  const client = {
    channel() {
      channelCount += 1
      return {
        subscribe(callback: (status: string) => void) { callback('SUBSCRIBED') },
        send: () => { sendStarted(); return new Promise<'ok'>((_, reject) => { rejectSend = reject as (error: Error) => void }) },
      }
    },
    removeChannel() { return Promise.resolve('ok') },
  }
  const publisher = new SupabaseCoachPublisher(client as never, 100)
  const publishing = publisher.publish(claims.callId, { scriptVersion: '1.2.3', scriptDigest: 'a'.repeat(64), matcherVersion: 'poc-approved-classifier', type: 'transcript', speaker: 'seller', text: 'x', isFinal: true, ts: new Date().toISOString() })
  await started
  await publisher.close(claims.callId)
  assert.equal((publisher as unknown as { states: Map<string, unknown> }).states.size, 0)
  rejectSend(new Error('send interrupted'))
  await assert.rejects(publishing)
  assert.equal(channelCount, 1)
})

test('shutdown fences pending upgrades before draining accepted sessions', async () => {
  const callA: CoachClaims = { callId: 'call-a', sellerLegId: 'seller-a', expiresAtMs: Date.now() + 100_000 }
  const callB: CoachClaims = { callId: 'call-b', sellerLegId: 'seller-b', expiresAtMs: Date.now() + 100_000 }
  const callC: CoachClaims = { callId: 'call-c', sellerLegId: 'seller-c', expiresAtMs: Date.now() + 100_000 }
  const bindingFor = (value: CoachClaims): DirectCoachBinding => ({ ...binding, ...value })
  let resolveB!: (value: DirectCoachBinding) => void
  let signalBRead!: () => void
  const bRead = new Promise<void>((resolve) => { signalBRead = resolve })
  const readCalls: string[] = []
  const db: DirectCoachDb = {
    readBinding: async (value) => {
      readCalls.push(value.callId)
      if (value.callId === callA.callId) return bindingFor(callA)
      if (value.callId === callB.callId) { signalBRead(); return new Promise((resolve) => { resolveB = resolve }) }
      return null
    },
    isActive: async () => true,
    close: async () => {},
  }
  const accepted: string[] = []
  const finished: string[] = []
  let signalAFinish!: () => void
  const aFinishStarted = new Promise<void>((resolve) => { signalAFinish = resolve })
  let publisherCloses = 0
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => { publisherCloses += 1 } }
  const service = createCoachServer({
    secret: SECRET, db, publisher, deepgramApiKey: 'deepgram-test-key', jevApiKey: 'jev-test-key', logger,
    sessionFactory: (ws, value, _admitted, onEnd) => {
      accepted.push(value.callId)
      const session = {
        finish: async (reason: string) => {
          finished.push(`${value.callId}:${reason}`)
          if (value.callId === callA.callId) {
            signalAFinish()
            await new Promise<void>((resolve) => { signalAFinish = resolve })
          }
          onEnd()
          ws.close()
        },
        disconnected: () => { onEnd() },
      }
      return session as unknown as CoachSession
    },
  })
  await service.listen(0, '127.0.0.1')
  const address = service.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `ws://127.0.0.1:${address.port}/media`
  const wsA = new WebSocket(`${base}?token=${encodeURIComponent(createCoachToken(callA, SECRET))}`)
  await waitForWebSocketOpen(wsA)
  const wsB = new WebSocket(`${base}?token=${encodeURIComponent(createCoachToken(callB, SECRET))}`)
  const bTerminal = waitForWebSocketTerminal(wsB)
  await bRead
  const closing = service.close()
  await aFinishStarted
  const wsC = new WebSocket(`${base}?token=${encodeURIComponent(createCoachToken(callC, SECRET))}`)
  const cTerminal = waitForWebSocketTerminal(wsC)
  resolveB(bindingFor(callB))
  signalAFinish()
  await Promise.all([closing, bTerminal, cTerminal])
  assert.deepEqual(readCalls, [callA.callId, callB.callId])
  assert.deepEqual(accepted, [callA.callId])
  assert.deepEqual(finished, [`${callA.callId}:server_shutdown`])
  assert.equal(service.activeCalls.size, 0)
  assert.equal(publisherCloses, 1)
})

test('browser presence requires origin and first-frame admission, renews the lease, and distinguishes loss from server shutdown', async () => {
  const presenceClaims = { callId: 'watchdog-call', browserLegId: 'browser-leg', operatorUserId: 'owner', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAtMs: Date.now() + 100_000 }
  const disconnects: boolean[] = []
  let heartbeats = 0
  let renewals = 0
  const db: DirectCoachDb = {
    readBinding: async () => null,
    isActive: async () => true,
    watchdogHeartbeat: async () => { heartbeats += 1 },
    watchdogAttach: async () => true,
    watchdogRenew: async () => { renewals += 1; return true },
    watchdogDisconnect: async ({ abnormal }) => { disconnects.push(abnormal); return true },
    watchdogClaimExpired: async () => [],
    close: async () => {},
  }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  const service = createCoachServer({
    secret: SECRET, db, publisher, deepgramApiKey: 'disabled', jevApiKey: 'disabled', logger,
    watchdog: { secret: SECRET, origins: new Set(['http://localhost']), onExpired: async () => {} },
  })
  await service.listen(0, '127.0.0.1')
  const address = service.server.address()
  assert.ok(address && typeof address === 'object')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/presence`, { headers: { Origin: 'http://localhost' } })
  await waitForWebSocketOpen(ws)
  ws.send(createWatchdogToken(presenceClaims, SECRET))
  assert.deepEqual(JSON.parse((await waitForWebSocketMessage(ws)) as string), { type: 'presence_ack', callId: presenceClaims.callId })
  ws.send(JSON.stringify({ type: 'heartbeat' }))
  assert.deepEqual(JSON.parse((await waitForWebSocketMessage(ws)) as string), { type: 'heartbeat_ack' })
  await new Promise((resolve) => setTimeout(resolve, 2_200))
  assert.equal(renewals >= 1, true)
  ws.terminate()
  await waitForWebSocketTerminal(ws)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(disconnects, [true])
  const replacement = new WebSocket(`ws://127.0.0.1:${address.port}/presence`, { headers: { Origin: 'http://localhost' } })
  await waitForWebSocketOpen(replacement)
  replacement.send(JSON.stringify({ type: 'auth', token: createWatchdogToken(presenceClaims, SECRET) }))
  await waitForWebSocketMessage(replacement)
  const closing = service.close()
  await waitForWebSocketTerminal(replacement)
  await closing
  assert.equal(heartbeats >= 1, true)
  assert.equal(disconnects.at(-1), false)
})

test('watchdog cleanup stays single-flight while two real media sessions and presence pings continue', async () => {
  const callA: CoachClaims = { callId: 'load-call-a', sellerLegId: 'load-seller-a', expiresAtMs: Date.now() + 100_000 }
  const callB: CoachClaims = { callId: 'load-call-b', sellerLegId: 'load-seller-b', expiresAtMs: Date.now() + 100_000 }
  const bindingFor = (value: CoachClaims): DirectCoachBinding => ({ ...binding, ...value })
  let heartbeats = 0
  let renewals = 0
  let claimCalls = 0
  let audioFrames = 0
  let cleanupStarted!: () => void
  let releaseCleanup!: () => void
  const cleanupBegan = new Promise<void>((resolve) => { cleanupStarted = resolve })
  const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve })
  const db: DirectCoachDb = {
    readBinding: async (value) => bindingFor(value),
    isActive: async () => true,
    watchdogHeartbeat: async () => { heartbeats += 1 },
    watchdogAttach: async () => true,
    watchdogRenew: async () => { renewals += 1; return true },
    watchdogDisconnect: async () => true,
    watchdogClaimExpired: async () => {
      claimCalls += 1
      if (claimCalls === 2) {
        cleanupStarted()
        return [{ callId: callA.callId, operatorUserId: 'owner', sessionId: 'session-a' }]
      }
      return []
    },
    close: async () => {},
  }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  const service = createCoachServer({
    secret: SECRET, db, publisher, deepgramApiKey: 'disabled', jevApiKey: 'disabled', logger,
    sessionFactory: (ws, value, admitted, onEnd) => new CoachSession(ws, value, admitted, {
      db, publisher, deepgramApiKey: 'disabled', jevApiKey: 'disabled', logger,
      bridgeFactory: () => ({ send() { audioFrames += 1 }, close: async () => {} }),
      objectionFactory: () => ({ close() {}, onFinal() {}, onInterim() {} } as unknown as ObjectionPromptCall),
      onEnd,
    }),
    watchdog: {
      secret: SECRET,
      origins: new Set(['http://localhost']),
      onExpired: async () => { await cleanupReleased },
    },
  })
  await service.listen(0, '127.0.0.1')
  const address = service.server.address()
  assert.ok(address && typeof address === 'object')
  const mediaBase = `ws://127.0.0.1:${address.port}/media`
  const presenceBase = `ws://127.0.0.1:${address.port}/presence`
  const mediaA = new WebSocket(`${mediaBase}?token=${encodeURIComponent(createCoachToken(callA, SECRET))}`)
  const mediaB = new WebSocket(`${mediaBase}?token=${encodeURIComponent(createCoachToken(callB, SECRET))}`)
  await Promise.all([waitForWebSocketOpen(mediaA), waitForWebSocketOpen(mediaB)])
  const start = (leg: string) => JSON.stringify({ event: 'start', start: { call_control_id: leg, media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } })
  mediaA.send(start(callA.sellerLegId))
  mediaB.send(start(callB.sellerLegId))
  await waitUntil(() => service.activeCalls.size === 2)
  const presenceA = new WebSocket(presenceBase, { headers: { Origin: 'http://localhost' } })
  await waitForWebSocketOpen(presenceA)
  presenceA.send(createWatchdogToken({ callId: callA.callId, browserLegId: 'browser-a', operatorUserId: 'owner', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAtMs: Date.now() + 100_000 }, SECRET))
  await waitForWebSocketMessage(presenceA)
  await cleanupBegan
  const presenceB = new WebSocket(presenceBase, { headers: { Origin: 'http://localhost' } })
  await waitForWebSocketOpen(presenceB)
  presenceB.send(createWatchdogToken({ callId: callB.callId, browserLegId: 'browser-b', operatorUserId: 'owner', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expiresAtMs: Date.now() + 100_000 }, SECRET))
  await waitForWebSocketMessage(presenceB)
  // Keep the expiry callback blocked for ten seconds. Native pong renewals and
  // the liveness row must continue while cleanup is slow, and a second cleanup
  // claim must not overlap the in-flight callback.
  setTimeout(() => releaseCleanup(), 10_000)
  const pcmu = Buffer.alloc(160, 0x7f).toString('base64')
  for (let chunk = 1; chunk <= 750; chunk += 1) {
    const media = JSON.stringify({ event: 'media', media: { chunk: String(chunk), track: 'inbound', payload: pcmu } })
    mediaA.send(media)
    mediaB.send(media)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (chunk === 400) {
      assert.equal(claimCalls, 2)
      assert.equal(service.activeCalls.size, 2)
    }
  }
  assert.equal(audioFrames >= 1_000, true)
  assert.equal(heartbeats >= 8, true)
  assert.equal(renewals >= 6, true)
  assert.equal(claimCalls >= 2, true)
  assert.equal(service.activeCalls.size, 2)
  await Promise.all([waitForWebSocketTerminal(mediaA), waitForWebSocketTerminal(mediaB), waitForWebSocketTerminal(presenceA), waitForWebSocketTerminal(presenceB), service.close()])
})

test('unauthenticated presence sockets are terminated within the bounded auth-close window', async () => {
  const db: DirectCoachDb = {
    readBinding: async () => null,
    isActive: async () => true,
    watchdogHeartbeat: async () => {},
    watchdogAttach: async () => false,
    watchdogRenew: async () => false,
    watchdogDisconnect: async () => true,
    watchdogClaimExpired: async () => [],
    close: async () => {},
  }
  const publisher: CoachPublisher = { publish: async () => {}, close: async () => {}, closeAll: async () => {} }
  const service = createCoachServer({
    secret: SECRET, db, publisher, deepgramApiKey: 'disabled', jevApiKey: 'disabled', logger,
    watchdog: { secret: SECRET, origins: new Set(['http://localhost']), onExpired: async () => {} },
  })
  await service.listen(0, '127.0.0.1')
  const address = service.server.address()
  assert.ok(address && typeof address === 'object')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/presence`, { headers: { Origin: 'http://localhost' } })
  await waitForWebSocketOpen(ws)
  const terminal = waitForWebSocketTerminal(ws)
  await new Promise((resolve) => setTimeout(resolve, 3_200))
  await terminal
  await service.close()
})

function tick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)) }

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function waitForWebSocketMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (message) => resolve(message.toString()))
    ws.once('error', reject)
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function waitForWebSocketTerminal(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    ws.once('error', finish)
    ws.once('close', finish)
  })
}
