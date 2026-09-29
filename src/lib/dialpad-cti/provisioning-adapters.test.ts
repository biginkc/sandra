import { describe, expect, it } from 'vitest';

import {
  READ_TOKEN_SERVICE,
  WRITE_TOKEN_SERVICE,
  createConnectionDbPort,
  createDialpadPort,
  createManagementQueryRunner,
  createOnePasswordSecretStore,
  createVercelPort,
  parseVercelEnvNames,
  runCommand,
  type CommandRunner,
  type FetchLike,
  type OnePasswordSdk,
} from './provisioning-adapters';
import { ProvisioningError } from './provisioning';

const SECRET = `whsec_${'z'.repeat(40)}`;
const ORG = '00000000-0000-0000-0000-000000000bbb';
const CONNECTION = 'c0000000-0000-4000-8000-000000000001';
const ENDPOINT = 'wss://receiver.example.up.railway.app/dialpad-browser-ingest';

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('vercel adapter', () => {
  const table = [
    'Vercel CLI 59.10.0',
    '> Environment Variables found for team/sandra [194ms]',
    '',
    ' name                                       value                       type      environments        created',
    ' NEXT_PUBLIC_FLAG                           eyJ2IjoidjIiLCJjIj…         Config    Production          3d ago',
    ' CRON_SECRET                                Hidden                      Secret    Production          10d ago',
    ' PREVIEW_ONLY                               Hidden                      Secret    Preview             10d ago',
    ' DIALPAD_CTI_WEBHOOK_SECRET_BMH             Hidden                      Sensitive Production          1m ago',
  ].join('\n');

  it('lists production env names only', () => {
    expect(parseVercelEnvNames(table)).toEqual(['CRON_SECRET', 'DIALPAD_CTI_WEBHOOK_SECRET_BMH', 'NEXT_PUBLIC_FLAG']);
  });

  it('sends the value on stdin only and never in argv', async () => {
    const calls: { args: readonly string[]; stdin?: string }[] = [];
    const run: CommandRunner = async (_command, args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: table };
    };
    const port = createVercelPort({ run });
    await port.addSensitiveProductionEnv('DIALPAD_CTI_WEBHOOK_SECRET_BMH', SECRET);
    expect(calls[0]!.args).toEqual(['env', 'add', 'DIALPAD_CTI_WEBHOOK_SECRET_BMH', 'production', '--sensitive', '--project', 'sandra', '--scope', 'jarrad-5416s-projects']);
    expect(calls[0]!.args.join(' ')).not.toContain(SECRET);
    expect(calls[0]!.stdin).toBe(SECRET);
    expect(await port.listProductionEnvNames()).toContain('CRON_SECRET');
    expect(calls[1]!.args).toEqual(['env', 'ls', 'production', '--project', 'sandra', '--scope', 'jarrad-5416s-projects']);
  });

  it('reports only the exit code on failure and rejects odd env names', async () => {
    const port = createVercelPort({ run: async () => ({ code: 7, stdout: SECRET }) });
    const error = await rejection(port.addSensitiveProductionEnv('DIALPAD_CTI_WEBHOOK_SECRET_BMH', SECRET));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).not.toContain(SECRET);
    await expect(port.addSensitiveProductionEnv('bad name; rm', SECRET)).rejects.toThrow(/invalid env name/);
    await expect(port.listProductionEnvNames()).rejects.toThrow(/exited 7/);
  });

  it('runCommand pipes stdin to the child without a shell', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], SECRET);
    expect(result).toEqual({ code: 0, stdout: SECRET });
  });

  it('runCommand strips 1Password variables from the child environment', async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN_TEST = 'x';
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(String(Object.keys(process.env).some((k) => k.startsWith("OP_"))))']);
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN_TEST;
    expect(result.stdout).toBe('false');
  });
});

describe('dialpad adapter', () => {
  const okFetch = (seen: { url: string; init: Parameters<FetchLike>[1] }[]): FetchLike => async (url, init) => {
    seen.push({ url, init });
    return { status: 200, text: async () => '{}' };
  };

  it('calls only the Dialpad origin with a bearer key, no redirects, and the body only in the request body', async () => {
    const seen: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const port = createDialpadPort(async () => 'dp_key_0123456789abcdef', okFetch(seen));
    await port.request('POST', '/api/v2/webhooks', `{"secret":"${SECRET}"}`);
    expect(seen[0]!.url).toBe('https://dialpad.com/api/v2/webhooks');
    expect(seen[0]!.url).not.toContain(SECRET);
    expect(seen[0]!.init.redirect).toBe('error');
    expect(seen[0]!.init.body).toContain(SECRET);
    expect(seen[0]!.init.headers.Authorization).toBe('Bearer dp_key_0123456789abcdef');
  });

  it('rejects paths outside /api/v2 and hides transport error text', async () => {
    const port = createDialpadPort(async () => 'k'.repeat(20), async () => {
      throw new Error(`socket said ${SECRET}`);
    });
    await expect(port.request('GET', '/other')).rejects.toThrow(/unexpected Dialpad path/);
    await expect(port.request('GET', 'https://evil.example/api/v2/x')).rejects.toThrow(ProvisioningError);
    const error = await rejection(port.request('GET', '/api/v2/webhooks?cursor=abc'));
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('/api/v2/webhooks');
  });
});

describe('management api adapter', () => {
  it('posts the query to the pinned project and surfaces only the status on failure', async () => {
    const seen: { url: string; body?: string; auth: string }[] = [];
    const run = createManagementQueryRunner('abcdefghijklmnopqrst', async () => 'pat_value_0123456789', async (url, init) => {
      seen.push({ url, body: init.body, auth: init.headers.Authorization! });
      return { status: 200, text: async () => '[{"ok":true}]' };
    });
    expect(await run('select 1')).toEqual([{ ok: true }]);
    expect(seen[0]).toMatchObject({ url: 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query', body: '{"query":"select 1"}', auth: 'Bearer pat_value_0123456789' });

    const failing = createManagementQueryRunner('abcdefghijklmnopqrst', async () => 'pat', async () => ({ status: 400, text: async () => `select ${SECRET}` }));
    const error = await rejection(failing('select 1'));
    expect(error.message).toBe('Management API query returned HTTP 400');
    expect(() => createManagementQueryRunner('not-a-ref', async () => 'p')).toThrow(ProvisioningError);
  });
});

describe('connection db port', () => {
  function capture(rowsFor: (sql: string) => unknown[] = () => []) {
    const statements: string[] = [];
    const port = createConnectionDbPort(async (sql) => {
      statements.push(sql);
      return rowsFor(sql);
    });
    return { port, statements };
  }
  const row = { orgId: ORG, ctiClientId: 'client_id_BBBBBBBBBBBBBBB', webhookSecretRef: 'env:DIALPAD_CTI_WEBHOOK_SECRET_BMH', companyId: '4632779695783936', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_BMH' };

  it('inserts a disabled row with the default origin and returns the new id', async () => {
    const { port, statements } = capture(() => [{ id: 'c0000000-0000-4000-8000-000000000001' }]);
    expect(await port.insertDisabledConnection(row)).toBe('c0000000-0000-4000-8000-000000000001');
    expect(statements[0]).toContain("'disabled'");
    expect(statements[0]).toContain("array['https://dialpad.com']::text[]");
    expect(statements[0]).toContain('on conflict (org_id) do nothing');
    expect(statements[0]).toContain(`'${row.webhookSecretRef}'`);
    expect((await capture().port.insertDisabledConnection(row))).toBeNull();
  });

  it('compares the client id inside SQL so it is never returned, and maps the row', async () => {
    const { port, statements } = capture(() => [
      { id: 'c0000000-0000-4000-8000-000000000001', status: 'disabled', webhook_secret_ref: row.webhookSecretRef, webhook_secret_version: 1, allowed_origins: ['https://dialpad.com'], dialpad_company_id: row.companyId, directory_api_key_ref: row.directoryKeyRef, cti_client_id_matches: true },
    ]);
    const found = await port.findConnection(ORG, row.ctiClientId);
    expect(statements[0]).toContain('(cti_client_id =');
    expect(statements[0]).not.toMatch(/select[^;]*\bcti_client_id,/);
    expect(found).toMatchObject({ status: 'disabled', webhookSecretVersion: 1, companyId: row.companyId, ctiClientIdMatches: true });
    expect(await capture().port.findConnection(ORG, null)).toBeNull();
  });

  it('activates only when every expected field still matches', async () => {
    const { port, statements } = capture(() => [{ id: 'x' }]);
    expect(await port.activateConnection('c0000000-0000-4000-8000-000000000001', { ...row, recordingIngestEndpoint: ENDPOINT })).toBe(1);
    expect(statements[0]).toContain("status = 'disabled'");
    expect(statements[0]).toContain('webhook_secret_ref =');
    expect(statements[0]).toContain('dialpad_company_id =');
    expect(statements[0]).toContain('cti_client_id =');
    expect(statements[0]).toContain(`recording_ingest_endpoint is not distinct from '${ENDPOINT}'`);
    expect(await capture(() => []).port.activateConnection('c0000000-0000-4000-8000-000000000001', row)).toBe(0);
  });

  it('inspects schema and organization state', async () => {
    const { port } = capture((sql) => (sql.includes('a2_columns') ? [{ a2_columns: true, custom_data_function: false }] : [{ org_exists: true }]));
    expect(await port.inspectSchema()).toEqual({ a2Columns: true, customDataFunction: false, recordingEndpointColumn: false });
    expect(await port.organizationExists(ORG)).toBe(true);
  });

  it('reads the endpoint only after schema inspection and never references it when absent', async () => {
    const { port, statements } = capture((sql) => sql.includes('recording_endpoint_column')
      ? [{ a2_columns: true, recording_endpoint_column: true, custom_data_function: true }]
      : [{ id: CONNECTION, status: 'disabled', webhook_secret_ref: row.webhookSecretRef, webhook_secret_version: 1, allowed_origins: ['https://dialpad.com'], dialpad_company_id: row.companyId, directory_api_key_ref: row.directoryKeyRef, recording_ingest_endpoint: ENDPOINT, cti_client_id_matches: true }]);
    await port.inspectSchema();
    const found = await port.findConnection(ORG, row.ctiClientId, CONNECTION);
    expect(found).toMatchObject({ id: CONNECTION, recordingIngestEndpoint: ENDPOINT });
    expect(statements[1]).toContain('recording_ingest_endpoint');
    expect(statements[1]).toContain(`id = '${CONNECTION}'`);

    const absent = capture((sql) => sql.includes('recording_endpoint_column') ? [{ a2_columns: true, recording_endpoint_column: false, custom_data_function: true }] : [{ id: CONNECTION, status: 'disabled', webhook_secret_ref: row.webhookSecretRef, webhook_secret_version: 1, allowed_origins: ['https://dialpad.com'], dialpad_company_id: row.companyId, directory_api_key_ref: row.directoryKeyRef, cti_client_id_matches: true }]);
    await absent.port.inspectSchema();
    await absent.port.findConnection(ORG, row.ctiClientId, CONNECTION);
    expect(absent.statements[1]).not.toContain('recording_ingest_endpoint');
  });

  it('builds endpoint CAS with exact disabled identity and expected previous value', async () => {
    const { port, statements } = capture((sql) => sql.includes('recording_endpoint_column')
      ? [{ a2_columns: true, recording_endpoint_column: true, custom_data_function: true }]
      : [{ id: CONNECTION, status: 'disabled', webhook_secret_ref: row.webhookSecretRef, webhook_secret_version: 1, allowed_origins: ['https://dialpad.com'], dialpad_company_id: row.companyId, directory_api_key_ref: row.directoryKeyRef, cti_client_id_matches: false, recording_ingest_endpoint: ENDPOINT }]);
    await port.inspectSchema();
    const updated = await port.configureRecordingEndpoint({ orgId: ORG, connectionId: CONNECTION, companyId: row.companyId, expectedPreviousEndpoint: null, proposedEndpoint: ENDPOINT });
    expect(updated).toMatchObject({ id: CONNECTION, status: 'disabled', recordingIngestEndpoint: ENDPOINT });
    const sql = statements[1]!;
    expect(sql).toContain(`id = '${CONNECTION}'`);
    expect(sql).toContain(`org_id = '${ORG}'`);
    expect(sql).toContain(`dialpad_company_id = '${row.companyId}'`);
    expect(sql).toContain("status = 'disabled'");
    expect(sql).toContain('recording_ingest_endpoint is not distinct from null');
    expect(sql).toContain(`recording_ingest_endpoint = '${ENDPOINT}'`);
  });

  it('refuses endpoint CAS before constructing an update when the column is absent or the value is unsafe', async () => {
    const absent = capture((sql) => sql.includes('recording_endpoint_column') ? [{ a2_columns: true, recording_endpoint_column: false, custom_data_function: true }] : []);
    await absent.port.inspectSchema();
    await expect(absent.port.configureRecordingEndpoint({ orgId: ORG, connectionId: CONNECTION, companyId: row.companyId, expectedPreviousEndpoint: null, proposedEndpoint: ENDPOINT })).rejects.toThrow(/recording_ingest_endpoint is absent/);
    expect(absent.statements).toHaveLength(1);
    const present = capture((sql) => sql.includes('recording_endpoint_column') ? [{ a2_columns: true, recording_endpoint_column: true, custom_data_function: true }] : []);
    await present.port.inspectSchema();
    await expect(present.port.configureRecordingEndpoint({ orgId: ORG, connectionId: CONNECTION, companyId: row.companyId, expectedPreviousEndpoint: null, proposedEndpoint: "wss://evil.example.test/x'" })).rejects.toThrow(/failed validation before SQL construction/);
    expect(present.statements).toHaveLength(1);
  });

  it('refuses to build SQL from unsafe values', async () => {
    const { port, statements } = capture();
    await expect(port.organizationExists("x'; drop table t; --")).rejects.toThrow(ProvisioningError);
    await expect(port.insertDisabledConnection({ ...row, ctiClientId: "a'b" })).rejects.toThrow(ProvisioningError);
    await expect(port.insertDisabledConnection({ ...row, directoryKeyRef: 'env:X; drop' })).rejects.toThrow(ProvisioningError);
    expect(statements).toEqual([]);
  });

  it('issues data statements only, never DDL', async () => {
    const { port, statements } = capture((sql) =>
      sql.includes('cti_client_id_matches')
        ? [{ id: 'c0000000-0000-4000-8000-000000000001', status: 'disabled', webhook_secret_ref: 'env:DIALPAD_CTI_WEBHOOK_SECRET_BMH' }]
        : [{ id: 'c0000000-0000-4000-8000-000000000001' }],
    );
    await port.inspectSchema();
    await port.organizationExists(ORG);
    await port.findConnection(ORG, row.ctiClientId);
    await port.insertDisabledConnection(row);
    await port.activateConnection('c0000000-0000-4000-8000-000000000001', row);
    for (const sql of statements) expect(sql).not.toMatch(/\b(create|alter|drop|truncate|grant|revoke)\s+(table|function|index|policy|role|extension|schema|column|constraint|trigger)/i);
  });
});

describe('1password secret store adapter', () => {
  function fakeSdk(items: { id: string; title: string; state?: string; fields?: { title: string; value?: string }[] }[]) {
    const created: Record<string, unknown>[] = [];
    const tokens: string[] = [];
    const sdk: OnePasswordSdk = {
      ItemCategory: { ApiCredentials: 'ApiCredentials' },
      ItemFieldType: { Concealed: 'Concealed' },
      async createClient(config) {
        tokens.push(config.auth);
        return {
          vaults: { list: async () => [{ id: 'v1', title: 'Other' }, { id: 'v2', title: 'BMH Secrets' }] },
          items: {
            list: async () => items.map(({ id, title, state }) => ({ id, title, state })),
            get: async (_vault, id) => ({ fields: items.find((item) => item.id === id)!.fields ?? [] }),
            create: async (params) => {
              created.push(params);
            },
          },
        };
      },
    };
    const keychain: string[] = [];
    const store = createOnePasswordSecretStore({
      loadSdk: async () => sdk,
      readKeychain: (service) => {
        keychain.push(service);
        return `token-for-${service}`;
      },
    });
    return { store, created, tokens, keychain };
  }

  it('reads with the read-only token and classifies missing, duplicate, fieldless, archived and found', async () => {
    const { store, keychain } = fakeSdk([
      { id: 'a', title: 'Found', fields: [{ title: 'credential', value: SECRET }] },
      { id: 'b', title: 'Twice' },
      { id: 'c', title: 'Twice' },
      { id: 'd', title: 'Fieldless', fields: [{ title: 'other', value: 'x' }] },
      { id: 'e', title: 'Archived', state: 'archived', fields: [{ title: 'credential', value: 'x' }] },
    ]);
    expect(await store.read('Found', 'credential')).toEqual({ state: 'found', value: SECRET });
    expect(await store.read('Twice', 'credential')).toEqual({ state: 'duplicate' });
    expect(await store.read('Fieldless', 'credential')).toEqual({ state: 'no_field' });
    expect(await store.read('Archived', 'credential')).toEqual({ state: 'missing' });
    expect(await store.read('Nope', 'credential')).toEqual({ state: 'missing' });
    expect(keychain).toEqual([READ_TOKEN_SERVICE]);
  });

  it('uses the read-write token only to create a concealed API credential', async () => {
    const { store, created, keychain } = fakeSdk([]);
    await store.read('Nope', 'credential');
    expect(keychain).toEqual([READ_TOKEN_SERVICE]);
    await store.create('Dialpad - CTI Webhook Secret - BMH', 'credential', SECRET, 'note');
    expect(keychain).toEqual([READ_TOKEN_SERVICE, WRITE_TOKEN_SERVICE]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ category: 'ApiCredentials', vaultId: 'v2', title: 'Dialpad - CTI Webhook Secret - BMH', notes: 'note' });
    expect(JSON.stringify(created[0]!.fields)).toContain('Concealed');
    expect(String(created[0]!.notes)).not.toContain(SECRET);
  });
});
