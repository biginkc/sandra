import { describe, expect, it } from 'vitest';

import {
  CALL_STATES,
  ProvisioningError,
  SecretGuard,
  buildPlan,
  observe,
  parseInputs,
  runProvisioning,
  type ConnectionObservation,
  type ProvisioningInputs,
  type ProvisioningPorts,
  type RunOptions,
  type SchemaState,
} from './provisioning';

const ORG = '00000000-0000-0000-0000-000000000bbb';
const COMPANY = '4632779695783936';
const U1 = '5000000000000001';
const U2 = '5000000000000002';
const API_KEY = `dp_api_key_${'A'.repeat(24)}`;
const CLIENT_ID = `client_id_${'B'.repeat(15)}`;
const PAT = `sbp_${'P'.repeat(30)}`;
const FRESH_SECRET = `whsec_${'c'.repeat(58)}`;
const SMS_SECRET = `sms_secret_${'s'.repeat(30)}`;
const CONNECTION_ID = 'c0000000-0000-4000-8000-000000000001';
const RECORDING_ENDPOINT = 'wss://receiver.example.test/dialpad-browser-ingest';
const OTHER_RECORDING_ENDPOINT = 'wss://other-receiver.example.test/dialpad-browser-ingest';
const BIG_WEBHOOK_ID = '9007199254740993';
const SECRETS = [API_KEY, CLIENT_ID, PAT, FRESH_SECRET, SMS_SECRET];

interface WorldHook {
  id: string;
  hook_url: string;
  secret: string;
  algo: string;
}
interface WorldSub {
  id: string;
  enabled: boolean;
  call_states: string[];
  target_type: string;
  target_id: string;
  webhook_id: string | null;
}

interface World {
  items: Map<string, { count: number; value: string | null }>;
  schema: SchemaState;
  orgExists: boolean;
  connection: ConnectionObservation | null;
  env: Set<string>;
  hooks: WorldHook[];
  subs: WorldSub[];
  users: Map<string, { state: string; company: string }>;
  log: string[];
  vercelAdds: { name: string; value: string }[];
  requests: { method: string; path: string; body?: string }[];
  fail: Map<string, 'before' | 'after'>;
  nextId: number;
  nextHookId: string;
}

function makeWorld(): World {
  return {
    items: new Map([
      ['Dialpad - API', { count: 1, value: API_KEY }],
      ['Dialpad - CTI Client ID', { count: 1, value: CLIENT_ID }],
    ]),
    schema: { a2Columns: true, customDataFunction: true, recordingEndpointColumn: true },
    orgExists: true,
    connection: null,
    env: new Set(['CRON_SECRET', 'DIALPAD_API_KEY']),
    hooks: [{ id: '9000000000000001', hook_url: 'https://sandra.bmhgroupkc.com/api/webhooks/dialpad/sms', secret: SMS_SECRET, algo: 'HS256' }],
    subs: [
      { id: '8000000000000001', enabled: true, call_states: ['connected', 'hangup'], target_type: 'user', target_id: U1, webhook_id: null },
      { id: '8000000000000002', enabled: true, call_states: ['connected', 'hangup'], target_type: 'user', target_id: U2, webhook_id: '9000000000000001' },
    ],
    users: new Map([
      [U1, { state: 'active', company: COMPANY }],
      [U2, { state: 'active', company: COMPANY }],
    ]),
    log: [],
    vercelAdds: [],
    requests: [],
    fail: new Map(),
    nextId: 1,
    nextHookId: '7000000000000001',
  };
}

function gate(w: World, key: string): 'after' | null {
  const mode = w.fail.get(key);
  if (mode === 'before') throw new Error(`injected failure ${key} ${FRESH_SECRET}`);
  return mode === 'after' ? 'after' : null;
}

function page(items: unknown[], cursor: string | null): string {
  const start = cursor ? Number(cursor) : 0;
  const slice = items.slice(start, start + 2);
  const next = start + 2 < items.length ? String(start + 2) : null;
  return JSON.stringify({ items: slice, ...(next ? { cursor: next } : {}) });
}

// Int64 ids are emitted as bare numbers, exactly as Dialpad returns them.
function rawId(json: string): string {
  return json.replace(/"(id|target_id|endpoint_id|company_id)":"(\d+)"/g, '"$1":$2');
}

function hookJson(hook: WorldHook): unknown {
  return { id: hook.id, hook_url: hook.hook_url, signature: { algo: hook.algo, secret: hook.secret, type: 'jwt' } };
}

function subJson(sub: WorldSub): unknown {
  return {
    id: sub.id,
    enabled: sub.enabled,
    call_states: sub.call_states,
    target_type: sub.target_type,
    target_id: sub.target_id,
    ...(sub.webhook_id ? { webhook: { id: sub.webhook_id, hook_url: 'x' } } : { websocket: { id: '6000000000000001' } }),
  };
}

function makePorts(w: World): ProvisioningPorts {
  return {
    generateSecret: () => FRESH_SECRET,
    secrets: {
      async read(title, field) {
        void field;
        const item = w.items.get(title);
        if (!item) return { state: 'missing' };
        if (item.count > 1) return { state: 'duplicate' };
        return item.value === null ? { state: 'no_field' } : { state: 'found', value: item.value };
      },
      async create(title, field, value) {
        void field;
        const after = gate(w, 'secrets.create');
        if (w.items.has(title)) throw new Error('item exists');
        w.items.set(title, { count: 1, value });
        w.log.push(`secrets.create ${title}`);
        if (after) throw new Error(`lost response ${value}`);
      },
    },
    db: {
      async inspectSchema() {
        return w.schema;
      },
      async organizationExists() {
        return w.orgExists;
      },
      async findConnection() {
        return w.connection ? { ...w.connection } : null;
      },
      async insertDisabledConnection(row) {
        const after = gate(w, 'db.insert');
        if (w.connection) return null;
        w.connection = {
          id: CONNECTION_ID,
          status: 'disabled',
          webhookSecretRef: row.webhookSecretRef,
          webhookSecretVersion: 1,
          allowedOrigins: ['https://dialpad.com'],
          companyId: row.companyId,
          directoryKeyRef: row.directoryKeyRef,
          ctiClientIdMatches: row.ctiClientId === CLIENT_ID,
          recordingIngestEndpoint: null,
        };
        w.log.push('db.insert');
        if (after) throw new Error('lost response');
        return CONNECTION_ID;
      },
      async activateConnection(id, expected) {
        gate(w, 'db.activate');
        const c = w.connection;
        if (!c || c.id !== id || c.status !== 'disabled' || c.webhookSecretRef !== expected.webhookSecretRef || (expected.recordingIngestEndpoint !== undefined && c.recordingIngestEndpoint !== expected.recordingIngestEndpoint)) return 0;
        c.status = 'active';
        w.log.push('db.activate');
        return 1;
      },
      async configureRecordingEndpoint(expected) {
        const c = w.connection;
        if (!w.schema.recordingEndpointColumn || !c || c.id !== expected.connectionId || c.status !== 'disabled' || c.companyId !== expected.companyId || c.recordingIngestEndpoint !== expected.expectedPreviousEndpoint) return null;
        c.recordingIngestEndpoint = expected.proposedEndpoint;
        w.log.push('db.configure-recording-endpoint');
        return { ...c };
      },
    },
    vercel: {
      async listProductionEnvNames() {
        return [...w.env];
      },
      async addSensitiveProductionEnv(name, value) {
        const after = gate(w, `vercel.add:${name}`);
        w.env.add(name);
        w.vercelAdds.push({ name, value });
        w.log.push(`vercel.add ${name}`);
        if (after) throw new Error(`lost response ${value}`);
      },
    },
    dialpad: {
      async request(method, path, bodyText) {
        w.requests.push({ method, path, ...(bodyText !== undefined ? { body: bodyText } : {}) });
        const url = new URL(path, 'https://dialpad.com');
        const cursor = url.searchParams.get('cursor');
        const user = /^\/api\/v2\/users\/(\d+)$/.exec(url.pathname);
        if (method === 'GET' && user) {
          const found = w.users.get(user[1]!);
          if (!found) return { status: 404, text: '{}' };
          return { status: 200, text: `{"id":${user[1]},"company_id":${found.company},"state":"${found.state}","emails":["someone@example.test"]}` };
        }
        if (method === 'GET' && url.pathname === '/api/v2/webhooks') return { status: 200, text: rawId(page(w.hooks.map(hookJson), cursor)) };
        if (method === 'GET' && url.pathname === '/api/v2/subscriptions/call') return { status: 200, text: rawId(page(w.subs.map(subJson), cursor)) };
        if (method === 'POST' && url.pathname === '/api/v2/webhooks') {
          const after = gate(w, 'dialpad.webhook.create');
          const body = JSON.parse(bodyText!) as { hook_url: string; secret: string };
          const hook: WorldHook = { id: w.nextHookId, hook_url: body.hook_url, secret: body.secret, algo: 'HS256' };
          w.hooks.push(hook);
          w.log.push('POST /api/v2/webhooks');
          if (after) throw new Error('lost response');
          return { status: 201, text: rawId(JSON.stringify(hookJson(hook))) };
        }
        if (method === 'POST' && url.pathname === '/api/v2/subscriptions/call') {
          const endpoint = /"endpoint_id":(\d+)/.exec(bodyText!)![1]!;
          const target = /"target_id":(\d+)/.exec(bodyText!)![1]!;
          const after = gate(w, `dialpad.subscription.create:${target}`);
          const body = JSON.parse(bodyText!) as { call_states: string[]; enabled: boolean; target_type: string };
          const sub: WorldSub = { id: String(8100000000000000 + w.nextId++), enabled: body.enabled, call_states: body.call_states, target_type: body.target_type, target_id: target, webhook_id: endpoint };
          w.subs.push(sub);
          w.log.push(`POST /api/v2/subscriptions/call ${target}`);
          if (after) throw new Error('lost response');
          return { status: 201, text: rawId(JSON.stringify(subJson(sub))) };
        }
        const patch = /^\/api\/v2\/subscriptions\/call\/(\d+)$/.exec(url.pathname);
        if (method === 'PATCH' && patch) {
          const sub = w.subs.find((entry) => entry.id === patch[1]);
          const after = gate(w, `dialpad.subscription.enable:${sub?.target_id}`);
          if (!sub) return { status: 404, text: '{}' };
          sub.enabled = JSON.parse(bodyText!).enabled === true;
          w.log.push(`PATCH ${sub.target_id}`);
          if (after) throw new Error('lost response');
          return { status: 200, text: rawId(JSON.stringify(subJson(sub))) };
        }
        return { status: 404, text: '{}' };
      },
    },
  };
}

const inputs = parseInputs({ orgId: ORG, companyId: COMPANY, canaryUserIds: [U1, U2] });
const activateInputs = parseInputs({ mode: 'activate', orgId: ORG, companyId: COMPANY, canaryUserIds: [U1, U2] });

async function dryRun(w: World, i: ProvisioningInputs = inputs) {
  return runProvisioning(makePorts(w), i, { execute: false });
}

async function execute(w: World, i: ProvisioningInputs = inputs, extra: Partial<RunOptions> = {}) {
  const preview = await dryRun(w, i);
  return runProvisioning(makePorts(w), i, { execute: true, expectPlan: preview.plan!.digest, ...extra });
}

function noSecrets(lines: readonly string[]) {
  const text = lines.join('\n');
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

function snapshotUnrelated(w: World) {
  return JSON.stringify({ hooks: w.hooks.filter((h) => h.id === '9000000000000001'), subs: w.subs.filter((s) => s.id.startsWith('80000000')), env: ['CRON_SECRET', 'DIALPAD_API_KEY'].filter((n) => w.env.has(n)) });
}

async function prepared(): Promise<World> {
  const w = makeWorld();
  const result = await execute(w);
  expect(result.exitCode).toBe(0);
  w.connection!.recordingIngestEndpoint = RECORDING_ENDPOINT;
  w.log.length = 0;
  w.requests.length = 0;
  return w;
}

describe('parseInputs', () => {
  it('derives dedicated names and refs from the suffix', () => {
    expect(inputs.webhookSecretEnv).toBe('DIALPAD_CTI_WEBHOOK_SECRET_BMH');
    expect(inputs.directoryKeyEnv).toBe('DIALPAD_CTI_DIRECTORY_KEY_BMH');
    expect(inputs.webhookSecretRef).toBe('env:DIALPAD_CTI_WEBHOOK_SECRET_BMH');
    expect(inputs.directoryKeyRef).toBe('env:DIALPAD_CTI_DIRECTORY_KEY_BMH');
    expect(inputs.mode).toBe('prepare');
  });

  it.each([
    ['missing org', { companyId: COMPANY, canaryUserIds: [U1] }],
    ['non-uuid org', { orgId: 'bmh', companyId: COMPANY, canaryUserIds: [U1] }],
    ['missing company', { orgId: ORG, canaryUserIds: [U1] }],
    ['non-numeric company', { orgId: ORG, companyId: 'abc', canaryUserIds: [U1] }],
    ['no canary', { orgId: ORG, companyId: COMPANY, canaryUserIds: [] }],
    ['three canaries', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1, U2, '5000000000000003'] }],
    ['duplicate canary', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1, U1] }],
    ['leading-zero canary', { orgId: ORG, companyId: COMPANY, canaryUserIds: ['0123'] }],
    ['http origin', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], publicOrigin: 'http://sandra.bmhgroupkc.com' }],
    ['origin with path', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], publicOrigin: 'https://sandra.bmhgroupkc.com/x' }],
    ['lowercase suffix', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], suffix: 'bmh' }],
    ['invalid Supabase project ref', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], projectRef: 'not-a-project-ref' }],
    ['invalid Vercel project', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], vercelProject: 'sandra/project' }],
    ['invalid Vercel scope', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], vercelScope: 'jarrad scope' }],
    ['unknown mode', { orgId: ORG, companyId: COMPANY, canaryUserIds: [U1], mode: 'activate-all' }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseInputs(raw)).toThrow(ProvisioningError);
  });
});

describe('dry run', () => {
  it.each(['/api/v2/webhooks', '/api/v2/subscriptions/call'])('preserves listed resources when %s ends with an empty cursor page', async (path) => {
    const w = await prepared();
    const baseline = await dryRun(w);
    const ports = makePorts(w);
    const request = ports.dialpad.request.bind(ports.dialpad);
    ports.dialpad.request = async (method, requestedPath, body) => {
      if (method === 'GET' && requestedPath === `${path}?cursor=terminal`) return { status: 200, text: '{}' };
      const response = await request(method, requestedPath, body);
      if (method === 'GET' && requestedPath.split('?')[0] === path) {
        const page = JSON.parse(response.text);
        if (!page.cursor) response.text = JSON.stringify({ ...page, cursor: 'terminal' });
      }
      return response;
    };
    const result = await runProvisioning(ports, inputs, { execute: false });
    expect(result.exitCode).toBe(0);
    expect(result.plan!.steps).toEqual(baseline.plan!.steps);
    expect(w.log).toEqual([]);
  });

  it.each(['{}', 'null', '{"items":null}', '{"error":"failed"}', '{"cursor":"next"}'])('rejects unreadable initial pages: %s', async (text) => {
    const w = await prepared();
    const ports = makePorts(w);
    const request = ports.dialpad.request.bind(ports.dialpad);
    ports.dialpad.request = async (method, path, body) => path === '/api/v2/subscriptions/call'
      ? { status: 200, text }
      : request(method, path, body);
    const result = await runProvisioning(ports, inputs, { execute: false });
    expect(result.exitCode).toBe(1);
    expect(w.log).toEqual([]);
  });

  it('previews every create and performs no mutation', async () => {
    const w = makeWorld();
    const result = await dryRun(w);
    expect(result.exitCode).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.vercelAdds).toEqual([]);
    expect(w.requests.every((r) => r.method === 'GET')).toBe(true);
    const actions = Object.fromEntries(result.plan!.steps.map((s) => [s.id, s.action]));
    expect(actions).toMatchObject({
      connection: 'create',
      'secret-store:webhook-secret': 'create',
      'vercel:DIALPAD_CTI_WEBHOOK_SECRET_BMH': 'create',
      'vercel:DIALPAD_CTI_DIRECTORY_KEY_BMH': 'create',
      'dialpad:webhook': 'create',
      [`dialpad:subscription:${U1}`]: 'create',
      [`dialpad:subscription:${U2}`]: 'create',
    });
    expect(result.lines.join('\n')).toContain('--execute --expect-plan');
    expect(result.lines.join('\n')).toContain('enabled=false');
    noSecrets(result.lines);
  });

  it('is deterministic for identical state and changes when state changes', async () => {
    const w = makeWorld();
    const a = await dryRun(w);
    const b = await dryRun(w);
    expect(a.plan!.digest).toBe(b.plan!.digest);
    w.env.add('DIALPAD_CTI_DIRECTORY_KEY_BMH');
    expect((await dryRun(w)).plan!.digest).not.toBe(a.plan!.digest);
  });

  it('binds the typed Supabase and Vercel targets into the displayed plan and digest', async () => {
    const w = makeWorld();
    const defaultPlan = await dryRun(w);
    const alternateInputs = parseInputs({
      orgId: ORG,
      companyId: COMPANY,
      canaryUserIds: [U1, U2],
      projectRef: 'aaaaaaaaaaaaaaaaaaaa',
      vercelProject: 'other-project',
      vercelScope: 'other-scope',
    });
    const alternatePlan = await dryRun(w, alternateInputs);
    expect(defaultPlan.plan!.targets).toEqual({ supabaseProjectRef: 'copflsklaefwzipsrjqz', vercelProject: 'sandra', vercelScope: 'jarrad-5416s-projects' });
    expect(defaultPlan.lines.join('\n')).toContain('targets supabaseProjectRef=copflsklaefwzipsrjqz vercelProject=sandra vercelScope=jarrad-5416s-projects');
    expect(alternatePlan.plan!.targets).toEqual({ supabaseProjectRef: 'aaaaaaaaaaaaaaaaaaaa', vercelProject: 'other-project', vercelScope: 'other-scope' });
    expect(alternatePlan.plan!.digest).not.toBe(defaultPlan.plan!.digest);
  });

  it('reports a missing A2 schema as a blocker instead of planning DDL', async () => {
    const w = makeWorld();
    w.schema = { a2Columns: false, customDataFunction: false, recordingEndpointColumn: false };
    const result = await dryRun(w);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.blockers.join(' ')).toContain('a2_columns_missing');
  });

  it.each([
    ['not found', (w: World) => w.users.delete(U2), 'not_found'],
    ['inactive', (w: World) => w.users.set(U1, { state: 'suspended', company: COMPANY }), 'inactive'],
    ['other company', (w: World) => w.users.set(U1, { state: 'active', company: '1111' }), 'company_mismatch'],
  ])('blocks a canary that fails directory verification (%s)', async (_n, mutate, reason) => {
    const w = makeWorld();
    mutate(w);
    const result = await dryRun(w);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.blockers.join(' ')).toContain(reason);
  });

  it('blocks when the org or a required 1Password item is missing', async () => {
    const w = makeWorld();
    w.orgExists = false;
    w.items.delete('Dialpad - CTI Client ID');
    const result = await dryRun(w);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.blockers.join(' ')).toContain('org_not_found');
    expect(result.plan!.blockers.join(' ')).toContain('cti_client_id_missing');
  });
});

describe('execute (prepare)', () => {
  it('requires the previewed digest', async () => {
    const w = makeWorld();
    for (const expectPlan of [undefined, 'f'.repeat(64), 'nope']) {
      const result = await runProvisioning(makePorts(w), inputs, { execute: true, expectPlan });
      expect(result.exitCode).toBe(3);
    }
    expect(w.log).toEqual([]);
  });

  it('creates a disabled connection, the stored secret, env names, a signed webhook and disabled subscriptions', async () => {
    const w = makeWorld();
    const before = snapshotUnrelated(w);
    const result = await execute(w);
    expect(result.exitCode).toBe(0);
    expect(w.log).toEqual([
      'db.insert',
      'secrets.create Dialpad - CTI Webhook Secret - BMH',
      'vercel.add DIALPAD_CTI_WEBHOOK_SECRET_BMH',
      'vercel.add DIALPAD_CTI_DIRECTORY_KEY_BMH',
      'POST /api/v2/webhooks',
      `POST /api/v2/subscriptions/call ${U1}`,
      `POST /api/v2/subscriptions/call ${U2}`,
    ]);
    expect(w.connection).toMatchObject({ status: 'disabled', webhookSecretRef: 'env:DIALPAD_CTI_WEBHOOK_SECRET_BMH', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_BMH', companyId: COMPANY, allowedOrigins: ['https://dialpad.com'] });
    expect(w.items.get('Dialpad - CTI Webhook Secret - BMH')?.value).toBe(FRESH_SECRET);
    expect(w.vercelAdds).toEqual([
      { name: 'DIALPAD_CTI_WEBHOOK_SECRET_BMH', value: FRESH_SECRET },
      { name: 'DIALPAD_CTI_DIRECTORY_KEY_BMH', value: API_KEY },
    ]);
    const owned = w.hooks.find((h) => h.hook_url === `https://sandra.bmhgroupkc.com/api/webhooks/dialpad/voice/${CONNECTION_ID}`)!;
    expect(owned.secret).toBe(FRESH_SECRET);
    const mine = w.subs.filter((s) => s.webhook_id === owned.id);
    expect(mine.map((s) => [s.target_id, s.enabled, s.target_type])).toEqual([[U1, false, 'user'], [U2, false, 'user']]);
    expect(mine.every((s) => [...s.call_states].sort().join() === [...CALL_STATES].sort().join())).toBe(true);
    expect(snapshotUnrelated(w)).toBe(before);
    expect(result.lines.join('\n')).toContain('post-check: converged');
    noSecrets(result.lines);
  });

  it('never puts a secret in a Dialpad path or in any output, and sends the secret only in the webhook body', async () => {
    const w = makeWorld();
    const result = await execute(w);
    for (const request of w.requests) for (const secret of SECRETS) expect(request.path).not.toContain(secret);
    const bodiesWithSecret = w.requests.filter((r) => r.body?.includes(FRESH_SECRET));
    expect(bodiesWithSecret.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/v2/webhooks']);
    noSecrets(result.lines);
  });

  it('keeps 64-bit ids exact in the subscription create body', async () => {
    const w = makeWorld();
    w.nextHookId = BIG_WEBHOOK_ID;
    await execute(w);
    const body = w.requests.find((r) => r.method === 'POST' && r.path === '/api/v2/subscriptions/call')!.body!;
    expect(body).toContain(`"endpoint_id":${BIG_WEBHOOK_ID},`);
    expect(body).toContain(`"target_id":${U1},`);
    expect(body).toContain('"enabled":false');
  });

  it('is idempotent: a rerun reuses everything, does not rotate the secret and mutates nothing', async () => {
    const w = await prepared();
    const secretBefore = w.items.get('Dialpad - CTI Webhook Secret - BMH')!.value;
    const hooksBefore = w.hooks.length;
    const subsBefore = w.subs.length;
    const dry = await dryRun(w);
    expect(dry.plan!.steps.filter((s) => s.action === 'create')).toEqual([]);
    const again = await execute(w);
    expect(again.exitCode).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.items.get('Dialpad - CTI Webhook Secret - BMH')!.value).toBe(secretBefore);
    expect(w.hooks).toHaveLength(hooksBefore);
    expect(w.subs).toHaveLength(subsBefore);
  });

  it('reuses an existing matching connection, secret, env and webhook while creating only what is missing', async () => {
    const w = await prepared();
    w.subs = w.subs.filter((s) => s.target_id !== U2 || s.webhook_id === '9000000000000001');
    const result = await execute(w);
    expect(result.exitCode).toBe(0);
    expect(w.log).toEqual([`POST /api/v2/subscriptions/call ${U2}`]);
  });
});

describe('conflicts fail the run without mutating anything', () => {
  const cases: [string, (w: World) => void, string][] = [
    ['connection secret ref differs', (w) => (w.connection!.webhookSecretRef = 'env:DIALPAD_CTI_WEBHOOK_SECRET_OTHER'), 'connection_webhook_secret_ref_differs'],
    ['connection company differs', (w) => (w.connection!.companyId = '1234'), 'connection_company_id_differs'],
    ['connection origins differ', (w) => (w.connection!.allowedOrigins = ['https://dialpad.com', 'https://evil.example']), 'connection_allowed_origins_differs'],
    ['connection client id differs', (w) => (w.connection!.ctiClientIdMatches = false), 'connection_cti_client_id_differs'],
    ['connection directory ref differs', (w) => (w.connection!.directoryKeyRef = null), 'connection_directory_key_ref_differs'],
    ['connection secret version differs', (w) => (w.connection!.webhookSecretVersion = 2), 'connection_webhook_secret_version_differs'],
    ['webhook carries another secret', (w) => (w.hooks.find((h) => h.hook_url.includes('/voice/'))!.secret = `other_${'x'.repeat(30)}`), 'webhook_secret_mismatch'],
    ['webhook uses another algorithm', (w) => (w.hooks.find((h) => h.hook_url.includes('/voice/'))!.algo = 'HS512'), 'webhook_wrong_algo'],
    ['duplicate webhook for the url', (w) => w.hooks.push({ ...w.hooks.find((h) => h.hook_url.includes('/voice/'))!, id: '7000000000000099' }), 'webhook_duplicate'],
    ['subscription has other states', (w) => (w.subs.find((s) => s.target_id === U1 && s.webhook_id === '7000000000000001')!.call_states = ['connected']), `subscription_${U1}_wrong_states`],
    ['duplicate owned subscription', (w) => w.subs.push({ ...w.subs.find((s) => s.target_id === U1 && s.webhook_id === '7000000000000001')!, id: '8100000000000099' }), `subscription_${U1}_duplicate`],
    ['duplicate 1Password secret item', (w) => (w.items.get('Dialpad - CTI Webhook Secret - BMH')!.count = 2), 'webhook_secret_item_duplicate'],
    ['stored secret too short', (w) => (w.items.get('Dialpad - CTI Webhook Secret - BMH')!.value = 'short'), 'webhook_secret_item_invalid'],
  ];

  it.each(cases)('%s', async (_name, mutate, expected) => {
    const w = await prepared();
    mutate(w);
    const snapshot = JSON.stringify({ hooks: w.hooks, subs: w.subs, connection: w.connection, items: [...w.items], env: [...w.env] });
    const dry = await dryRun(w);
    expect(dry.exitCode).toBe(3);
    expect(dry.plan!.conflicts.join(' ')).toContain(expected);
    const attempt = await runProvisioning(makePorts(w), inputs, { execute: true, expectPlan: dry.plan!.digest });
    expect(attempt.exitCode).toBe(3);
    expect(w.log).toEqual([]);
    expect(JSON.stringify({ hooks: w.hooks, subs: w.subs, connection: w.connection, items: [...w.items], env: [...w.env] })).toBe(snapshot);
    noSecrets(attempt.lines);
  });

  it('refuses a Vercel env that exists while no stored secret does', async () => {
    const w = makeWorld();
    w.env.add('DIALPAD_CTI_WEBHOOK_SECRET_BMH');
    const result = await dryRun(w);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.conflicts.join(' ')).toContain('vercel_env_without_stored_secret');
  });

  it('refuses to adopt an existing webhook when no secret is stored for it', async () => {
    const w = await prepared();
    w.items.delete('Dialpad - CTI Webhook Secret - BMH');
    const result = await dryRun(w);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.conflicts.join(' ')).toContain('webhook_no_stored_secret');
  });

  it('leaves an unrelated webhook that reuses our path prefix alone', async () => {
    const w = makeWorld();
    w.hooks.push({ id: '7000000000000050', hook_url: 'https://sandra.bmhgroupkc.com/api/webhooks/dialpad/voice/other-connection', secret: SMS_SECRET, algo: 'HS256' });
    const result = await execute(w);
    expect(result.exitCode).toBe(0);
    expect(w.hooks.find((h) => h.id === '7000000000000050')?.secret).toBe(SMS_SECRET);
  });

  it('notes, but does not touch, owned subscriptions outside the typed canaries', async () => {
    const w = await prepared();
    const owned = w.hooks.find((h) => h.hook_url.includes('/voice/'))!;
    w.subs.push({ id: '8100000000000077', enabled: false, call_states: ['connected'], target_type: 'user', target_id: '5000000000000009', webhook_id: owned.id });
    const result = await execute(w);
    expect(result.exitCode).toBe(0);
    expect(result.plan!.notes.join(' ')).toContain('outside the typed canaries');
    expect(w.log).toEqual([]);
  });
});

describe('partial failure and reconciliation', () => {
  it('reports what completed, deletes nothing, and a rerun finishes the work', async () => {
    const w = makeWorld();
    w.fail.set('vercel.add:DIALPAD_CTI_DIRECTORY_KEY_BMH', 'before');
    const failed = await execute(w);
    expect(failed.exitCode).toBe(1);
    expect(failed.lines.join('\n')).toContain('FAILED: unexpected_error (Error)');
    expect(failed.lines.join('\n')).toContain('nothing was deleted');
    noSecrets(failed.lines);
    expect(w.connection?.status).toBe('disabled');
    expect(w.items.has('Dialpad - CTI Webhook Secret - BMH')).toBe(true);
    expect(w.env.has('DIALPAD_CTI_WEBHOOK_SECRET_BMH')).toBe(true);
    expect(w.hooks.some((h) => h.hook_url.includes('/voice/'))).toBe(false);

    w.fail.clear();
    w.log.length = 0;
    const resumed = await execute(w);
    expect(resumed.exitCode).toBe(0);
    expect(w.log).toEqual(['vercel.add DIALPAD_CTI_DIRECTORY_KEY_BMH', 'POST /api/v2/webhooks', `POST /api/v2/subscriptions/call ${U1}`, `POST /api/v2/subscriptions/call ${U2}`]);
    expect(w.items.get('Dialpad - CTI Webhook Secret - BMH')!.value).toBe(FRESH_SECRET);
  });

  it('reconciles a lost response for each create step instead of duplicating', async () => {
    const w = makeWorld();
    w.fail.set('db.insert', 'after');
    w.fail.set('secrets.create', 'after');
    w.fail.set('vercel.add:DIALPAD_CTI_WEBHOOK_SECRET_BMH', 'after');
    w.fail.set('dialpad.webhook.create', 'after');
    w.fail.set(`dialpad.subscription.create:${U1}`, 'after');
    const result = await execute(w);
    expect(result.exitCode).toBe(0);
    expect(result.results.filter((r) => r.outcome === 'reconciled').map((r) => r.id)).toEqual([
      'connection',
      'secret-store:webhook-secret',
      'vercel:DIALPAD_CTI_WEBHOOK_SECRET_BMH',
      'dialpad:webhook',
      `dialpad:subscription:${U1}`,
    ]);
    expect(w.hooks.filter((h) => h.hook_url.includes('/voice/'))).toHaveLength(1);
    expect(w.subs.filter((s) => s.target_id === U1 && s.webhook_id === '7000000000000001')).toHaveLength(1);
    expect(w.vercelAdds.filter((a) => a.name === 'DIALPAD_CTI_WEBHOOK_SECRET_BMH')).toHaveLength(1);
    noSecrets(result.lines);
  });

  it('stops after the first canary subscription when the second fails, and resumes without repeating', async () => {
    const w = makeWorld();
    w.fail.set(`dialpad.subscription.create:${U2}`, 'before');
    const failed = await execute(w);
    expect(failed.exitCode).toBe(1);
    expect(w.subs.filter((s) => s.webhook_id === '7000000000000001').map((s) => s.target_id)).toEqual([U1]);
    w.fail.clear();
    w.log.length = 0;
    const resumed = await execute(w);
    expect(resumed.exitCode).toBe(0);
    expect(w.log).toEqual([`POST /api/v2/subscriptions/call ${U2}`]);
  });

  it('fails closed when a created object does not verify on re-list', async () => {
    const w = makeWorld();
    const ports = makePorts(w);
    const original = ports.dialpad.request.bind(ports.dialpad);
    ports.dialpad.request = async (method, path, body) => {
      const response = await original(method, path, body);
      if (method === 'POST' && path === '/api/v2/subscriptions/call') w.subs.find((s) => s.webhook_id && s.target_id === U1 && s.webhook_id === '7000000000000001')!.enabled = true;
      return response;
    };
    const preview = await runProvisioning(ports, inputs, { execute: false });
    const result = await runProvisioning(ports, inputs, { execute: true, expectPlan: preview.plan!.digest });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('subscription_unexpectedly_enabled');
  });

  it('never leaks a secret carried by a thrown error message', async () => {
    const w = makeWorld();
    w.fail.set('vercel.add:DIALPAD_CTI_WEBHOOK_SECRET_BMH', 'before');
    const result = await execute(w);
    expect(result.exitCode).toBe(1);
    noSecrets(result.lines);
  });
});

describe('activate mode', () => {
  it('is blocked until everything is prepared and the custom_data migration exists', async () => {
    const w = makeWorld();
    const early = await dryRun(w, activateInputs);
    expect(early.exitCode).toBe(3);
    expect(early.plan!.blockers.join(' ')).toContain('not_prepared');

    const ready = await prepared();
    ready.schema = { a2Columns: true, customDataFunction: false, recordingEndpointColumn: true };
    const noMigration = await dryRun(ready, activateInputs);
    expect(noMigration.exitCode).toBe(3);
    expect(noMigration.plan!.blockers.join(' ')).toContain('custom_data_migration_missing');
  });

  it('fails closed when the disabled connection has no configured recording endpoint', async () => {
    const w = await prepared();
    w.connection!.recordingIngestEndpoint = null;
    const result = await dryRun(w, activateInputs);
    expect(result.exitCode).toBe(3);
    expect(result.plan!.blockers.join(' ')).toContain('recording ingest endpoint missing or invalid');
  });

  it('rechecks the endpoint before reusing an already-active connection', async () => {
    const w = await prepared();
    w.connection!.status = 'active';
    for (const sub of w.subs) {
      if (sub.webhook_id === '7000000000000001') sub.enabled = true;
    }
    const preview = await dryRun(w, activateInputs);
    expect(preview.exitCode).toBe(0);

    const ports = makePorts(w);
    const originalFind = ports.db.findConnection.bind(ports.db);
    let reads = 0;
    ports.db.findConnection = async (orgId, clientId) => {
      const current = await originalFind(orgId, clientId);
      reads += 1;
      if (reads === 2 && current) {
        w.connection!.recordingIngestEndpoint = OTHER_RECORDING_ENDPOINT;
        return { ...current, recordingIngestEndpoint: OTHER_RECORDING_ENDPOINT };
      }
      return current;
    };
    const result = await runProvisioning(ports, activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('activation_refused');
    expect(w.log).toEqual([]);
    expect(w.connection!.status).toBe('active');
    expect(w.connection!.recordingIngestEndpoint).toBe(OTHER_RECORDING_ENDPOINT);
  });

  it('a dry run previews the activation and changes nothing', async () => {
    const w = await prepared();
    const result = await dryRun(w, activateInputs);
    expect(result.exitCode).toBe(0);
    expect(w.log).toEqual([]);
    expect(result.plan!.steps.filter((s) => s.action === 'enable').map((s) => s.id)).toEqual([`activate:subscription:${U1}`, `activate:subscription:${U2}`, 'activate:connection']);
    expect(result.lines.join('\n')).toContain('--confirm-live-readiness');
  });

  it('requires the digest and the connection id confirmation', async () => {
    const w = await prepared();
    const preview = await dryRun(w, activateInputs);
    const noConfirm = await runProvisioning(makePorts(w), activateInputs, { execute: true, expectPlan: preview.plan!.digest });
    expect(noConfirm.exitCode).toBe(3);
    const wrongConfirm = await runProvisioning(makePorts(w), activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: 'c0000000-0000-4000-8000-00000000ffff' });
    expect(wrongConfirm.exitCode).toBe(3);
    const noDigest = await runProvisioning(makePorts(w), activateInputs, { execute: true, confirmLiveReadiness: CONNECTION_ID });
    expect(noDigest.exitCode).toBe(3);
    expect(w.log).toEqual([]);
    expect(w.connection?.status).toBe('disabled');
  });

  it('enables and re-verifies owned canary subscriptions before activating the connection', async () => {
    const w = await prepared();
    const before = snapshotUnrelated(w);
    const result = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(0);
    expect(w.log).toEqual([`PATCH ${U1}`, `PATCH ${U2}`, 'db.activate']);
    expect(w.connection?.status).toBe('active');
    expect(w.subs.filter((s) => s.webhook_id === '7000000000000001').every((s) => s.enabled)).toBe(true);
    expect(snapshotUnrelated(w)).toBe(before);
    const rerun = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(rerun.exitCode).toBe(0);
    expect(w.log).toEqual([`PATCH ${U1}`, `PATCH ${U2}`, 'db.activate']);
  });

  it('leaves the connection disabled when the first subscription enable fails', async () => {
    const w = await prepared();
    w.fail.set(`dialpad.subscription.enable:${U1}`, 'before');
    const failed = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(failed.exitCode).toBe(1);
    expect(w.connection?.status).toBe('disabled');
    expect(w.log).toEqual([]);
    w.fail.clear();
    w.log.length = 0;
    const resumed = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(resumed.exitCode).toBe(0);
    expect(w.connection?.status).toBe('active');
    expect(w.log).toEqual([`PATCH ${U1}`, `PATCH ${U2}`, 'db.activate']);
  });

  it('refuses before the first provider PATCH when the endpoint changed after preview', async () => {
    const w = await prepared();
    const preview = await dryRun(w, activateInputs);
    w.connection!.recordingIngestEndpoint = OTHER_RECORDING_ENDPOINT;
    const result = await runProvisioning(makePorts(w), activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(3);
    expect(w.log).toEqual([]);
    expect(w.connection!.status).toBe('disabled');
  });

  it('leaves partial provider state disabled when the endpoint changes during a subscription PATCH', async () => {
    const w = await prepared();
    const ports = makePorts(w);
    const original = ports.dialpad.request.bind(ports.dialpad);
    ports.dialpad.request = async (method, path, body) => {
      const response = await original(method, path, body);
      if (method === 'PATCH' && path.endsWith(w.subs.find((entry) => entry.target_id === U1 && entry.webhook_id === '7000000000000001')!.id)) w.connection!.recordingIngestEndpoint = OTHER_RECORDING_ENDPOINT;
      return response;
    };
    const preview = await runProvisioning(ports, activateInputs, { execute: false });
    const result = await runProvisioning(ports, activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(1);
    expect(w.log).toEqual([`PATCH ${U1}`]);
    expect(w.connection!.status).toBe('disabled');
    expect(w.subs.find((entry) => entry.target_id === U1 && entry.webhook_id === '7000000000000001')!.enabled).toBe(true);
  });

  it('binds the final activation CAS to the endpoint after provider operations', async () => {
    const w = await prepared();
    const ports = makePorts(w);
    const activate = ports.db.activateConnection.bind(ports.db);
    ports.db.activateConnection = async (id, expected) => {
      w.connection!.recordingIngestEndpoint = OTHER_RECORDING_ENDPOINT;
      return activate(id, expected);
    };
    const preview = await runProvisioning(ports, activateInputs, { execute: false });
    const result = await runProvisioning(ports, activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(1);
    expect(w.log).toEqual([`PATCH ${U1}`, `PATCH ${U2}`]);
    expect(w.connection!.status).toBe('disabled');
  });

  it('leaves the connection disabled when the second subscription enable fails and resumes without duplicating', async () => {
    const w = await prepared();
    w.fail.set(`dialpad.subscription.enable:${U2}`, 'before');
    const failed = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(failed.exitCode).toBe(1);
    expect(w.connection?.status).toBe('disabled');
    expect(w.log).toEqual([`PATCH ${U1}`]);
    w.fail.clear();
    w.log.length = 0;
    const resumed = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(resumed.exitCode).toBe(0);
    expect(w.log).toEqual([`PATCH ${U2}`, 'db.activate']);
  });

  it('reconciles a lost enable response', async () => {
    const w = await prepared();
    w.fail.set(`dialpad.subscription.enable:${U1}`, 'after');
    const result = await execute(w, activateInputs, { confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(0);
    expect(result.results.find((r) => r.id === `activate:subscription:${U1}`)?.outcome).toBe('reconciled');
    expect(w.connection?.status).toBe('active');
    expect(w.log).toEqual([`PATCH ${U1}`, `PATCH ${U2}`, 'db.activate']);
  });

  it('fails convergence when a post-apply prerequisite becomes unavailable', async () => {
    const w = await prepared();
    const ports = makePorts(w);
    const preview = await runProvisioning(ports, activateInputs, { execute: false });
    expect(preview.exitCode).toBe(0);
    const originalRequest = ports.dialpad.request.bind(ports.dialpad);
    ports.dialpad.request = async (method, path, body) => {
      const response = await originalRequest(method, path, body);
      const ownedSecond = w.subs.find((s) => s.target_id === U2 && s.webhook_id === '7000000000000001');
      if (method === 'PATCH' && ownedSecond && path.endsWith(ownedSecond.id)) w.schema = { ...w.schema, customDataFunction: false };
      return response;
    };
    const result = await runProvisioning(ports, activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('post-check: 0 step(s) still pending, 1 blocker(s), 0 conflict(s)');
    expect(result.lines.join('\n')).not.toContain('post-check: converged');
  });

  it('refuses if the connection changed after the preview', async () => {
    const w = await prepared();
    const preview = await dryRun(w, activateInputs);
    w.connection!.webhookSecretRef = 'env:DIALPAD_CTI_WEBHOOK_SECRET_OTHER';
    const result = await runProvisioning(makePorts(w), activateInputs, { execute: true, expectPlan: preview.plan!.digest, confirmLiveReadiness: CONNECTION_ID });
    expect(result.exitCode).toBe(3);
    expect(w.connection!.status).toBe('disabled');
  });
});

describe('secret guard and plan contents', () => {
  it('scrubs registered secrets and hides non-provisioning error messages', () => {
    const guard = new SecretGuard();
    guard.add(FRESH_SECRET);
    expect(guard.scrub(`a ${FRESH_SECRET} b ${FRESH_SECRET}`)).toBe('a [redacted] b [redacted]');
    expect(guard.describeError(new Error(`contains ${FRESH_SECRET}`))).toBe('unexpected_error (Error)');
    expect(guard.describeError(new ProvisioningError('code', `carries ${FRESH_SECRET}`))).toBe('code: carries [redacted]');
    expect(guard.describeError('string')).toBe('unexpected_error (non-error)');
  });

  it('builds the plan from observed state without any secret material', async () => {
    const w = await prepared();
    const guard = new SecretGuard();
    const { observed } = await observe(makePorts(w), inputs, guard);
    const plan = buildPlan(inputs, observed);
    expect(JSON.stringify(plan)).not.toMatch(new RegExp(SECRETS.join('|')));
    expect(plan.connectionId).toBe(CONNECTION_ID);
  });
});
