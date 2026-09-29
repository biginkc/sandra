/**
 * Repeatable, dry-run-default provisioning of the Dialpad CTI production
 * configuration (blockers B1 to B3 of the CTI preflight):
 *
 *   B1  a DISABLED dialpad_org_connections row for the typed org
 *   B2  a separately stored webhook secret (1Password) and two dedicated Vercel
 *       production sensitive env names that resolve it and the directory key
 *   B3  one owned signed Dialpad webhook and one owned per-user call-event
 *       subscription per typed canary user, created DISABLED
 *
 * Everything here is port based so the whole flow is testable without a
 * network. The plan is computed from observed state, contains no secret and
 * is digested; execute must present the digest of the plan the operator
 * previewed. Objects are only ever created, never rotated, updated (except the
 * restricted `activate` mode) or deleted. A conflicting object stops the run.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { parseDialpadDirectoryUser } from './directory';

export const DEFAULT_PUBLIC_ORIGIN = 'https://sandra.bmhgroupkc.com';
export const DEFAULT_SUFFIX = 'BMH';
export const DEFAULT_SUPABASE_PROJECT_REF = 'copflsklaefwzipsrjqz';
export const DEFAULT_VERCEL_PROJECT = 'sandra';
export const DEFAULT_VERCEL_SCOPE = 'jarrad-5416s-projects';
export const DEFAULT_API_KEY_ITEM = 'Dialpad - API';
export const DEFAULT_CLIENT_ID_ITEM = 'Dialpad - CTI Client ID';
export const CREDENTIAL_FIELD = 'credential';
export const CALL_STATES = ['calling', 'ringing', 'connected', 'hangup', 'voicemail', 'missed'] as const;
export const DIALPAD_ALLOWED_ORIGIN = 'https://dialpad.com';
export const MAX_CANARY_USERS = 2;
export const MIN_SECRET_LENGTH = 16;
const WEBHOOK_PATH = '/api/webhooks/dialpad/voice/';
const MAX_PAGES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIALPAD_ID = /^[1-9][0-9]{0,19}$/;
const SUFFIX = /^[A-Z0-9_]{1,40}$/;
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,120}[a-z0-9])?(:[0-9]{1,5})?$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;

export type ProvisioningMode = 'prepare' | 'activate';

export class ProvisioningError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

/* ------------------------------------------------------------------------ */
/* Typed inputs                                                             */
/* ------------------------------------------------------------------------ */

export interface RawInputs {
  mode?: string;
  orgId?: string;
  companyId?: string;
  canaryUserIds?: readonly string[];
  publicOrigin?: string;
  suffix?: string;
  projectRef?: string;
  vercelProject?: string;
  vercelScope?: string;
  apiKeyItem?: string;
  clientIdItem?: string;
}

export interface ProvisioningInputs {
  mode: ProvisioningMode;
  orgId: string;
  companyId: string;
  canaryUserIds: readonly string[];
  publicOrigin: string;
  suffix: string;
  supabaseProjectRef: string;
  vercelProject: string;
  vercelScope: string;
  apiKeyItem: string;
  clientIdItem: string;
  webhookSecretItem: string;
  webhookSecretEnv: string;
  directoryKeyEnv: string;
  webhookSecretRef: string;
  directoryKeyRef: string;
}

const ITEM_TITLE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}$/;

export function parseInputs(raw: RawInputs): ProvisioningInputs {
  const mode = raw.mode ?? 'prepare';
  if (mode !== 'prepare' && mode !== 'activate') throw new ProvisioningError('invalid_input', 'mode must be prepare or activate');
  const orgId = raw.orgId?.trim().toLowerCase() ?? '';
  if (!UUID.test(orgId)) throw new ProvisioningError('invalid_input', 'a typed --org-id (uuid) is required');
  const companyId = raw.companyId?.trim() ?? '';
  if (!DIALPAD_ID.test(companyId)) throw new ProvisioningError('invalid_input', 'a typed --company-id (Dialpad company id) is required');
  const canary = (raw.canaryUserIds ?? []).map((id) => id.trim());
  if (canary.length === 0 || canary.length > MAX_CANARY_USERS) {
    throw new ProvisioningError('invalid_input', `one to ${MAX_CANARY_USERS} typed --canary-user-id values are required`);
  }
  if (canary.some((id) => !DIALPAD_ID.test(id)) || new Set(canary).size !== canary.length) {
    throw new ProvisioningError('invalid_input', 'canary user ids must be unique Dialpad user ids');
  }
  const publicOrigin = (raw.publicOrigin ?? DEFAULT_PUBLIC_ORIGIN).trim();
  if (!ORIGIN.test(publicOrigin)) throw new ProvisioningError('invalid_input', 'public origin must be a bare https origin');
  const suffix = raw.suffix ?? DEFAULT_SUFFIX;
  if (!SUFFIX.test(suffix)) throw new ProvisioningError('invalid_input', 'suffix must match [A-Z0-9_]{1,40}');
  const supabaseProjectRef = (raw.projectRef ?? DEFAULT_SUPABASE_PROJECT_REF).trim().toLowerCase();
  if (!PROJECT_REF.test(supabaseProjectRef)) throw new ProvisioningError('invalid_input', 'project ref must be a 20-character lowercase Supabase ref');
  const vercelProject = (raw.vercelProject ?? DEFAULT_VERCEL_PROJECT).trim();
  const vercelScope = (raw.vercelScope ?? DEFAULT_VERCEL_SCOPE).trim();
  if (!TARGET_NAME.test(vercelProject) || !TARGET_NAME.test(vercelScope)) throw new ProvisioningError('invalid_input', 'Vercel project and scope must be safe target names');
  const apiKeyItem = raw.apiKeyItem ?? DEFAULT_API_KEY_ITEM;
  const clientIdItem = raw.clientIdItem ?? DEFAULT_CLIENT_ID_ITEM;
  if (!ITEM_TITLE.test(apiKeyItem) || !ITEM_TITLE.test(clientIdItem)) throw new ProvisioningError('invalid_input', 'invalid 1Password item title');
  const webhookSecretEnv = `DIALPAD_CTI_WEBHOOK_SECRET_${suffix}`;
  const directoryKeyEnv = `DIALPAD_CTI_DIRECTORY_KEY_${suffix}`;
  return {
    mode,
    orgId,
    companyId,
    canaryUserIds: canary,
    publicOrigin,
    suffix,
    supabaseProjectRef,
    vercelProject,
    vercelScope,
    apiKeyItem,
    clientIdItem,
    webhookSecretItem: `Dialpad - CTI Webhook Secret - ${suffix}`,
    webhookSecretEnv,
    directoryKeyEnv,
    webhookSecretRef: `env:${webhookSecretEnv}`,
    directoryKeyRef: `env:${directoryKeyEnv}`,
  };
}

export function webhookUrlFor(inputs: Pick<ProvisioningInputs, 'publicOrigin'>, connectionId: string): string {
  return `${inputs.publicOrigin}${WEBHOOK_PATH}${connectionId}`;
}

/* ------------------------------------------------------------------------ */
/* Ports                                                                    */
/* ------------------------------------------------------------------------ */

export type SecretRead = { state: 'missing' } | { state: 'duplicate' } | { state: 'no_field' } | { state: 'found'; value: string };

export interface SecretStorePort {
  read(itemTitle: string, fieldTitle: string): Promise<SecretRead>;
  /** Creates a new concealed API credential item; must never overwrite an existing one. */
  create(itemTitle: string, fieldTitle: string, value: string, note: string): Promise<void>;
}

export interface SchemaState {
  a2Columns: boolean;
  customDataFunction: boolean;
}

export interface ConnectionObservation {
  id: string;
  status: string;
  webhookSecretRef: string;
  webhookSecretVersion: number;
  allowedOrigins: readonly string[];
  companyId: string | null;
  directoryKeyRef: string | null;
  ctiClientIdMatches: boolean;
}

export interface ConnectionInsert {
  orgId: string;
  ctiClientId: string;
  webhookSecretRef: string;
  companyId: string;
  directoryKeyRef: string;
}

export interface ConnectionDbPort {
  inspectSchema(): Promise<SchemaState>;
  organizationExists(orgId: string): Promise<boolean>;
  findConnection(orgId: string, ctiClientId: string | null): Promise<ConnectionObservation | null>;
  /** Insert status=disabled with the default origin, or do nothing on an existing org row. Returns the new id, or null when a row already existed. */
  insertDisabledConnection(row: ConnectionInsert): Promise<string | null>;
  /** Flip disabled to active only if every expected field still matches. Returns rows changed. */
  activateConnection(id: string, expected: ConnectionInsert): Promise<number>;
}

export interface VercelPort {
  listProductionEnvNames(): Promise<readonly string[]>;
  /** Value goes to the CLI on stdin only. */
  addSensitiveProductionEnv(name: string, value: string): Promise<void>;
}

export interface DialpadHttpResponse {
  status: number;
  text: string;
}

export interface DialpadPort {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, bodyText?: string): Promise<DialpadHttpResponse>;
}

export interface ProvisioningPorts {
  secrets: SecretStorePort;
  db: ConnectionDbPort;
  vercel: VercelPort;
  dialpad: DialpadPort;
  /** Injectable for tests; defaults to 32 random bytes as hex. */
  generateSecret?: () => string;
}

/* ------------------------------------------------------------------------ */
/* Secret guard                                                             */
/* ------------------------------------------------------------------------ */

export class SecretGuard {
  private readonly values = new Set<string>();

  add(value: string | null | undefined): void {
    if (value && value.length >= 8) this.values.add(value);
  }

  scrub(text: string): string {
    let out = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) out = out.split(value).join('[redacted]');
    return out;
  }

  describeError(error: unknown): string {
    if (error instanceof ProvisioningError) return this.scrub(`${error.code}: ${error.message}`);
    return this.scrub(`unexpected_error (${error instanceof Error ? error.name : 'non-error'})`);
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------------ */
/* Provider response parsing                                                */
/* ------------------------------------------------------------------------ */

const INT64 = /"(id|target_id|endpoint_id|company_id|office_id)"(\s*:\s*)(-?\d{1,20})(?=\s*[,}\]])/g;

function parseProviderJson(text: string): unknown {
  if (text.length === 0 || text.length > 4_000_000) return null;
  try {
    return JSON.parse(text.replace(INT64, '"$1"$2"$3"'));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && DIALPAD_ID.test(value) ? value : null;
}

export interface WebhookRecord {
  id: string;
  hookUrl: string;
  secret: string | null;
  algo: string | null;
}

export interface SubscriptionRecord {
  id: string;
  enabled: boolean | null;
  callStates: readonly string[];
  targetType: string | null;
  targetId: string | null;
  webhookId: string | null;
}

export function parseWebhook(value: unknown): WebhookRecord | null {
  const item = record(value);
  if (!item) return null;
  const id = idOrNull(item.id);
  if (!id || typeof item.hook_url !== 'string') return null;
  const signature = record(item.signature);
  return {
    id,
    hookUrl: item.hook_url,
    secret: typeof signature?.secret === 'string' ? signature.secret : null,
    algo: typeof signature?.algo === 'string' ? signature.algo : null,
  };
}

export function parseSubscription(value: unknown): SubscriptionRecord | null {
  const item = record(value);
  if (!item) return null;
  const id = idOrNull(item.id);
  if (!id) return null;
  const webhook = record(item.webhook);
  return {
    id,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
    callStates: Array.isArray(item.call_states) ? item.call_states.filter((s): s is string => typeof s === 'string') : [],
    targetType: typeof item.target_type === 'string' ? item.target_type : null,
    targetId: idOrNull(item.target_id),
    webhookId: idOrNull(webhook?.id) ?? idOrNull(item.endpoint_id),
  };
}

async function listAll<T>(dialpad: DialpadPort, basePath: string, parseItem: (value: unknown) => T | null): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const path: string = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath;
    const response = await dialpad.request('GET', path);
    if (response.status !== 200) throw new ProvisioningError('dialpad_list_failed', `${basePath} returned HTTP ${response.status}`);
    const body = record(parseProviderJson(response.text));
    if (!body || !Array.isArray(body.items)) throw new ProvisioningError('dialpad_list_failed', `${basePath} returned an unreadable page`);
    for (const raw of body.items) {
      const parsed = parseItem(raw);
      if (parsed) out.push(parsed);
    }
    cursor = typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null;
    if (!cursor) return out;
  }
  throw new ProvisioningError('dialpad_list_failed', `${basePath} exceeded ${MAX_PAGES} pages`);
}

/* ------------------------------------------------------------------------ */
/* Observation                                                              */
/* ------------------------------------------------------------------------ */

type Slot = { kind: 'ok'; value: string } | { kind: 'missing' | 'duplicate' | 'invalid' };

export interface CanaryObservation {
  userId: string;
  directory: 'verified' | 'not_found' | 'rejected' | 'unavailable' | 'invalid_response' | 'inactive' | 'company_mismatch' | 'unchecked';
  subscription: { kind: 'none' } | { kind: 'owned'; record: SubscriptionRecord } | { kind: 'duplicate' } | { kind: 'wrong_states' };
}

export interface Observed {
  schema: SchemaState;
  orgExists: boolean;
  apiKey: Slot['kind'];
  clientId: Slot['kind'];
  directoryKey: Slot['kind'];
  webhookSecret: Slot['kind'];
  connection: ConnectionObservation | null;
  vercelNames: readonly string[];
  webhook: { kind: 'none' } | { kind: 'owned'; record: WebhookRecord } | { kind: 'duplicate' } | { kind: 'secret_mismatch' } | { kind: 'no_stored_secret' } | { kind: 'wrong_algo' };
  canaries: readonly CanaryObservation[];
  strayOwnedSubscriptions: number;
}

interface Secrets {
  apiKey: string | null;
  clientId: string | null;
  directoryKey: string | null;
  webhookSecret: string | null;
}

async function readSlot(store: SecretStorePort, title: string, valid: (value: string) => boolean): Promise<Slot> {
  const read = await store.read(title, CREDENTIAL_FIELD);
  if (read.state === 'found') return valid(read.value) ? { kind: 'ok', value: read.value } : { kind: 'invalid' };
  if (read.state === 'duplicate') return { kind: 'duplicate' };
  if (read.state === 'no_field') return { kind: 'invalid' };
  return { kind: 'missing' };
}

const validSecret = (value: string): boolean => value.length >= MIN_SECRET_LENGTH && !/\s/.test(value);
const validClientId = (value: string): boolean => CLIENT_ID.test(value);

function sameStates(states: readonly string[]): boolean {
  return states.length === CALL_STATES.length && CALL_STATES.every((state) => states.includes(state));
}

export async function observe(
  ports: ProvisioningPorts,
  inputs: ProvisioningInputs,
  guard: SecretGuard,
): Promise<{ observed: Observed; secrets: Secrets }> {
  const apiKey = await readSlot(ports.secrets, inputs.apiKeyItem, validSecret);
  const clientId = await readSlot(ports.secrets, inputs.clientIdItem, validClientId);
  const webhookSecret = await readSlot(ports.secrets, inputs.webhookSecretItem, validSecret);
  const secrets: Secrets = {
    apiKey: apiKey.kind === 'ok' ? apiKey.value : null,
    clientId: clientId.kind === 'ok' ? clientId.value : null,
    directoryKey: apiKey.kind === 'ok' ? apiKey.value : null,
    webhookSecret: webhookSecret.kind === 'ok' ? webhookSecret.value : null,
  };
  for (const value of Object.values(secrets)) guard.add(value);

  const schema = await ports.db.inspectSchema();
  const orgExists = await ports.db.organizationExists(inputs.orgId);
  const connection = schema.a2Columns && orgExists ? await ports.db.findConnection(inputs.orgId, secrets.clientId) : null;
  const vercelNames = await ports.vercel.listProductionEnvNames();

  const canaries: CanaryObservation[] = [];
  for (const userId of inputs.canaryUserIds) {
    canaries.push({ userId, directory: secrets.apiKey ? await verifyDirectory(ports.dialpad, userId, inputs.companyId) : 'unchecked', subscription: { kind: 'none' } });
  }

  let webhook: Observed['webhook'] = { kind: 'none' };
  let strayOwnedSubscriptions = 0;
  if (connection && secrets.apiKey) {
    const url = webhookUrlFor(inputs, connection.id);
    const matches = (await listAll(ports.dialpad, '/api/v2/webhooks', parseWebhook)).filter((hook) => hook.hookUrl === url);
    if (matches.length > 1) webhook = { kind: 'duplicate' };
    else if (matches.length === 1) {
      const hook = matches[0]!;
      guard.add(hook.secret);
      if (!secrets.webhookSecret) webhook = { kind: 'no_stored_secret' };
      else if (hook.algo !== null && hook.algo !== 'HS256') webhook = { kind: 'wrong_algo' };
      else if (hook.secret === null || !sameSecret(hook.secret, secrets.webhookSecret)) webhook = { kind: 'secret_mismatch' };
      else webhook = { kind: 'owned', record: hook };
    }
    if (webhook.kind === 'owned') {
      const ownedWebhookId = webhook.record.id;
      const owned = (await listAll(ports.dialpad, '/api/v2/subscriptions/call', parseSubscription)).filter((sub) => sub.webhookId === ownedWebhookId);
      for (const canary of canaries) {
        const mine = owned.filter((sub) => sub.targetType === 'user' && sub.targetId === canary.userId);
        if (mine.length > 1) canary.subscription = { kind: 'duplicate' };
        else if (mine.length === 1) canary.subscription = sameStates(mine[0]!.callStates) ? { kind: 'owned', record: mine[0]! } : { kind: 'wrong_states' };
      }
      strayOwnedSubscriptions = owned.filter((sub) => !(sub.targetType === 'user' && sub.targetId !== null && inputs.canaryUserIds.includes(sub.targetId))).length;
    }
  }

  return {
    observed: {
      schema,
      orgExists,
      apiKey: apiKey.kind,
      clientId: clientId.kind,
      directoryKey: apiKey.kind,
      webhookSecret: webhookSecret.kind,
      connection,
      vercelNames,
      webhook,
      canaries,
      strayOwnedSubscriptions,
    },
    secrets,
  };
}

async function verifyDirectory(dialpad: DialpadPort, userId: string, companyId: string): Promise<CanaryObservation['directory']> {
  let response: DialpadHttpResponse;
  try {
    response = await dialpad.request('GET', `/api/v2/users/${userId}`);
  } catch {
    return 'unavailable';
  }
  if (response.status === 404) return 'not_found';
  if (response.status === 401 || response.status === 403) return 'rejected';
  if (response.status !== 200) return 'unavailable';
  const user = parseDialpadDirectoryUser(response.text);
  if (!user || user.id !== userId) return 'invalid_response';
  if (user.state !== 'active') return 'inactive';
  if (user.companyId !== companyId) return 'company_mismatch';
  return 'verified';
}

/* ------------------------------------------------------------------------ */
/* Plan                                                                     */
/* ------------------------------------------------------------------------ */

export type StepAction = 'create' | 'reuse' | 'enable' | 'skip';

export interface PlanStep {
  id: string;
  action: StepAction;
  detail: string;
}

export interface PlanTargets {
  supabaseProjectRef: string;
  vercelProject: string;
  vercelScope: string;
}

export interface Plan {
  mode: ProvisioningMode;
  connectionId: string | null;
  targets: PlanTargets;
  steps: readonly PlanStep[];
  notes: readonly string[];
  blockers: readonly string[];
  conflicts: readonly string[];
  digest: string;
}

function digestOf(body: Omit<Plan, 'digest'>, inputs: ProvisioningInputs): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, inputs: { ...inputs, canaryUserIds: [...inputs.canaryUserIds] }, body }))
    .digest('hex');
}

export function connectionConflicts(inputs: ProvisioningInputs, connection: ConnectionObservation): string[] {
  const out: string[] = [];
  const check = (field: string, ok: boolean) => {
    if (!ok) out.push(`connection_${field}_differs`);
  };
  check('webhook_secret_ref', connection.webhookSecretRef === inputs.webhookSecretRef);
  check('webhook_secret_version', connection.webhookSecretVersion === 1);
  check('allowed_origins', connection.allowedOrigins.length === 1 && connection.allowedOrigins[0] === DIALPAD_ALLOWED_ORIGIN);
  check('company_id', connection.companyId === inputs.companyId);
  check('directory_key_ref', connection.directoryKeyRef === inputs.directoryKeyRef);
  check('cti_client_id', connection.ctiClientIdMatches);
  return out;
}

export function buildPlan(inputs: ProvisioningInputs, o: Observed): Plan {
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  const blockers: string[] = [];
  const conflicts: string[] = [];
  const prepare = inputs.mode === 'prepare';
  const need = (ok: boolean, message: string) => {
    if (!ok) blockers.push(message);
  };

  // Inputs and prerequisites.
  need(o.orgExists, 'org_not_found: the typed org id does not exist');
  need(o.schema.a2Columns, 'a2_columns_missing: dialpad_company_id/directory_api_key_ref absent; merge PR694 and run the production migrate job first');
  need(o.apiKey === 'ok', `dialpad_api_key_${o.apiKey}: 1Password item ${inputs.apiKeyItem}`);
  need(o.clientId === 'ok', `cti_client_id_${o.clientId}: 1Password item ${inputs.clientIdItem}`);
  for (const canary of o.canaries) {
    need(canary.directory === 'verified' || canary.directory === 'unchecked', `canary_${canary.userId}_${canary.directory}`);
    if (canary.directory === 'unchecked') blockers.push(`canary_${canary.userId}_unchecked: Dialpad API key unavailable`);
  }
  steps.push({ id: 'check:org', action: 'skip', detail: `org ${inputs.orgId} ${o.orgExists ? 'exists' : 'not found'}` });
  steps.push({ id: 'check:schema', action: 'skip', detail: `a2_columns=${o.schema.a2Columns} custom_data_function=${o.schema.customDataFunction}` });
  for (const canary of o.canaries) steps.push({ id: `check:canary:${canary.userId}`, action: 'skip', detail: `directory ${canary.directory} for company ${inputs.companyId}` });

  // Connection.
  const connection = o.connection;
  if (connection) {
    conflicts.push(...connectionConflicts(inputs, connection));
    steps.push({ id: 'connection', action: 'reuse', detail: `connection ${connection.id} status=${connection.status}` });
  } else {
    steps.push({ id: 'connection', action: 'create', detail: `insert disabled connection for org ${inputs.orgId}` });
  }
  const connectionKnown = connection !== null;

  // Webhook secret item.
  if (o.webhookSecret === 'duplicate' || o.webhookSecret === 'invalid') conflicts.push(`webhook_secret_item_${o.webhookSecret}: ${inputs.webhookSecretItem}`);
  steps.push({
    id: 'secret-store:webhook-secret',
    action: o.webhookSecret === 'ok' ? 'reuse' : 'create',
    detail: `1Password item "${inputs.webhookSecretItem}" field ${CREDENTIAL_FIELD}`,
  });

  // Vercel env names.
  for (const [name, sourceOk] of [
    [inputs.webhookSecretEnv, o.webhookSecret === 'ok'],
    [inputs.directoryKeyEnv, o.directoryKey === 'ok'],
  ] as const) {
    const present = o.vercelNames.includes(name);
    if (present && !sourceOk && name === inputs.webhookSecretEnv) conflicts.push(`vercel_env_without_stored_secret: ${name}`);
    steps.push({
      id: `vercel:${name}`,
      action: present ? 'reuse' : 'create',
      detail: present ? `production sensitive env ${name} present (value not verifiable)` : `add production sensitive env ${name} (value via stdin)`,
    });
  }

  // Webhook.
  const wh = o.webhook;
  if (wh.kind === 'duplicate' || wh.kind === 'secret_mismatch' || wh.kind === 'no_stored_secret' || wh.kind === 'wrong_algo') conflicts.push(`webhook_${wh.kind}`);
  const hookUrl = connectionKnown ? webhookUrlFor(inputs, connection.id) : `${inputs.publicOrigin}${WEBHOOK_PATH}<new connection id>`;
  steps.push({
    id: 'dialpad:webhook',
    action: wh.kind === 'owned' ? 'reuse' : 'create',
    detail: wh.kind === 'owned' ? `webhook ${wh.record.id} ${hookUrl}` : `create signed HS256 webhook ${hookUrl}`,
  });

  // Subscriptions.
  for (const canary of o.canaries) {
    const sub = canary.subscription;
    if (sub.kind === 'duplicate' || sub.kind === 'wrong_states') conflicts.push(`subscription_${canary.userId}_${sub.kind}`);
    steps.push({
      id: `dialpad:subscription:${canary.userId}`,
      action: sub.kind === 'owned' ? 'reuse' : 'create',
      detail:
        sub.kind === 'owned'
          ? `subscription ${sub.record.id} enabled=${String(sub.record.enabled)}`
          : `create call subscription for user ${canary.userId} states=${CALL_STATES.join(',')} enabled=false`,
    });
  }
  if (o.strayOwnedSubscriptions > 0) notes.push(`${o.strayOwnedSubscriptions} owned subscription(s) target users outside the typed canaries; left untouched`);
  notes.push('existing SMS webhooks and unrelated subscriptions are never read for change or modified');

  // Activation.
  if (!prepare) {
    need(o.schema.customDataFunction, 'custom_data_migration_missing: dialpad_cti_custom_data() absent (PR697 migration not applied)');
    need(connection !== null, 'not_prepared: connection row missing');
    need(o.webhookSecret === 'ok', 'not_prepared: webhook secret item missing');
    need(o.vercelNames.includes(inputs.webhookSecretEnv) && o.vercelNames.includes(inputs.directoryKeyEnv), 'not_prepared: Vercel env names missing');
    need(wh.kind === 'owned', 'not_prepared: owned webhook missing');
    for (const canary of o.canaries) need(canary.subscription.kind === 'owned', `not_prepared: subscription for ${canary.userId} missing`);
    for (const canary of o.canaries) {
      if (canary.subscription.kind !== 'owned') continue;
      const enabled = canary.subscription.record.enabled === true;
      steps.push({
        id: `activate:subscription:${canary.userId}`,
        action: enabled ? 'reuse' : 'enable',
        detail: `subscription ${canary.subscription.record.id} ${enabled ? 'already enabled' : 'enable'}`,
      });
    }
    if (connection) {
      steps.push({
        id: 'activate:connection',
        action: connection.status === 'active' ? 'reuse' : 'enable',
        detail: connection.status === 'active' ? 'connection already active' : `set connection ${connection.id} status=active after every subscription is enabled and reverified`,
      });
    }
  }

  const targets: PlanTargets = {
    supabaseProjectRef: inputs.supabaseProjectRef,
    vercelProject: inputs.vercelProject,
    vercelScope: inputs.vercelScope,
  };
  const body = { mode: inputs.mode, connectionId: connection?.id ?? null, targets, steps, notes, blockers, conflicts };
  return { ...body, digest: digestOf(body, inputs) };
}

export function renderPlan(plan: Plan): string[] {
  const lines = [`plan digest ${plan.digest}`, `mode ${plan.mode}`, `targets supabaseProjectRef=${plan.targets.supabaseProjectRef} vercelProject=${plan.targets.vercelProject} vercelScope=${plan.targets.vercelScope}`];
  for (const step of plan.steps) lines.push(`  [${step.action}] ${step.id}: ${step.detail}`);
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  for (const blocker of plan.blockers) lines.push(`  BLOCKER: ${blocker}`);
  for (const conflict of plan.conflicts) lines.push(`  CONFLICT: ${conflict}`);
  return lines;
}

/* ------------------------------------------------------------------------ */
/* Apply                                                                    */
/* ------------------------------------------------------------------------ */

export interface StepResult {
  id: string;
  outcome: 'done' | 'reconciled' | 'reused';
}

interface ApplyContext {
  ports: ProvisioningPorts;
  inputs: ProvisioningInputs;
  guard: SecretGuard;
  observed: Observed;
  secrets: Secrets;
  connectionId: string | null;
  results: StepResult[];
}

/** Runs a mutation; if it errors, re-checks whether the object now exists before giving up. Never deletes anything. */
async function mutateWithReconcile(ctx: ApplyContext, id: string, mutate: () => Promise<void>, exists: () => Promise<boolean>): Promise<void> {
  try {
    await mutate();
  } catch (error) {
    let present = false;
    try {
      present = await exists();
    } catch {
      present = false;
    }
    if (!present) throw error;
    ctx.results.push({ id, outcome: 'reconciled' });
    return;
  }
  ctx.results.push({ id, outcome: 'done' });
}

function connectionRow(inputs: ProvisioningInputs, clientId: string): ConnectionInsert {
  return { orgId: inputs.orgId, ctiClientId: clientId, webhookSecretRef: inputs.webhookSecretRef, companyId: inputs.companyId, directoryKeyRef: inputs.directoryKeyRef };
}

async function applyPrepare(ctx: ApplyContext, plan: Plan): Promise<void> {
  const { ports, inputs, guard } = ctx;
  const action = (id: string) => plan.steps.find((step) => step.id === id)?.action;
  const clientId = ctx.secrets.clientId!;

  if (action('connection') === 'create') {
    const found = async () => {
      const existing = await ports.db.findConnection(inputs.orgId, clientId);
      if (!existing) return false;
      if (connectionConflicts(inputs, existing).length > 0) throw new ProvisioningError('connection_conflict', 'a conflicting connection row appeared during execution');
      ctx.connectionId = existing.id;
      return true;
    };
    await mutateWithReconcile(
      ctx,
      'connection',
      async () => {
        const id = await ports.db.insertDisabledConnection(connectionRow(inputs, clientId));
        if (!id) throw new ProvisioningError('connection_exists', 'a connection row appeared during execution; rerun the dry-run');
        ctx.connectionId = id;
      },
      found,
    );
    if (!ctx.connectionId) throw new ProvisioningError('connection_unresolved', 'connection id could not be determined');
  } else ctx.results.push({ id: 'connection', outcome: 'reused' });

  let webhookSecret = ctx.secrets.webhookSecret;
  if (action('secret-store:webhook-secret') === 'create') {
    const fresh = (ports.generateSecret ?? (() => randomBytes(32).toString('hex')))();
    guard.add(fresh);
    const note = `Signing secret for the Dialpad CTI voice webhook (${inputs.webhookSecretEnv}). Managed by provision-dialpad-cti; do not rotate without re-provisioning the Dialpad webhook.`;
    await mutateWithReconcile(
      ctx,
      'secret-store:webhook-secret',
      () => ports.secrets.create(inputs.webhookSecretItem, CREDENTIAL_FIELD, fresh, note),
      async () => (await ports.secrets.read(inputs.webhookSecretItem, CREDENTIAL_FIELD)).state === 'found',
    );
    const stored = await ports.secrets.read(inputs.webhookSecretItem, CREDENTIAL_FIELD);
    if (stored.state !== 'found' || !validSecret(stored.value)) throw new ProvisioningError('secret_store_readback_failed', 'the stored webhook secret could not be read back');
    guard.add(stored.value);
    webhookSecret = stored.value;
  } else ctx.results.push({ id: 'secret-store:webhook-secret', outcome: 'reused' });

  for (const [name, value] of [
    [inputs.webhookSecretEnv, webhookSecret],
    [inputs.directoryKeyEnv, ctx.secrets.directoryKey],
  ] as const) {
    const id = `vercel:${name}`;
    if (action(id) !== 'create') {
      ctx.results.push({ id, outcome: 'reused' });
      continue;
    }
    if (!value) throw new ProvisioningError('secret_unavailable', `no source value for ${name}`);
    await mutateWithReconcile(
      ctx,
      id,
      () => ports.vercel.addSensitiveProductionEnv(name, value),
      async () => (await ports.vercel.listProductionEnvNames()).includes(name),
    );
  }

  const connectionId = ctx.connectionId ?? ctx.observed.connection!.id;
  const hookUrl = webhookUrlFor(inputs, connectionId);
  const findWebhook = async (): Promise<WebhookRecord | null> => {
    const hooks = (await listAll(ports.dialpad, '/api/v2/webhooks', parseWebhook)).filter((hook) => hook.hookUrl === hookUrl);
    if (hooks.length > 1) throw new ProvisioningError('webhook_duplicate', 'more than one webhook matches the owned url');
    const hook = hooks[0] ?? null;
    guard.add(hook?.secret);
    if (hook && (hook.secret === null || !webhookSecret || !sameSecret(hook.secret, webhookSecret))) {
      throw new ProvisioningError('webhook_secret_mismatch', 'the owned webhook does not carry the stored secret');
    }
    return hook;
  };
  let webhook: WebhookRecord | null = ctx.observed.webhook.kind === 'owned' ? ctx.observed.webhook.record : null;
  if (action('dialpad:webhook') === 'create') {
    await mutateWithReconcile(
      ctx,
      'dialpad:webhook',
      async () => {
        const response = await ports.dialpad.request('POST', '/api/v2/webhooks', JSON.stringify({ hook_url: hookUrl, secret: webhookSecret }));
        if (response.status !== 200 && response.status !== 201) throw new ProvisioningError('webhook_create_failed', `create webhook returned HTTP ${response.status}`);
      },
      async () => (await findWebhook()) !== null,
    );
    webhook = await findWebhook();
    if (!webhook) throw new ProvisioningError('webhook_unverified', 'the created webhook was not found on re-list');
  } else ctx.results.push({ id: 'dialpad:webhook', outcome: 'reused' });

  for (const canary of inputs.canaryUserIds) {
    const id = `dialpad:subscription:${canary}`;
    if (action(id) !== 'create') {
      ctx.results.push({ id, outcome: 'reused' });
      continue;
    }
    const findOwned = async () => {
      const subs = (await listAll(ports.dialpad, '/api/v2/subscriptions/call', parseSubscription)).filter(
        (sub) => sub.webhookId === webhook!.id && sub.targetType === 'user' && sub.targetId === canary,
      );
      if (subs.length > 1) throw new ProvisioningError('subscription_duplicate', 'more than one owned subscription for the canary user');
      return subs[0] ?? null;
    };
    await mutateWithReconcile(
      ctx,
      id,
      async () => {
        const body = `{"endpoint_id":${webhook!.id},"target_type":"user","target_id":${canary},"call_states":${JSON.stringify(CALL_STATES)},"enabled":false}`;
        const response = await ports.dialpad.request('POST', '/api/v2/subscriptions/call', body);
        if (response.status !== 200 && response.status !== 201) throw new ProvisioningError('subscription_create_failed', `create subscription returned HTTP ${response.status}`);
      },
      async () => (await findOwned()) !== null,
    );
    const created = await findOwned();
    if (!created || !sameStates(created.callStates)) throw new ProvisioningError('subscription_unverified', 'the created subscription did not verify on re-list');
    if (created.enabled === true) throw new ProvisioningError('subscription_unexpectedly_enabled', 'a subscription was created enabled; investigate before continuing');
  }
}

async function applyActivate(ctx: ApplyContext): Promise<void> {
  const { ports, inputs } = ctx;

  // Enable and re-read every exact canary subscription before activating the
  // receiver. If any enable fails, the connection remains disabled and a
  // later rerun can resume from the subscriptions already verified.
  for (const canary of ctx.observed.canaries) {
    const sub = canary.subscription;
    const id = `activate:subscription:${canary.userId}`;
    if (sub.kind !== 'owned') throw new ProvisioningError('not_prepared', 'subscription missing');
    const subId = sub.record.id;
    const verifyEnabled = async (): Promise<boolean> => {
      const matches = (await listAll(ports.dialpad, '/api/v2/subscriptions/call', parseSubscription)).filter((entry) => entry.id === subId);
      return matches.length === 1 && matches[0]!.enabled === true && matches[0]!.targetType === 'user' && matches[0]!.targetId === canary.userId && matches[0]!.webhookId === sub.record.webhookId && sameStates(matches[0]!.callStates);
    };
    if (sub.record.enabled === true) {
      if (!(await verifyEnabled())) throw new ProvisioningError('subscription_unverified', `subscription ${subId} no longer matches the expected enabled canary`);
      ctx.results.push({ id, outcome: 'reused' });
      continue;
    }
    await mutateWithReconcile(
      ctx,
      id,
      async () => {
        const response = await ports.dialpad.request('PATCH', `/api/v2/subscriptions/call/${subId}`, '{"enabled":true}');
        if (response.status !== 200) throw new ProvisioningError('subscription_enable_failed', `enable subscription returned HTTP ${response.status}`);
      },
      verifyEnabled,
    );
    if (!(await verifyEnabled())) throw new ProvisioningError('subscription_unverified', `subscription ${subId} did not verify as enabled`);
  }

  const connection = ctx.observed.connection!;
  if (connection.status !== 'active') {
    const changed = await ports.db.activateConnection(connection.id, connectionRow(inputs, ctx.secrets.clientId!));
    if (changed !== 1) throw new ProvisioningError('activation_refused', 'the connection no longer matched the previewed state');
    ctx.results.push({ id: 'activate:connection', outcome: 'done' });
  } else ctx.results.push({ id: 'activate:connection', outcome: 'reused' });
}

/* ------------------------------------------------------------------------ */
/* Run                                                                      */
/* ------------------------------------------------------------------------ */

export interface RunOptions {
  execute: boolean;
  expectPlan?: string;
  confirmLiveReadiness?: string;
}

export interface RunResult {
  exitCode: 0 | 1 | 3;
  lines: string[];
  plan: Plan | null;
  results: StepResult[];
}

export async function runProvisioning(ports: ProvisioningPorts, inputs: ProvisioningInputs, options: RunOptions, guard = new SecretGuard()): Promise<RunResult> {
  const lines: string[] = [];
  const emit = (line: string) => lines.push(guard.scrub(line));
  const results: StepResult[] = [];
  let plan: Plan | null = null;
  try {
    emit(`${options.execute ? 'EXECUTE' : 'DRY RUN (no changes will be made)'} mode=${inputs.mode} org=${inputs.orgId} company=${inputs.companyId} canaries=${inputs.canaryUserIds.join(',')}`);
    const first = await observe(ports, inputs, guard);
    plan = buildPlan(inputs, first.observed);
    for (const line of renderPlan(plan)) emit(line);
    const clean = plan.blockers.length === 0 && plan.conflicts.length === 0;

    if (!options.execute) {
      if (!clean) {
        emit('plan is not executable until the blockers/conflicts above are resolved');
        return { exitCode: 3, lines, plan, results };
      }
      emit(`to apply exactly this plan: rerun with --execute --expect-plan ${plan.digest}${inputs.mode === 'activate' ? ' --confirm-live-readiness <connection id>' : ''}`);
      return { exitCode: 0, lines, plan, results };
    }

    if (!clean) {
      emit('refusing to execute: blockers or conflicts present');
      return { exitCode: 3, lines, plan, results };
    }
    if (!options.expectPlan || !PLAN_DIGEST.test(options.expectPlan) || options.expectPlan !== plan.digest) {
      emit('refusing to execute: --expect-plan must equal the digest of the plan just previewed (state changed or digest missing)');
      return { exitCode: 3, lines, plan, results };
    }
    if (inputs.mode === 'activate' && options.confirmLiveReadiness !== first.observed.connection?.id) {
      emit('refusing to activate: --confirm-live-readiness must equal the connection id after root live-readiness review');
      return { exitCode: 3, lines, plan, results };
    }

    const ctx: ApplyContext = { ports, inputs, guard, observed: first.observed, secrets: first.secrets, connectionId: null, results };
    try {
      if (inputs.mode === 'prepare') await applyPrepare(ctx, plan);
      else await applyActivate(ctx);
    } catch (error) {
      for (const result of results) emit(`  done ${result.id}: ${result.outcome}`);
      emit(`FAILED: ${guard.describeError(error)}`);
      emit('partial state was left in place; nothing was deleted. Re-run the dry-run to reconcile.');
      return { exitCode: 1, lines, plan, results };
    }
    for (const result of results) emit(`  done ${result.id}: ${result.outcome}`);

    const after = await observe(ports, inputs, guard);
    const post = buildPlan(inputs, after.observed);
    const pending = post.steps.filter((step) => step.action === 'create' || step.action === 'enable');
    if (pending.length > 0 || post.blockers.length > 0 || post.conflicts.length > 0) {
      emit(`post-check: ${pending.length} step(s) still pending, ${post.blockers.length} blocker(s), ${post.conflicts.length} conflict(s); rerun the dry-run`);
      return { exitCode: 1, lines, plan, results };
    }
    emit('post-check: converged, a rerun would change nothing');
    return { exitCode: 0, lines, plan, results };
  } catch (error) {
    emit(`FAILED: ${guard.describeError(error)}`);
    return { exitCode: 1, lines, plan, results };
  }
}
