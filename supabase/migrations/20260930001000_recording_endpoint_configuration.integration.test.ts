import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url';
import { createConnectionDbPort } from '../../src/lib/dialpad-cti/provisioning-adapters';
import { parseRecordingEndpointInputs } from '../../src/lib/dialpad-cti/recording-endpoint';

const localDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
const ENDPOINT = 'wss://receiver.example.up.railway.app/dialpad-browser-ingest';
const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);

const sql = (client: Client) => async (text: string, values: unknown[] = []) => client.query(text, values);

describe('recording endpoint configuration local CAS', () => {
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

  it('serializes disabled endpoint CAS and refuses an active replay', async () => {
    orgId = randomUUID();
    connectionId = randomUUID();
    companyId = String(Math.floor(Math.random() * 9_000_000_000_000_000) + 1);
    const rootSql = sql(root);
    await rootSql('insert into public.organizations(id,name) values ($1,$2)', [orgId, `endpoint CAS ${orgId}`]);
    await rootSql(`insert into public.dialpad_org_connections
      (id,org_id,status,cti_client_id,allowed_origins,webhook_secret_ref,webhook_secret_version,dialpad_company_id,directory_api_key_ref,recording_ingest_endpoint)
      values ($1,$2,'disabled',$3,array['https://dialpad.com']::text[],'env:DIALPAD_CTI_WEBHOOK_SECRET_CAS',1,$4,'env:DIALPAD_CTI_DIRECTORY_KEY_CAS',null)`, [connectionId, orgId, `client_${orgId.replaceAll('-', '')}`, companyId]);

    parseRecordingEndpointInputs({ orgId, connectionId, companyId, endpoint: ENDPOINT, verifiedHostname: 'receiver.example.up.railway.app', expectedPreviousEndpoint: null });
    const first = createConnectionDbPort(async (statement) => (await root.query(statement)).rows);
    const second = createConnectionDbPort(async (statement) => (await contender.query(statement)).rows);
    await first.inspectSchema();
    await second.inspectSchema();
    await root.query('begin');
    const update = { orgId, connectionId, companyId, expectedPreviousEndpoint: null, proposedEndpoint: ENDPOINT };
    const firstWrite = await first.configureRecordingEndpoint(update);
    expect(firstWrite).toMatchObject({ id: connectionId, status: 'disabled', recordingIngestEndpoint: ENDPOINT });
    const contenderWrite = second.configureRecordingEndpoint(update);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await root.query('commit');
    expect(await contenderWrite).toBeNull();
    expect((await contender.query('select status, recording_ingest_endpoint from public.dialpad_org_connections where id=$1', [connectionId])).rows[0]).toEqual({ status: 'disabled', recording_ingest_endpoint: ENDPOINT });

    await rootSql("update public.dialpad_org_connections set status='active' where id=$1", [connectionId]);
    expect(await second.configureRecordingEndpoint({ ...update, expectedPreviousEndpoint: ENDPOINT })).toBeNull();
    expect((await contender.query('select status, recording_ingest_endpoint from public.dialpad_org_connections where id=$1', [connectionId])).rows[0]).toEqual({ status: 'active', recording_ingest_endpoint: ENDPOINT });
  });
});
