import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { verifyCoachToken } from './auth.js'
import { CoachSession } from './session.js'
import { createPresenceManager, type WatchdogExpiryClaim, type PresenceManager } from './presence.js'
import type { CoachClaims, CoachLogger, CoachPublisher, DirectCoachBinding, DirectCoachDb } from './types.js'

const MAX_SESSIONS = 2
const MAX_WS_PAYLOAD = 1_048_576
const CLOSE_GRACE_MS = 15_000

export interface CoachServerOptions {
  readonly secret: string
  readonly db: DirectCoachDb
  readonly publisher: CoachPublisher
  readonly deepgramApiKey: string
  readonly jevApiKey: string
  readonly logger: CoachLogger
  readonly now?: () => number
  readonly sessionFactory?: (ws: WebSocket, claims: CoachClaims, binding: DirectCoachBinding, onEnd: () => void) => CoachSession
  readonly watchdog?: {
    readonly secret: string
    readonly origins: ReadonlySet<string>
    readonly onExpired: (claim: WatchdogExpiryClaim) => Promise<void>
    readonly instanceId?: string
  }
}

export interface CoachServer {
  readonly server: Server
  readonly wss: WebSocketServer
  readonly activeCalls: Readonly<{ readonly size: number; has(callId: string): boolean }>
  listen(port: number, host?: string): Promise<void>
  close(): Promise<void>
}

export function createCoachServer(options: CoachServerOptions): CoachServer {
  const sessions = new Map<string, CoachSession>()
  const admitting = new Set<string>()
  const pendingAdmissions = new Set<Promise<void>>()
  const pendingSockets = new Set<Duplex>()
  let draining = false
  let closePromise: Promise<void> | undefined
  let watchdog: PresenceManager | undefined
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, clientTracking: true })
  if (options.watchdog) watchdog = createPresenceManager({ db: options.db, secret: options.watchdog.secret, origins: options.watchdog.origins, logger: options.logger, now: options.now, onExpired: options.watchdog.onExpired, instanceId: options.watchdog.instanceId })
  const server = createServer((request, response) => handleHealth(request, response, sessions.size + (watchdog?.wss.clients.size ?? 0)))
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/presence' && watchdog) {
      void watchdog.admit(request, socket, head).catch(() => { if (!socket.destroyed) socket.destroy() })
      return
    }
    let disconnected = false
    socket.on('error', () => { disconnected = true; socket.destroy() })
    socket.on('close', () => { disconnected = true; pendingSockets.delete(socket) })
    if (draining) { socket.destroy(); return }
    pendingSockets.add(socket)
    const admission = admit(request)
      .catch(() => { if (!socket.destroyed) socket.destroy() })
      .finally(() => { pendingAdmissions.delete(admission); pendingSockets.delete(socket) })
    pendingAdmissions.add(admission)
    void admission
    async function admit(req: IncomingMessage): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/media') throw new Error('unknown websocket path')
      const rawToken = url.searchParams.get('token')
      if (!rawToken) throw new Error('missing token')
      const claims = verifyCoachToken(rawToken, options.secret, options.now?.() ?? Date.now())
      if (draining) throw new Error('server is draining')
      if (sessions.has(claims.callId) || admitting.has(claims.callId)) throw new Error('duplicate call session')
      if (sessions.size + admitting.size >= MAX_SESSIONS) throw new Error('session capacity reached')
      admitting.add(claims.callId)
      try {
        // This is the admission fence. No paid ASR bridge is constructed before this exact
        // call/leg/owner/script/membership binding is freshly read from the database.
        const binding = await options.db.readBinding(claims)
        if (!binding) throw new Error('call binding unavailable')
        if (draining || disconnected || socket.destroyed) throw new Error('upgrade socket closed')
        wss.handleUpgrade(req, socket, head, (ws) => {
          pendingSockets.delete(socket)
          const remove = () => { sessions.delete(claims.callId) }
          const session = options.sessionFactory
            ? options.sessionFactory(ws, claims, binding, remove)
            : new CoachSession(ws, claims, binding, { db: options.db, publisher: options.publisher, deepgramApiKey: options.deepgramApiKey, jevApiKey: options.jevApiKey, logger: options.logger, now: options.now, onEnd: remove })
          sessions.set(claims.callId, session)
          ws.on('message', (message) => session.handle(message))
          ws.on('close', () => { session.disconnected() })
          ws.on('error', () => { session.disconnected() })
        })
      } finally { admitting.delete(claims.callId) }
    }
  })

  return {
    server,
    wss,
    activeCalls: { get size() { return sessions.size }, has: (callId: string) => sessions.has(callId) },
    listen: async (port, host = '0.0.0.0') => {
      if (watchdog) await watchdog.start()
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve() }) })
    },
    close: async () => {
      if (closePromise) return closePromise
      closePromise = closeInternal()
      return closePromise
    },
  }

  async function closeInternal(): Promise<void> {
    draining = true
    const deadline = Date.now() + CLOSE_GRACE_MS
    for (const socket of pendingSockets) socket.destroy()
    const admissions = [...pendingAdmissions]
    const acceptedSessions = [...sessions.values()]
    const sessionDrains = acceptedSessions.map((session) => session.finish('server_shutdown'))
    const pendingDrains = admissions.map((admission) => admission.catch(() => undefined))
    await bounded(Promise.allSettled([...sessionDrains, ...pendingDrains]).then(() => undefined), remaining(deadline))
    await bounded(options.publisher.closeAll().catch(() => undefined), remaining(deadline))
    await bounded(watchdog?.close().catch(() => undefined) ?? Promise.resolve(), remaining(deadline))
    const closeServer = new Promise<void>((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
    })
    await bounded(closeServer, remaining(deadline))
    const closeWebSockets = new Promise<void>((resolve) => {
      try { wss.close(() => resolve()) } catch { resolve() }
    })
    await bounded(closeWebSockets, remaining(deadline))
  }
}

function handleHealth(_request: IncomingMessage, response: ServerResponse, active: number): void {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ ok: true, activeSessions: active }))
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()) }
