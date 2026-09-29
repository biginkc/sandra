import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url';
import { createConnectionDbPort } from '../../src/lib/dialpad-cti/provisioning-adapters';

const localDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
const ENDPOINT = 'wss://receiver.example.up.railway.app/dialpad-browser-ingest';
const OTHER_ENDPOINT = 'wss://other-receiver.example.up.railway.app/dialpad-browser-ingest';
const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);

const sql = (client: Client) => async (text: string, values: unknown[] = []) => client.query(text, values);

describe('recording endpoint activation CAS local race', () => {
  let root: Client;
  let contender: Client;
  let orgId: string;
  let connectionId: string;
  let companyId: string;

  beforeAll(async () => {
    root = new Client({ connectionString: dbUrl });
    contender = new Client({ connectionString: dbUrl });
    await Promise.all([root.connect(), contender.connect()]);
    const columns = await root.query<{ exists: boolean }>("select exists (select 1 from information_schema.columns where table_schema='public' and table_name='dialpad_org_connections' and column_name='recording_ingest_endpoint') as exists");
    if (!columns.rows[0]!.exists) throw new Error('recording_ingest_endpoint migration is absent from the local database');
  });

  afterAll(async () => {
    if (root) {
      await root.query('delete from public.dialpad_org_connections where id=$1', [connectionId]).catch(() => undefined);
      await root.query('delete from public.organizations where id=$1', [orgId]).catch(() => undefined);
    }
    await Promise.all([root?.end(), contender?.end()]);
  });

  async function waitForActivationLock(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await root.query<{ waiting: number }>(`select count(*)::int as waiting
        from pg_stat_activity
        where pid <> pg_backend_pid()
          and datname = current_database()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query ilike '%dialpad_org_connections set status%'`);
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('activation UPDATE never reached a confirmed row lock wait');
  }

  it('waits on the row lock, then refuses activation after the endpoint changes and rejects active configuration replay', async () => {
    orgId = randomUUID();
    connectionId = randomUUID();
    companyId = String(Math.floor(Math.random() * 9_000_000_000_000_000) + 1);
    const rootSql = sql(root);
    await rootSql('insert into public.organizations(id,name) values ($1,$2)', [orgId, `endpoint activation CAS ${orgId}`]);
    const ctiClientId = `client_${orgId.replaceAll('-', '')}`;
    await rootSql(`insert into public.dialpad_org_connections
      (id,org_id,status,cti_client_id,allowed_origins,webhook_secret_ref,webhook_secret_version,dialpad_company_id,directory_api_key_ref,recording_ingest_endpoint)
      values ($1,$2,'disabled',$3,array['https://dialpad.com']::text[],'env:DIALPAD_CTI_WEBHOOK_SECRET_CAS',1,$4,'env:DIALPAD_CTI_DIRECTORY_KEY_CAS',$5)`, [connectionId, orgId, ctiClientId, companyId, ENDPOINT]);

    const first = createConnectionDbPort(async (statement) => (await root.query(statement)).rows);
    const second = createConnectionDbPort(async (statement) => (await contender.query(statement)).rows);
    await first.inspectSchema();
    await second.inspectSchema();
    const expected = {
      orgId,
      ctiClientId,
      webhookSecretRef: 'env:DIALPAD_CTI_WEBHOOK_SECRET_CAS',
      companyId,
      directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_CAS',
      recordingIngestEndpoint: ENDPOINT,
    };

    await root.query('begin');
    await root.query('select id from public.dialpad_org_connections where id=$1 for update', [connectionId]);
    const activation = second.activateConnection(connectionId, expected);
    await waitForActivationLock();
    await root.query('update public.dialpad_org_connections set recording_ingest_endpoint=$1 where id=$2', [OTHER_ENDPOINT, connectionId]);
    await root.query('commit');

    expect(await activation).toBe(0);
    expect((await contender.query('select status, recording_ingest_endpoint from public.dialpad_org_connections where id=$1', [connectionId])).rows[0]).toEqual({ status: 'disabled', recording_ingest_endpoint: OTHER_ENDPOINT });

    await rootSql("update public.dialpad_org_connections set status='active' where id=$1", [connectionId]);
    expect(await second.configureRecordingEndpoint({ orgId, connectionId, companyId, expectedPreviousEndpoint: OTHER_ENDPOINT, proposedEndpoint: OTHER_ENDPOINT })).toBeNull();
    expect((await contender.query('select status, recording_ingest_endpoint from public.dialpad_org_connections where id=$1', [connectionId])).rows[0]).toEqual({ status: 'active', recording_ingest_endpoint: OTHER_ENDPOINT });
  });
});
