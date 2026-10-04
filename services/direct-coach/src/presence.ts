import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyWatchdogToken, type WatchdogClaims } from './auth.js'
import type { CoachLogger, DirectCoachDb } from './types.js'

const PING_MS = 2_000
const HEARTBEAT_GRACE_MS = 6_000
const AUTH_TIMEOUT_MS = 2_000
const CLOSE_TIMEOUT_MS = 1_000
const MAX_PRESENCE_PAYLOAD = 16_384

export type WatchdogExpiryClaim = { callId: string; operatorUserId: string; sessionId: string }

export class PresenceAdmissionError extends Error {
  constructor(readonly reason: 'origin_not_allowed' | 'draining', readonly status: 403 | 503) {
    super(reason)
  }
}

export interface PresenceManagerOptions {
  readonly db: DirectCoachDb
  readonly secret: string
  readonly origins: ReadonlySet<string>
  readonly logger: CoachLogger
  readonly now?: () => number
  readonly onExpired: (claim: WatchdogExpiryClaim) => Promise<void>
  readonly instanceId?: string
}

export interface PresenceManager {
  readonly wss: WebSocketServer
  admit(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
  start(): Promise<void>
  close(): Promise<void>
}

type SocketState = {
  ws: WebSocket
  claims: WatchdogClaims
  authenticated: boolean
  lastPongAt: number
  authTimer?: ReturnType<typeof setTimeout>
  graceful: boolean
  renewing: boolean
}

export function createPresenceManager(options: PresenceManagerOptions): PresenceManager {
  const now = options.now ?? Date.now
  const sockets = new Map<string, SocketState>()
  const pending = new Set<Promise<void>>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PRESENCE_PAYLOAD, clientTracking: true })
  const instanceId = options.instanceId ?? `watchdog-${randomUUID()}`
  let timer: ReturnType<typeof setInterval> | undefined
  let draining = false
  let cleanupInFlight = false

  function closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.CLOSED) return
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ws.removeListener('close', finish)
    }
    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
      finish()
    }, CLOSE_TIMEOUT_MS)
    ws.once('close', finish)
    try { ws.close(code, reason) } catch { ws.terminate(); finish() }
  }

  async function admit(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !options.origins.has(origin)) throw new PresenceAdmissionError('origin_not_allowed', 403)
    if (draining) throw new PresenceAdmissionError('draining', 503)
    const admission = new Promise<void>((resolve) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const state: SocketState = { ws, claims: undefined as never, authenticated: false, lastPongAt: now(), graceful: false, renewing: false }
        const authTimer = setTimeout(() => { if (!state.authenticated) closeSocket(ws, 4401, 'presence authentication timeout') }, AUTH_TIMEOUT_MS)
        state.authTimer = authTimer
        const finish = () => {
          clearTimeout(authTimer)
          if (state.authenticated && sockets.get(state.claims.callId) === state) {
            sockets.delete(state.claims.callId)
            if (options.db.watchdogDisconnect) {
              void options.db.watchdogDisconnect({ callId: state.claims.callId, operatorUserId: state.claims.operatorUserId, browserLegId: state.claims.browserLegId, sessionId: state.claims.sessionId, abnormal: !state.graceful }).catch((error) => options.logger.warn('watchdog.disconnect_failed', { reason: error instanceof Error ? error.message : 'unknown' }))
            }
          }
        }
        ws.on('pong', () => {
          state.lastPongAt = now()
          if (!state.authenticated || sockets.get(state.claims.callId) !== state || state.renewing || !options.db.watchdogRenew) return
          state.renewing = true
          void options.db.watchdogRenew({ callId: state.claims.callId, operatorUserId: state.claims.operatorUserId, browserLegId: state.claims.browserLegId, sessionId: state.claims.sessionId })
            .then((renewed) => {
              if (!renewed && state.ws.readyState === WebSocket.OPEN) state.ws.close(4403, 'watchdog lease expired')
            })
            .catch((error) => options.logger.warn('watchdog.renew_failed', { reason: error instanceof Error ? error.message : 'unknown' }))
            .finally(() => { state.renewing = false })
        })
        ws.on('error', () => { if (!state.graceful) closeSocket(ws, 4403, 'presence socket error') })
        ws.on('close', () => finish())
        ws.on('message', (message) => {
          void handleMessage(state, message).catch((error) => {
            options.logger.warn('watchdog.message_rejected', { reason: error instanceof Error ? error.message : 'unknown' })
            if (ws.readyState === WebSocket.OPEN) closeSocket(ws, 4403, 'presence rejected')
          })
        })
        resolve()
      })
    })
    pending.add(admission)
    try { await admission } finally { pending.delete(admission) }
  }

  async function handleMessage(state: SocketState, message: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    const text = Buffer.isBuffer(message) ? message.toString('utf8') : Buffer.from(message as never).toString('utf8')
    if (!state.authenticated) {
      const claims = verifyWatchdogToken(parseAuthToken(text), options.secret, now())
      const attached = await options.db.watchdogAttach?.({ callId: claims.callId, operatorUserId: claims.operatorUserId, browserLegId: claims.browserLegId, sessionId: claims.sessionId })
      if (!attached) throw new Error('watchdog call fence rejected')
      if (state.ws.readyState !== WebSocket.OPEN) throw new Error('presence socket closed during admission')
      const previous = sockets.get(claims.callId)
      if (previous && previous !== state) {
        previous.graceful = true
        closeSocket(previous.ws, 4001, 'presence superseded')
      }
      state.claims = claims
      state.authenticated = true
      sockets.set(claims.callId, state)
      clearTimeout(state.authTimer)
      state.authTimer = undefined
      state.ws.send(JSON.stringify({ type: 'presence_ack', callId: claims.callId }))
      return
    }
    if (sockets.get(state.claims.callId) !== state) throw new Error('superseded presence socket')
    const body = parseMessage(text)
    if (body.type !== 'heartbeat') throw new Error('unexpected presence message')
    // Application heartbeat frames are retained as an acknowledgement-only
    // compatibility message. Native pong is the lease authority: it is emitted
    // by ws from the browser protocol and is independent of page timers/workers.
    state.ws.send(JSON.stringify({ type: 'heartbeat_ack' }))
  }

  let tickInFlight = false
  async function runExpirySweep(): Promise<void> {
    if (draining || cleanupInFlight) return
    cleanupInFlight = true
    try {
      const claims = await options.db.watchdogClaimExpired?.(2) ?? []
      await Promise.all(claims.map(async (claim) => {
        try { await options.onExpired(claim) } catch (error) { options.logger.error('watchdog.expiry_cleanup_failed', { callId: claim.callId, reason: error instanceof Error ? error.message : 'unknown' }) }
      }))
    } catch (error) { options.logger.error('watchdog.expiry_claim_failed', { reason: error instanceof Error ? error.message : 'unknown' }) }
    finally { cleanupInFlight = false }
  }

  async function tick(): Promise<void> {
    if (tickInFlight) return
    tickInFlight = true
    try {
      try { await options.db.watchdogHeartbeat?.(instanceId) } catch (error) { options.logger.error('watchdog.heartbeat_failed', { reason: error instanceof Error ? error.message : 'unknown' }) }
      for (const state of sockets.values()) {
        if (state.ws.readyState !== WebSocket.OPEN) continue
        if (now() - state.lastPongAt > HEARTBEAT_GRACE_MS) {
          state.graceful = false
          closeSocket(state.ws, 4002, 'presence heartbeat stale')
        } else state.ws.ping()
      }
    } finally {
      tickInFlight = false
    }
    // Cleanup may involve several bounded provider requests. Keep it single-flight,
    // but never let it delay the DB liveness row or the next ping.
    void runExpirySweep()
  }

  return {
    wss,
    admit,
    start: async () => {
      if (!options.db.watchdogHeartbeat || !options.db.watchdogClaimExpired || !options.db.watchdogAttach || !options.db.watchdogRenew || !options.db.watchdogDisconnect) throw new Error('watchdog database boundary unavailable')
      await tick()
      timer = setInterval(() => { void tick() }, PING_MS)
    },
    close: async () => {
      draining = true
      if (timer) clearInterval(timer)
      for (const state of sockets.values()) { state.graceful = true; closeSocket(state.ws, 1001, 'server shutdown') }
      await Promise.allSettled([...pending])
      await new Promise<void>((resolve) => { try { wss.close(() => resolve()) } catch { resolve() } })
    },
  }
}

function parseAuthToken(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === 'string' && (parsed as { type: string }).type === 'auth' && typeof (parsed as { token?: unknown }).token === 'string') return (parsed as { token: string }).token
  } catch { /* raw token is accepted as the first message for simple clients */ }
  if (!value.trim()) throw new Error('missing watchdog token')
  return value.trim()
}

function parseMessage(value: string): { type: string } {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') throw new Error('invalid presence message')
  return parsed as { type: string }
}
