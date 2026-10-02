import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CoachClaims } from './types.js'

export const MAX_TOKEN_FUTURE_MS = 210_000

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function parseBase64Json(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('malformed token')
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
}

export function createCoachToken(claims: CoachClaims, secret: string): string {
  assertSecret(secret)
  const body = b64url(JSON.stringify(claims))
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

export function verifyCoachToken(token: string, secret: string, nowMs = Date.now()): CoachClaims {
  assertSecret(secret)
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid token')
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  const provided = Buffer.from(parts[1], 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('invalid token')
  const value = parseBase64Json(parts[0])
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid claims')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'callId,expiresAtMs,sellerLegId' || typeof record.callId !== 'string' || !record.callId || typeof record.sellerLegId !== 'string' || !record.sellerLegId || typeof record.expiresAtMs !== 'number' || !Number.isSafeInteger(record.expiresAtMs)) throw new Error('invalid claims')
  if (record.expiresAtMs <= nowMs || record.expiresAtMs > nowMs + MAX_TOKEN_FUTURE_MS) throw new Error('invalid expiry')
  return { callId: record.callId, sellerLegId: record.sellerLegId, expiresAtMs: record.expiresAtMs }
}

export function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('DIRECT_COACH_STREAM_SECRET must be at least 32 bytes')
}
