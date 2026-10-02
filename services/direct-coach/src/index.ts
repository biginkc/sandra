import { assertSecret } from './auth.js'
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
  const secret = required('DIRECT_COACH_STREAM_SECRET')
  assertSecret(secret)
  const deepgramApiKey = required('DEEPGRAM_API_KEY')
  const jevApiKey = required('COACH_JEV_API_KEY')
  const client = createSupabaseCoachClient(process.env)
  const db = new SupabaseDirectCoachDb(client)
  const publisher = new SupabaseCoachPublisher(client)
  const service = createCoachServer({ secret, db, publisher, deepgramApiKey, jevApiKey, logger })
  const port = Number(process.env.PORT ?? 9085)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
  await service.listen(port)
  const shutdown = async () => { await service.close(); await db.close() }
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)) })
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)) })
}

void main().catch((error: unknown) => { logger.error('direct_coach.start_failed', { reason: error instanceof Error ? error.message : 'unknown' }); process.exitCode = 1 })
