import { describe, expect, it } from 'vitest';

import {
  ProvisioningError,
  type ConnectionDbPort,
  type ConnectionObservation,
  type RecordingEndpointUpdate,
  type SchemaState,
} from './provisioning';
import {
  buildRecordingEndpointPlan,
  observeRecordingEndpoint,
  parseRecordingEndpointInputs,
  runRecordingEndpointConfiguration,
} from './recording-endpoint';

const ORG = '00000000-0000-0000-0000-000000000bbb';
const CONNECTION = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CONNECTION = 'c0000000-0000-4000-8000-000000000002';
const COMPANY = '4632779695783936';
const HOST = 'receiver.example.up.railway.app';
const ENDPOINT = `wss://${HOST}/dialpad-browser-ingest`;
const OTHER_ENDPOINT = 'wss://old-receiver.example.up.railway.app/dialpad-browser-ingest';

function inputs(expectedPreviousEndpoint: string | null = null) {
  return parseRecordingEndpointInputs({ orgId: ORG, connectionId: CONNECTION, companyId: COMPANY, endpoint: ENDPOINT, verifiedHostname: HOST, expectedPreviousEndpoint });
}

function connection(overrides: Partial<ConnectionObservation> = {}): ConnectionObservation {
  return {
    id: CONNECTION,
    status: 'disabled',
    webhookSecretRef: 'env:DIALPAD_CTI_WEBHOOK_SECRET_BMH',
    webhookSecretVersion: 1,
    allowedOrigins: ['https://dialpad.com'],
    companyId: COMPANY,
    directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_BMH',
    ctiClientIdMatches: true,
    recordingIngestEndpoint: null,
    ...overrides,
  };
}

function fakeDb(options: {
  schema?: Partial<SchemaState>;
  orgExists?: boolean;
  row?: ConnectionObservation | null;
  beforeConfigure?: (row: ConnectionObservation) => void;
} = {}): { db: ConnectionDbPort; state: { schema: SchemaState; orgExists: boolean; row: ConnectionObservation | null; calls: RecordingEndpointUpdate[] } } {
  const state = {
    schema: { a2Columns: true, customDataFunction: true, recordingEndpointColumn: true, ...options.schema },
    orgExists: options.orgExists ?? true,
    row: options.row === undefined ? connection() : options.row,
    calls: [] as RecordingEndpointUpdate[],
  };
  const db: ConnectionDbPort = {
    async inspectSchema() { return state.schema; },
    async organizationExists() { return state.orgExists; },
    async findConnection() { return state.row ? { ...state.row } : null; },
    async insertDisabledConnection() { throw new Error('unused'); },
    async activateConnection() { throw new Error('unused'); },
    async configureRecordingEndpoint(expected) {
      state.calls.push(expected);
      options.beforeConfigure?.(state.row!);
      const row = state.row;
      if (!state.schema.recordingEndpointColumn || !row || row.id !== expected.connectionId || row.companyId !== expected.companyId || row.status !== 'disabled' || row.recordingIngestEndpoint !== expected.expectedPreviousEndpoint) return null;
      row.recordingIngestEndpoint = expected.proposedEndpoint;
      return { ...row };
    },
  };
  return { db, state };
}

const run = (db: ConnectionDbPort, i = inputs(), options: { execute: boolean; expectPlan?: string } = { execute: false }) => runRecordingEndpointConfiguration(db, i, options);

describe('recording endpoint input validation', () => {
  it('requires the exact verified lowercase hostname and explicit previous value', () => {
    expect(inputs().endpoint).toBe(ENDPOINT);
    expect(() => parseRecordingEndpointInputs({ orgId: ORG, connectionId: CONNECTION, companyId: COMPANY, endpoint: ENDPOINT, verifiedHostname: HOST })).toThrow(/expected previous endpoint/);
    expect(() => parseRecordingEndpointInputs({ orgId: ORG, connectionId: CONNECTION, companyId: COMPANY, endpoint: ENDPOINT, verifiedHostname: 'Receiver.example.up.railway.app', expectedPreviousEndpoint: null })).toThrow(/verified hostname/);
    expect(() => parseRecordingEndpointInputs({ orgId: ORG, connectionId: CONNECTION, companyId: COMPANY, endpoint: ENDPOINT, verifiedHostname: 'other.example.up.railway.app', expectedPreviousEndpoint: null })).toThrow(/does not equal/);
  });

  it.each([
    'https://receiver.example.up.railway.app/dialpad-browser-ingest',
    'wss://receiver.example.up.railway.app:443/dialpad-browser-ingest',
    'wss://receiver.example.up.railway.app/dialpad-browser-ingest?x=1',
    'wss://receiver.example.up.railway.app/dialpad-browser-ingest#x',
    'wss://user:pass@receiver.example.up.railway.app/dialpad-browser-ingest',
    'wss://receiver.example.up.railway.app./dialpad-browser-ingest',
    ' wss://receiver.example.up.railway.app/dialpad-browser-ingest',
    'wss://receiver.example.up.railway.app/dialpad-browser-ingest ',
    'wss://xn--receiver.example.up.railway.app/dialpad-browser-ingest',
    'wss://receiver.example.up.railway.app\\dialpad-browser-ingest',
    'wss://127.0.0.1/dialpad-browser-ingest',
  ])('rejects noncanonical endpoint %s', (endpoint) => {
    expect(() => parseRecordingEndpointInputs({ orgId: ORG, connectionId: CONNECTION, companyId: COMPANY, endpoint, verifiedHostname: HOST, expectedPreviousEndpoint: null })).toThrow(ProvisioningError);
  });
});

describe('recording endpoint planning and CAS', () => {
  it('blocks an unknown organization before any connection update', async () => {
    const { db, state } = fakeDb({ orgExists: false });
    const result = await run(db);
    expect(result.exitCode).toBe(3);
    expect(result.plan?.blockers.join(' ')).toContain('org_not_found');
    expect(state.calls).toEqual([]);
  });

  it('reports absent schema without attempting a connection read or SQL update', async () => {
    const { db, state } = fakeDb({ schema: { recordingEndpointColumn: false } });
    const observed = await observeRecordingEndpoint(db, inputs());
    expect(state.row).not.toBeNull();
    expect(observed.connection).toBeNull();
    const result = await run(db);
    expect(result.exitCode).toBe(3);
    expect(result.lines.join('\n')).toContain('recording_endpoint_migration_missing');
    expect(state.calls).toEqual([]);
  });

  it.each([
    ['wrong connection', connection({ id: OTHER_CONNECTION }), 'connection_id_mismatch'],
    ['wrong company', connection({ companyId: '9999999999999999' }), 'company_id_mismatch'],
    ['active status', connection({ status: 'active' }), 'active_connection_unsupported'],
    ['conflicting old endpoint', connection({ recordingIngestEndpoint: OTHER_ENDPOINT }), 'expected_previous_endpoint_mismatch'],
    ['malformed old endpoint', connection({ recordingIngestEndpoint: 'wss://bad host/dialpad-browser-ingest' }), 'stored_endpoint_malformed'],
  ])('blocks %s', async (_name, row, reason) => {
    const { db } = fakeDb({ row });
    const result = await run(db);
    expect(result.exitCode).toBe(3);
    expect(result.plan?.conflicts.join(' ')).toContain(reason);
  });

  it('redacts malformed stored endpoint values from operator output', async () => {
    const secret = 'endpoint-secret-that-must-not-print';
    const { db } = fakeDb({ row: connection({ recordingIngestEndpoint: `wss://user:${secret}@bad host/dialpad-browser-ingest` }) });
    const result = await run(db);
    const output = result.lines.join('\n');
    expect(output).toContain('<invalid endpoint redacted>');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('user:');
  });

  it('configures null to endpoint, leaves disabled, and exactly replays', async () => {
    const { db, state } = fakeDb();
    const preview = await run(db);
    expect(preview.exitCode).toBe(0);
    expect(preview.plan).toMatchObject({ operation: 'configure', oldEndpoint: null, newEndpoint: ENDPOINT, status: 'disabled' });
    const applied = await run(db, inputs(), { execute: true, expectPlan: preview.plan!.digest });
    expect(applied.exitCode).toBe(0);
    expect(applied.outcome).toBe('done');
    expect(state.row?.recordingIngestEndpoint).toBe(ENDPOINT);
    expect(state.row?.status).toBe('disabled');
    const replayPreview = await run(db);
    expect(replayPreview.plan?.operation).toBe('already_configured');
    const replay = await run(db, inputs(), { execute: true, expectPlan: replayPreview.plan!.digest });
    expect(replay.exitCode).toBe(0);
    expect(replay.outcome).toBe('reconciled');
    expect(state.calls).toHaveLength(1);
  });

  it('refuses a concurrent endpoint or status change and reports no false application', async () => {
    const endpointRace = fakeDb({ beforeConfigure: (row) => { row.recordingIngestEndpoint = OTHER_ENDPOINT; } });
    const preview = await run(endpointRace.db);
    const result = await run(endpointRace.db, inputs(), { execute: true, expectPlan: preview.plan!.digest });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('recording_endpoint_conflict');
    expect(endpointRace.state.row?.recordingIngestEndpoint).toBe(OTHER_ENDPOINT);

    const statusRace = fakeDb({ beforeConfigure: (row) => { row.status = 'active'; } });
    const statusPreview = await run(statusRace.db);
    const statusResult = await run(statusRace.db, inputs(), { execute: true, expectPlan: statusPreview.plan!.digest });
    expect(statusResult.exitCode).toBe(1);
    expect(statusResult.lines.join('\n')).toContain('recording_endpoint_conflict');
    expect(statusRace.state.row?.status).toBe('active');
  });

  it('binds organization, connection, company, old and new endpoint into the digest', async () => {
    const first = buildRecordingEndpointPlan(inputs(), await observeRecordingEndpoint(fakeDb().db, inputs()));
    const changed = buildRecordingEndpointPlan(inputs(OTHER_ENDPOINT), await observeRecordingEndpoint(fakeDb({ row: connection({ recordingIngestEndpoint: OTHER_ENDPOINT }) }).db, inputs(OTHER_ENDPOINT)));
    expect(first.digest).not.toBe(changed.digest);
    expect(JSON.stringify(first)).toContain(ORG);
    expect(JSON.stringify(first)).toContain(CONNECTION);
    expect(JSON.stringify(first)).toContain(COMPANY);
    expect(JSON.stringify(first)).toContain(ENDPOINT);
  });
});
