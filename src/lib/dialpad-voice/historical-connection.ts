import 'server-only';
import { DialpadVoiceError } from './client';

/** Implement reads with service credentials and ALL supplied equality filters.
 * Runtime validation also rejects cross-tenant or substituted rows. */
export interface HistoricalConnectionStore {
  readIntent(orgId: string, intentId: string): Promise<unknown>;
  readConfiguration(orgId: string, intentId: string): Promise<unknown>;
  readRevision(orgId: string, connectionId: string, version: number): Promise<unknown>;
}
export interface HistoricalCredentialAccess {
  resolve(reference: string): Promise<string | undefined>;
  /** Authenticated GET /api/v2/company using exactly this credential. */
  getCompany(apiKey: string): Promise<unknown>;
}
export class HistoricalConnectionError extends Error {
  constructor(readonly code: 'invalid_scope' | 'history_unavailable' | 'credential_unavailable' | 'company_mismatch' | 'history_read_unavailable') {
    super('Historical Dialpad connection unavailable');
  }
}
const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const providerId = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,39}$/.test(v);
/** Historical processing deliberately ignores current membership, grants and
 * enabled flags. It grants no new-call authorization and never substitutes a
 * current connection when frozen history or its credential is unavailable. */
export async function resolveHistoricalDialpadConnection(
  store: HistoricalConnectionStore, credentials: HistoricalCredentialAccess,
  scope: { orgId: string; intentId: string },
) {
  if (!uuid(scope.orgId) || !uuid(scope.intentId)) throw new HistoricalConnectionError('invalid_scope');
  let intent: unknown, config: unknown, revision: unknown;
  try {
    intent = await store.readIntent(scope.orgId, scope.intentId);
    config = await store.readConfiguration(scope.orgId, scope.intentId);
    if (!row(intent) || intent.org_id !== scope.orgId || intent.id !== scope.intentId || !uuid(intent.actor_user_id)
      || !providerId(intent.dialpad_user_id) || !row(config) || config.org_id !== scope.orgId || config.intent_id !== scope.intentId
      || !uuid(config.connection_id) || typeof config.connection_version !== 'number' || !Number.isSafeInteger(config.connection_version) || config.connection_version < 1) throw new HistoricalConnectionError('history_unavailable');
    revision = await store.readRevision(scope.orgId, config.connection_id, config.connection_version);
    if (!row(revision) || revision.org_id !== scope.orgId || revision.connection_id !== config.connection_id
      || revision.config_version !== config.connection_version || !providerId(revision.provider_company_id)
      || typeof revision.credential_reference !== 'string' || !/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(revision.credential_reference)) throw new HistoricalConnectionError('history_unavailable');
  } catch (error) { if (error instanceof HistoricalConnectionError) throw error; throw new HistoricalConnectionError('history_read_unavailable'); }
  let apiKey: string | undefined, company: unknown;
  try {
    apiKey = await credentials.resolve(revision.credential_reference);
    if (!apiKey?.trim()) throw new HistoricalConnectionError('history_unavailable');
    company = await credentials.getCompany(apiKey);
  } catch (error) { if (error instanceof DialpadVoiceError) throw error; throw new HistoricalConnectionError('credential_unavailable'); }
  if (!row(company) || company.id !== revision.provider_company_id) throw new HistoricalConnectionError('company_mismatch');
  return Object.freeze({ orgId: scope.orgId, intentId: scope.intentId, actorUserId: intent.actor_user_id,
    providerUserId: intent.dialpad_user_id, providerCompanyId: revision.provider_company_id,
    connectionId: config.connection_id, connectionVersion: config.connection_version, apiKey });
}
