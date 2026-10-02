import type { SupabaseClient } from '@supabase/supabase-js'
import { assertValidScriptBundle, computeScriptDigest, type ScriptBundle } from './script-bundle.js'
import type { CoachClaims, DirectCoachBinding, DirectCoachDb } from './types.js'

const ACTIVE_STATUSES = ['connected', 'seller_dialing'] as const
const DEFAULT_QUERY_TIMEOUT_MS = 2_000

interface QueryResult<T> { readonly data: T | null; readonly error: { readonly message: string } | null }
interface QueryBuilder<T> {
  select(columns: string): QueryBuilder<T>
  eq(column: string, value: string | number): QueryBuilder<T>
  in(column: string, values: ReadonlyArray<string>): QueryBuilder<T>
  abortSignal(signal: AbortSignal): QueryBuilder<T>
  maybeSingle(): PromiseLike<QueryResult<T>>
}
interface CoachDbClient {
  from<T = unknown>(table: string): QueryBuilder<T>
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<QueryResult<T>>
}
interface DirectCallRow { id: string; seller_leg_id: string | null; operator_user_id: string; org_id: string; status: string }
interface MembershipRow { user_id: string; org_id: string; acquisitions_enabled: boolean; access_status: string; access_expires_at: string | null; deletion_prepared_at: string | null }
interface IndexRow { client_call_id?: string; operator_user_id?: string; script_slug: string | null; script_revision: number | null; script_digest: string | null }
interface RevisionRow { slug: string; revision: number; digest: string; bundle: unknown; import_status: string }

export class SupabaseDirectCoachDb implements DirectCoachDb {
  private readonly client: CoachDbClient
  constructor(client: SupabaseClient, private readonly queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS) {
    this.client = client as unknown as CoachDbClient
  }

  async readBinding(claims: CoachClaims): Promise<DirectCoachBinding | null> {
    try { return await this.readBindingStrict(claims) } catch { return null }
  }

  private async readBindingStrict(claims: CoachClaims): Promise<DirectCoachBinding | null> {
    const call = await this.one<DirectCallRow>((signal) => this.client.from<DirectCallRow>('direct_calls').select('id,seller_leg_id,operator_user_id,org_id,status').eq('id', claims.callId).eq('seller_leg_id', claims.sellerLegId).in('status', ACTIVE_STATUSES).abortSignal(signal).maybeSingle())
    if (!call || call.id !== claims.callId || call.seller_leg_id !== claims.sellerLegId || !ACTIVE_STATUSES.includes(call.status as typeof ACTIVE_STATUSES[number])) return null
    const membership = await this.one<MembershipRow>((signal) => this.client.from<MembershipRow>('memberships').select('user_id,org_id,acquisitions_enabled,access_status,access_expires_at,deletion_prepared_at').eq('user_id', call.operator_user_id).eq('org_id', call.org_id).abortSignal(signal).maybeSingle())
    if (!membership || !eligibleMembership(membership, call)) return null
    const index = await this.one<IndexRow>((signal) => this.client.from<IndexRow>('coach_call_index').select('client_call_id,operator_user_id,script_slug,script_revision,script_digest').eq('client_call_id', call.id).eq('operator_user_id', call.operator_user_id).abortSignal(signal).maybeSingle())
    if (!index || (index.client_call_id !== undefined && index.client_call_id !== call.id) || (index.operator_user_id !== undefined && index.operator_user_id !== call.operator_user_id)) return null
    const scriptSlug = index.script_slug
    const scriptRevision = index.script_revision
    const scriptDigest = index.script_digest
    if (!scriptSlug || typeof scriptRevision !== 'number' || !Number.isSafeInteger(scriptRevision) || typeof scriptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(scriptDigest)) return null
    const revision = await this.one<RevisionRow>((signal) => this.client.from<RevisionRow>('coach_script_revisions').select('slug,revision,digest,bundle,import_status').eq('slug', scriptSlug).eq('revision', scriptRevision).eq('digest', scriptDigest).abortSignal(signal).maybeSingle())
    if (!revision || revision.slug !== scriptSlug || revision.revision !== scriptRevision || revision.digest !== scriptDigest || revision.import_status !== 'reviewed' || !revision.bundle || typeof revision.bundle !== 'object') return null
    try {
      assertValidScriptBundle(revision.bundle)
      if (computeScriptDigest(revision.bundle as ScriptBundle) !== scriptDigest) return null
    } catch { return null }
    return { callId: call.id, sellerLegId: call.seller_leg_id, ownerUserId: call.operator_user_id, orgId: call.org_id, scriptSlug, scriptRevision, scriptDigest, bundle: revision.bundle as ScriptBundle }
  }

  async isActive(binding: Pick<DirectCoachBinding, 'callId' | 'sellerLegId'>): Promise<boolean> {
    const call = await this.one<DirectCallRow>((signal) => this.client.from<DirectCallRow>('direct_calls').select('id,seller_leg_id,operator_user_id,org_id,status').eq('id', binding.callId).eq('seller_leg_id', binding.sellerLegId).in('status', ACTIVE_STATUSES).abortSignal(signal).maybeSingle())
    if (!call || call.seller_leg_id !== binding.sellerLegId || !ACTIVE_STATUSES.includes(call.status as typeof ACTIVE_STATUSES[number])) return false
    const membership = await this.one<MembershipRow>((signal) => this.client.from<MembershipRow>('memberships').select('user_id,org_id,acquisitions_enabled,access_status,access_expires_at,deletion_prepared_at').eq('user_id', call.operator_user_id).eq('org_id', call.org_id).abortSignal(signal).maybeSingle())
    return Boolean(membership && eligibleMembership(membership, call))
  }

  async watchdogHeartbeat(instanceId: string): Promise<void> {
    await this.rpc('direct_watchdog_heartbeat', { p_instance: instanceId })
  }

  async watchdogAttach(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string }): Promise<boolean> {
    return this.rpc<boolean>('direct_call_watchdog_attach', { p_id: args.callId, p_operator: args.operatorUserId, p_browser_leg: args.browserLegId, p_session: args.sessionId })
  }

  async watchdogRenew(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string }): Promise<boolean> {
    return this.rpc<boolean>('direct_call_watchdog_renew', { p_id: args.callId, p_operator: args.operatorUserId, p_browser_leg: args.browserLegId, p_session: args.sessionId })
  }

  async watchdogDisconnect(args: { callId: string; operatorUserId: string; browserLegId: string; sessionId: string; abnormal: boolean }): Promise<boolean> {
    return this.rpc<boolean>('direct_call_watchdog_disconnect', { p_id: args.callId, p_operator: args.operatorUserId, p_browser_leg: args.browserLegId, p_session: args.sessionId, p_abnormal: args.abnormal })
  }

  async watchdogClaimExpired(limit: number): Promise<Array<{ callId: string; operatorUserId: string; sessionId: string }>> {
    const rows = await this.rpc<Array<{ call_id: string; operator_user_id: string; browser_watchdog_session_id: string }>>('direct_call_watchdog_claim_expired', { p_limit: limit })
    return (rows ?? []).map((row) => ({ callId: row.call_id, operatorUserId: row.operator_user_id, sessionId: row.browser_watchdog_session_id }))
  }

  async close(): Promise<void> {}

  private async one<T>(build: (signal: AbortSignal) => PromiseLike<QueryResult<T>>): Promise<T | null> {
    const controller = new AbortController()
    const result = await withTimeout(Promise.resolve().then(() => build(controller.signal)), this.queryTimeoutMs, controller)
    if (result.error) throw new Error('bounded Supabase query failed')
    return result.data
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const result = await withTimeout(Promise.resolve(this.client.rpc<T>(fn, args)), this.queryTimeoutMs)
    if (result.error) throw new Error('bounded watchdog RPC failed')
    return result.data as T
  }
}

function eligibleMembership(membership: MembershipRow, call: DirectCallRow): boolean {
  const expiry = membership.access_expires_at ? Date.parse(membership.access_expires_at) : Number.POSITIVE_INFINITY
  return membership.user_id === call.operator_user_id && membership.org_id === call.org_id && membership.acquisitions_enabled === true && membership.access_status === 'active' && membership.deletion_prepared_at === null && (expiry === Number.POSITIVE_INFINITY || Number.isFinite(expiry) && expiry > Date.now())
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('bounded database timeout')) }, timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}
