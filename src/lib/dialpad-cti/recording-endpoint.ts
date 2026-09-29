import { createHash } from 'node:crypto';

import {
  DEFAULT_SUPABASE_PROJECT_REF,
  ProvisioningError,
  isCanonicalRecordingHostname,
  isCanonicalRecordingIngestEndpoint,
  type ConnectionDbPort,
  type ConnectionObservation,
  type RecordingEndpointUpdate,
  type SchemaState,
} from './provisioning';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPANY_ID = /^[1-9][0-9]{0,19}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;

export interface RawRecordingEndpointInputs {
  orgId?: string;
  connectionId?: string;
  companyId?: string;
  endpoint?: string;
  verifiedHostname?: string;
  projectRef?: string;
  /** Must be present. `null` is the explicit first-setup value. */
  expectedPreviousEndpoint?: string | null;
}

export interface RecordingEndpointInputs {
  orgId: string;
  connectionId: string;
  companyId: string;
  endpoint: string;
  verifiedHostname: string;
  projectRef: string;
  expectedPreviousEndpoint: string | null;
}

export function parseRecordingEndpointInputs(raw: RawRecordingEndpointInputs): RecordingEndpointInputs {
  const orgId = raw.orgId?.trim().toLowerCase() ?? '';
  const connectionId = raw.connectionId?.trim().toLowerCase() ?? '';
  const companyId = raw.companyId?.trim() ?? '';
  const projectRef = (raw.projectRef ?? DEFAULT_SUPABASE_PROJECT_REF).trim().toLowerCase();
  if (!UUID.test(orgId) || !UUID.test(connectionId)) throw new ProvisioningError('invalid_input', 'typed organization and connection UUIDs are required');
  if (!COMPANY_ID.test(companyId)) throw new ProvisioningError('invalid_input', 'a typed Dialpad company id is required');
  if (!PROJECT_REF.test(projectRef)) throw new ProvisioningError('invalid_input', 'project ref must be a 20-character lowercase Supabase ref');
  if (typeof raw.verifiedHostname !== 'string' || !isCanonicalRecordingHostname(raw.verifiedHostname)) {
    throw new ProvisioningError('invalid_input', 'verified hostname must be a canonical lowercase ASCII service hostname');
  }
  if (typeof raw.endpoint !== 'string' || !isCanonicalRecordingIngestEndpoint(raw.endpoint)) {
    throw new ProvisioningError('invalid_input', 'endpoint must be canonical wss://<verified-hostname>/dialpad-browser-ingest');
  }
  const parsed = new URL(raw.endpoint);
  if (parsed.hostname !== raw.verifiedHostname) throw new ProvisioningError('invalid_input', 'endpoint hostname does not equal the verified service hostname');
  if (!Object.prototype.hasOwnProperty.call(raw, 'expectedPreviousEndpoint') || raw.expectedPreviousEndpoint === undefined) {
    throw new ProvisioningError('invalid_input', 'expected previous endpoint is required; pass null explicitly for first setup');
  }
  const expectedPreviousEndpoint = raw.expectedPreviousEndpoint;
  if (expectedPreviousEndpoint !== null && !isCanonicalRecordingIngestEndpoint(expectedPreviousEndpoint)) {
    throw new ProvisioningError('invalid_input', 'expected previous endpoint must be null or canonical wss://.../dialpad-browser-ingest');
  }
  return { orgId, connectionId, companyId, endpoint: raw.endpoint, verifiedHostname: raw.verifiedHostname, projectRef, expectedPreviousEndpoint };
}

export interface RecordingEndpointObserved {
  schema: SchemaState;
  orgExists: boolean;
  connection: ConnectionObservation | null;
}

export interface RecordingEndpointPlanStep {
  id: 'recording:endpoint';
  action: 'configure' | 'reconcile' | 'skip';
  detail: string;
}

export type RecordingEndpointOperation = 'configure' | 'already_configured' | 'blocked';

export interface RecordingEndpointPlan {
  operation: RecordingEndpointOperation;
  orgId: string;
  connectionId: string;
  companyId: string;
  status: string | null;
  oldEndpoint: string | null;
  newEndpoint: string;
  expectedPreviousEndpoint: string | null;
  verifiedHostname: string;
  projectRef: string;
  steps: readonly RecordingEndpointPlanStep[];
  blockers: readonly string[];
  conflicts: readonly string[];
  digest: string;
}

export async function observeRecordingEndpoint(db: ConnectionDbPort, inputs: RecordingEndpointInputs): Promise<RecordingEndpointObserved> {
  const schema = await db.inspectSchema();
  const orgExists = await db.organizationExists(inputs.orgId);
  const connection = schema.recordingEndpointColumn && orgExists ? await db.findConnection(inputs.orgId, null, inputs.connectionId) : null;
  return { schema, orgExists, connection };
}

function digestOf(body: Omit<RecordingEndpointPlan, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, body })).digest('hex');
}

function exactIdentity(connection: ConnectionObservation | null, inputs: RecordingEndpointInputs): boolean {
  return connection !== null
    && connection.id === inputs.connectionId
    && connection.companyId === inputs.companyId;
}

function exactDisabledEndpoint(connection: ConnectionObservation | null, inputs: RecordingEndpointInputs): boolean {
  if (!connection || connection.id !== inputs.connectionId || connection.companyId !== inputs.companyId) return false;
  return connection.status === 'disabled' && connection.recordingIngestEndpoint === inputs.endpoint;
}

export function buildRecordingEndpointPlan(inputs: RecordingEndpointInputs, observed: RecordingEndpointObserved): RecordingEndpointPlan {
  const blockers: string[] = [];
  const conflicts: string[] = [];
  const connection = observed.connection;
  const oldEndpoint = connection?.recordingIngestEndpoint ?? null;
  const status = connection?.status ?? null;
  const need = (ok: boolean, reason: string) => { if (!ok) blockers.push(reason); };

  need(observed.orgExists, 'org_not_found: the typed organization does not exist');
  need(observed.schema.recordingEndpointColumn, 'recording_endpoint_migration_missing: recording_ingest_endpoint column is absent; apply the reviewed browser-session migration first');
  if (observed.orgExists && observed.schema.recordingEndpointColumn && !connection) blockers.push('connection_not_found: no connection row exists for the typed organization');
  if (connection && connection.id !== inputs.connectionId) conflicts.push('connection_id_mismatch: the organization row is not the typed connection');
  if (connection && connection.companyId !== inputs.companyId) conflicts.push('company_id_mismatch: the connection company differs from the typed company');
  if (connection && connection.status === 'active') conflicts.push('active_connection_unsupported: endpoint rotation/configuration only supports disabled connections');
  if (connection && connection.status !== 'disabled' && connection.status !== 'active') conflicts.push(`connection_status_unsupported: ${connection.status}`);
  if (connection && oldEndpoint !== null && !isCanonicalRecordingIngestEndpoint(oldEndpoint)) conflicts.push('stored_endpoint_malformed: the existing endpoint is not canonical');

  const alreadyConfigured = connection !== null && connection.status === 'disabled' && exactIdentity(connection, inputs) && oldEndpoint === inputs.endpoint;
  if (connection && !alreadyConfigured && oldEndpoint !== inputs.expectedPreviousEndpoint) {
    conflicts.push('expected_previous_endpoint_mismatch: the stored endpoint changed since the operator read it');
  }

  const operation: RecordingEndpointOperation = blockers.length > 0 || conflicts.length > 0
    ? 'blocked'
    : alreadyConfigured ? 'already_configured' : 'configure';
  const steps: RecordingEndpointPlanStep[] = [{
    id: 'recording:endpoint',
    action: operation === 'configure' ? 'configure' : operation === 'already_configured' ? 'reconcile' : 'skip',
    detail: operation === 'configure'
      ? `set disabled connection ${inputs.connectionId} endpoint ${inputs.endpoint}`
      : operation === 'already_configured'
        ? `disabled connection ${inputs.connectionId} already has endpoint ${inputs.endpoint}`
        : `endpoint configuration blocked for connection ${inputs.connectionId}`,
  }];
  const body = { operation, orgId: inputs.orgId, connectionId: inputs.connectionId, companyId: inputs.companyId, projectRef: inputs.projectRef, status, oldEndpoint, newEndpoint: inputs.endpoint, expectedPreviousEndpoint: inputs.expectedPreviousEndpoint, verifiedHostname: inputs.verifiedHostname, steps, blockers, conflicts };
  return { ...body, digest: digestOf(body) };
}

function displayEndpoint(value: string | null): string {
  if (value === null) return 'null';
  return isCanonicalRecordingIngestEndpoint(value) ? value : '<invalid endpoint redacted>';
}

export function renderRecordingEndpointPlan(plan: RecordingEndpointPlan): string[] {
  return [
    `recording endpoint plan digest ${plan.digest}`,
    `operation ${plan.operation}`,
    `organization ${plan.orgId}`,
    `connection ${plan.connectionId}`,
    `company ${plan.companyId}`,
    `supabase project ref ${plan.projectRef}`,
    `status ${plan.status ?? 'missing'}`,
    `old endpoint ${displayEndpoint(plan.oldEndpoint)}`,
    `new endpoint ${displayEndpoint(plan.newEndpoint)}`,
    `verified hostname ${plan.verifiedHostname}`,
    ...plan.steps.map((step) => `  [${step.action}] ${step.id}: ${step.detail}`),
    ...plan.blockers.map((blocker) => `  BLOCKER: ${blocker}`),
    ...plan.conflicts.map((conflict) => `  CONFLICT: ${conflict}`),
  ];
}

export interface RecordingEndpointRunOptions {
  execute: boolean;
  expectPlan?: string;
}

export interface RecordingEndpointRunResult {
  exitCode: 0 | 1 | 3;
  lines: string[];
  plan: RecordingEndpointPlan | null;
  outcome: 'none' | 'done' | 'reconciled';
}

function updateFor(inputs: RecordingEndpointInputs): RecordingEndpointUpdate {
  return {
    orgId: inputs.orgId,
    connectionId: inputs.connectionId,
    companyId: inputs.companyId,
    expectedPreviousEndpoint: inputs.expectedPreviousEndpoint,
    proposedEndpoint: inputs.endpoint,
  };
}

async function fresh(db: ConnectionDbPort, inputs: RecordingEndpointInputs): Promise<RecordingEndpointObserved> {
  return observeRecordingEndpoint(db, inputs);
}

export async function runRecordingEndpointConfiguration(
  db: ConnectionDbPort,
  inputs: RecordingEndpointInputs,
  options: RecordingEndpointRunOptions,
): Promise<RecordingEndpointRunResult> {
  const lines: string[] = [];
  let plan: RecordingEndpointPlan | null = null;
  const emit = (line: string) => lines.push(line);
  try {
    const first = await fresh(db, inputs);
    plan = buildRecordingEndpointPlan(inputs, first);
    for (const line of renderRecordingEndpointPlan(plan)) emit(line);
    const clean = plan.blockers.length === 0 && plan.conflicts.length === 0;
    if (!options.execute) {
      if (!clean) {
        emit('plan is not executable until the blockers/conflicts above are resolved');
        return { exitCode: 3, lines, plan, outcome: 'none' };
      }
      emit(`to apply exactly this plan: rerun with --execute --expect-plan ${plan.digest}`);
      return { exitCode: 0, lines, plan, outcome: 'none' };
    }
    if (!clean) {
      emit('refusing to execute: blockers or conflicts present');
      return { exitCode: 3, lines, plan, outcome: 'none' };
    }
    if (!options.expectPlan || !PLAN_DIGEST.test(options.expectPlan) || options.expectPlan !== plan.digest) {
      emit('refusing to execute: --expect-plan must equal the digest of the plan just previewed');
      return { exitCode: 3, lines, plan, outcome: 'none' };
    }

    if (plan.operation === 'already_configured') {
      const current = await fresh(db, inputs);
      if (!exactDisabledEndpoint(current.connection, inputs)) {
        emit('FAILED: recording_endpoint_conflict: idempotent readback no longer matches the disabled endpoint');
        return { exitCode: 1, lines, plan, outcome: 'none' };
      }
      emit('post-check: exact disabled endpoint already configured');
      return { exitCode: 0, lines, plan, outcome: 'reconciled' };
    }

    let outcome: 'done' | 'reconciled' = 'done';
    try {
      const updated = await db.configureRecordingEndpoint(updateFor(inputs));
      if (!updated) {
        const current = await fresh(db, inputs);
        if (!exactDisabledEndpoint(current.connection, inputs)) {
          emit('FAILED: recording_endpoint_conflict: compare-and-set matched zero rows and readback was not exact');
          return { exitCode: 1, lines, plan, outcome: 'none' };
        }
        outcome = 'reconciled';
      }
    } catch (error) {
      const current = await fresh(db, inputs).catch(() => ({ schema: first.schema, orgExists: first.orgExists, connection: null }));
      if (!exactDisabledEndpoint(current.connection, inputs)) throw error;
      outcome = 'reconciled';
    }
    const after = await fresh(db, inputs);
    if (!exactDisabledEndpoint(after.connection, inputs)) {
      emit('FAILED: recording_endpoint_readback_failed: endpoint or disabled identity changed after compare-and-set');
      return { exitCode: 1, lines, plan, outcome: 'none' };
    }
    emit(`post-check: endpoint ${outcome === 'done' ? 'configured' : 'reconciled'} and connection remains disabled`);
    return { exitCode: 0, lines, plan, outcome };
  } catch (error) {
    emit(`FAILED: ${error instanceof ProvisioningError ? `${error.code}: ${error.message}` : 'unexpected_error'}`);
    return { exitCode: 1, lines, plan, outcome: 'none' };
  }
}
