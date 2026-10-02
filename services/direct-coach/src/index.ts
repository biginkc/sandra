import { assertSecret } from './auth.js'
import { createHmac } from 'node:crypto'
import { SupabaseDirectCoachDb } from './db.js'
import { createSupabaseCoachClient, SupabaseCoachPublisher } from './publisher.js'
import { createCoachServer } from './server.js'
import type { CoachLogger } from './types.js'

const logger: CoachLogger = {
  info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const coachEnabled = process.env.DIRECT_COACH_ENABLED !== 'false'
  const watchdogSecret = (process.env.DIRECT_WATCHDOG_TOKEN_SECRET ?? process.env.DIRECT_WATCHDOG_SECRET)?.trim() || required('DIRECT_WATCHDOG_TOKEN_SECRET')
  assertSecret(watchdogSecret)
  const secret = coachEnabled ? required('DIRECT_COACH_STREAM_SECRET') : watchdogSecret
  assertSecret(secret)
  const deepgramApiKey = coachEnabled ? required('DEEPGRAM_API_KEY') : 'disabled'
  const jevApiKey = coachEnabled ? required('COACH_JEV_API_KEY') : 'disabled'
  const cleanupUrl = required('DIRECT_WATCHDOG_CLEANUP_URL')
  const cleanupSecret = (process.env.DIRECT_WATCHDOG_CLEANUP_SECRET ?? process.env.DIRECT_WATCHDOG_SECRET)?.trim() || required('DIRECT_WATCHDOG_CLEANUP_SECRET')
  assertSecret(cleanupSecret)
  const origins = new Set((process.env.DIRECT_WATCHDOG_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  if (origins.size === 0) throw new Error('DIRECT_WATCHDOG_ALLOWED_ORIGINS is required')
  const client = createSupabaseCoachClient(process.env)
  const db = new SupabaseDirectCoachDb(client)
  const publisher = new SupabaseCoachPublisher(client)
  const service = createCoachServer({
    secret, db, publisher, deepgramApiKey, jevApiKey, logger,
    watchdog: {
      secret: watchdogSecret,
      origins,
      instanceId: process.env.DIRECT_WATCHDOG_INSTANCE_ID,
      onExpired: (claim) => cleanupExpiredCall(cleanupUrl, cleanupSecret, claim),
    },
  })
  const port = Number(process.env.PORT ?? 9085)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
  await service.listen(port)
  const shutdown = async () => { await service.close(); await db.close() }
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)) })
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)) })
}

async function cleanupExpiredCall(url: string, secret: string, claim: { callId: string; sessionId: string }): Promise<void> {
  const body = JSON.stringify({ callId: claim.callId, sessionId: claim.sessionId })
  const timestamp = String(Date.now())
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('base64url')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sandra-watchdog-timestamp': timestamp, 'x-sandra-watchdog-signature': signature }, body, signal: controller.signal })
    if (!response.ok) throw new Error(`watchdog cleanup returned ${response.status}`)
  } finally { clearTimeout(timer) }
}

void main().catch((error: unknown) => { logger.error('direct_coach.start_failed', { reason: error instanceof Error ? error.message : 'unknown' }); process.exitCode = 1 })
