import type { ScriptBundle } from './script-bundle.js'
import type { CoachWireMessage } from './approved/wire-contract.js'

export interface CoachClaims {
  readonly callId: string
  readonly sellerLegId: string
  readonly expiresAtMs: number
}

export interface DirectCoachBinding {
  readonly callId: string
  readonly sellerLegId: string
  readonly ownerUserId: string
  readonly orgId: string
  readonly scriptSlug: string
  readonly scriptRevision: number
  readonly scriptDigest: string
  readonly bundle: ScriptBundle
}

export interface DirectCoachDb {
  readBinding(claims: CoachClaims): Promise<DirectCoachBinding | null>
  isActive(binding: Pick<DirectCoachBinding, 'callId' | 'sellerLegId'>): Promise<boolean>
  /** Watchdog RPCs use DB time and exact call/leg/session fences. They are optional for media-only unit fakes. */
  watchdogHeartbeat?(instanceId: string): Promise<void>
  watchdogAttach?(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string }): Promise<boolean>
  watchdogRenew?(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string }): Promise<boolean>
  watchdogDisconnect?(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string; abnormal: boolean }): Promise<boolean>
  watchdogClaimExpired?(limit: number): Promise<Array<{ callId: string; operatorUserId: string; sessionId: string }>>
  close(): Promise<void>
}

export interface CoachPublisher {
  publish(callId: string, message: CoachWireMessage): Promise<void>
  close(callId: string): Promise<void>
  closeAll(): Promise<void>
}

export interface CoachLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export const silentLogger: CoachLogger = {
  info() {}, warn() {}, error() {},
}
