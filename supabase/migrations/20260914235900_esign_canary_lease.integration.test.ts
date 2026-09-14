import { createHash, randomUUID } from "node:crypto";

import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import {
  ESIGN_TEST_API_KEY,
  ESIGN_TEST_CLIENT_ID,
  ESIGN_TEST_ENCRYPTION_KEY,
  ESIGN_TEST_PROVIDER_ACCOUNT_ID,
  esignRequestFixture,
  esignTemplateFixture,
} from "@tests/integration/fixtures/esign";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
let pg: Client;
let first: Client;
let second: Client;
let ownerId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return url;
}

async function setServiceRole(client: Client): Promise<void> {
  await client.query("set role service_role");
  await client.query(
    "select set_config('request.jwt.claim.role', 'service_role', false)",
  );
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ message: expect.stringMatching(pattern) });
}

async function connectIntegration(orgId: string): Promise<void> {
  await setServiceRole(pg);
  await pg.query(
    `select public.upsert_org_esign_integration(
       $1, $2, right($2, 4), $3, $4, $5, $6, $7
     )`,
    [
      orgId,
      ESIGN_TEST_API_KEY,
      ESIGN_TEST_CLIENT_ID,
      ESIGN_TEST_PROVIDER_ACCOUNT_ID,
      createHash("sha256").update(randomUUID()).digest("hex"),
      ownerId,
      ESIGN_TEST_ENCRYPTION_KEY,
    ],
  );
  await pg.query(
    "update public.org_esign_integrations set callback_verified_at = now() where org_id = $1",
    [orgId],
  );
}

async function seedDispatchRequest(): Promise<string> {
  const contactId = randomUUID();
  const propertyId = randomUUID();
  await pg.query(
    "insert into public.contacts (id, org_id, first_name, last_name, email) values ($1,$2,'Canary','Owned','owned@example.invalid')",
    [contactId, TEST_ORG_B_ID],
  );
  await pg.query(
    "insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4)",
    [propertyId, TEST_ORG_B_ID, `Canary ${propertyId}`, contactId],
  );
  const template = esignTemplateFixture({ orgId: TEST_ORG_B_ID, userId: ownerId });
  await pg.query(
    `insert into public.esign_template_staging_sources (
       id,org_id,storage_path,source_filename,source_size_bytes,
       content_type,source_sha256,created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [template.staging_source_id, template.org_id, template.staging_path,
      template.source_filename, template.source_size_bytes,
      template.source_content_type, template.source_sha256, ownerId],
  );
  await pg.query(
    `insert into public.esign_templates (
       id,org_id,name,document_type,seller_role,signer_roles,
       merge_field_names,sign_template_id,provider_account_id,staging_source_id,source_filename,
       source_size_bytes,source_content_type,source_sha256,staging_path,
       finalized_at,lifecycle_state,created_by,updated_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
    [template.id,template.org_id,template.name,template.document_type,
      template.seller_role,JSON.stringify(template.signer_roles),
      template.merge_field_names,template.sign_template_id,
      ESIGN_TEST_PROVIDER_ACCOUNT_ID,
      template.staging_source_id,template.source_filename,
      template.source_size_bytes,template.source_content_type,
      template.source_sha256,template.staging_path,template.finalized_at,
      template.lifecycle_state,ownerId],
  );
  const request = esignRequestFixture({
    orgId: TEST_ORG_B_ID, propertyId, templateId: template.id, userId: ownerId,
  });
  await pg.query(
    `insert into public.esign_requests (
       id,org_id,property_id,template_id,signer_snapshot,
       merge_value_snapshot,send_intent_id,payload_hash,created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [request.id,request.org_id,request.property_id,request.template_id,
      JSON.stringify(request.signer_snapshot),
      JSON.stringify(request.merge_value_snapshot),request.send_intent_id,
      request.payload_hash,ownerId],
  );
  return request.id;
}

async function startCanaryLease(
  orgId: string,
  actorId: string,
  runId: string,
  expiresAt: string,
): Promise<{ run_id: string; lease_id: string; lease_token: string }> {
  const start = await pg.query<{
    run_id: string;
    lease_id: string;
    lease_token: string;
  }>(
    `select * from public.start_esign_canary_lease($1,$2,$3,$4)`,
    [orgId, actorId, runId, expiresAt],
  );
  return start.rows[0];
}

async function restoreCanaryLease(
  orgId: string,
  actorId: string,
  runId: string,
  leaseToken: string,
): Promise<{ outcome: string; lease_id: string }> {
  const result = await pg.query<{ outcome: string; lease_id: string }>(
    `select * from public.restore_esign_canary_lease($1,$2,$3,$4::uuid)`,
    [orgId, actorId, runId, leaseToken],
  );
  return result.rows[0];
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);

  const owner = await createOrgUser(serviceClient, {
    orgId: TEST_ORG_B_ID,
    email: `esign-canary-owner-${crypto.randomUUID()}@example.com`,
    role: "owner",
  });
  ownerId = owner.userId;

  pg = new Client({ connectionString: testDbUrl() });
  first = new Client({ connectionString: testDbUrl() });
  second = new Client({ connectionString: testDbUrl() });
  await Promise.all([pg.connect(), first.connect(), second.connect()]);

  await Promise.all([setServiceRole(pg), setServiceRole(first), setServiceRole(second)]);
}, 30_000);

beforeEach(async () => {
  await pg.query("delete from public.org_esign_canary_leases where org_id = $1", [TEST_ORG_B_ID]);
  await pg.query("delete from public.org_esign_integrations where org_id = $1", [TEST_ORG_B_ID]);
});

afterEach(async () => {
  await pg.query("delete from public.esign_requests where org_id = $1", [TEST_ORG_B_ID]);
  await pg.query("delete from public.esign_templates where org_id = $1", [TEST_ORG_B_ID]);
  await pg.query("delete from public.esign_template_staging_sources where org_id = $1", [TEST_ORG_B_ID]);
  await pg.query("delete from public.properties where org_id = $1 and address like 'Canary %'", [TEST_ORG_B_ID]);
  await pg.query("delete from public.contacts where org_id = $1 and email = 'owned@example.invalid'", [TEST_ORG_B_ID]);
  await pg.query("delete from public.org_esign_canary_leases where org_id = $1", [TEST_ORG_B_ID]);
  await pg.query("delete from public.org_esign_integrations where org_id = $1", [TEST_ORG_B_ID]);
});

afterAll(async () => {
  if (pg) {
    await pg.end();
  }
  if (first) await first.end();
  if (second) await second.end();
  if (ownerId) await serviceClient.auth.admin.deleteUser(ownerId);
  await resetTenantTables(serviceClient);
});

describe("Migration 20260914000000 — eSign canary lease", () => {
  it("allows only a request created within a healthy canary lease", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const lease = await startCanaryLease(
      TEST_ORG_B_ID, ownerId, randomUUID(),
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    );
    const requestId = await seedDispatchRequest();
    const allowed = await pg.query<{ allowed: boolean }>(
      "select public.allow_esign_canary_provider_dispatch($1,$2) as allowed",
      [TEST_ORG_B_ID, requestId],
    );
    expect(allowed.rows[0]?.allowed).toBe(true);
    const unrelated = await pg.query<{ allowed: boolean }>(
      "select public.allow_esign_canary_provider_dispatch($1,$2) as allowed",
      [TEST_ORG_B_ID, randomUUID()],
    );
    expect(unrelated.rows[0]?.allowed).toBe(false);
    await pg.query(
      "update public.org_esign_canary_leases set expires_at = now() + interval '30 seconds' where run_id = $1",
      [lease.run_id],
    );
    const tooLate = await pg.query<{ allowed: boolean }>(
      "select public.allow_esign_canary_provider_dispatch($1,$2) as allowed",
      [TEST_ORG_B_ID, requestId],
    );
    expect(tooLate.rows[0]?.allowed).toBe(false);
  });

  it("prevents concurrent canary starts for one org", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    await setServiceRole(first);
    await setServiceRole(second);

    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const [firstStart, secondStart] = await Promise.allSettled([
      first.query(
        `select * from public.start_esign_canary_lease($1,$2,$3,$4::timestamptz)`,
        [TEST_ORG_B_ID, ownerId, runA, expiresAt],
      ),
      second.query(
        `select * from public.start_esign_canary_lease($1,$2,$3,$4::timestamptz)`,
        [TEST_ORG_B_ID, ownerId, runB, expiresAt],
      ),
    ]);

    const ok = [firstStart, secondStart].filter(
      (entry) => entry.status === "fulfilled",
    );
    const fail = [firstStart, secondStart].filter(
      (entry) => entry.status === "rejected",
    );
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);
  });

  it("fails canary start when the active lease has expired and exposes watchdog rows", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const runId = crypto.randomUUID();
    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      runId,
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    );

    await pg.query(
      "update public.org_esign_canary_leases set started_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where run_id = $1",
      [lease.run_id],
    );

    await expectDatabaseError(
      () =>
        startCanaryLease(
          TEST_ORG_B_ID,
          ownerId,
          crypto.randomUUID(),
          new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        ),
      /expired/i,
    );

    const expiredRows = await pg.query<{
      run_id: string;
      actor_id: string;
    }>("select * from public.list_expired_esign_canary_leases($1)", [TEST_ORG_B_ID]);
    expect(expiredRows.rows[0]?.run_id).toBe(lease.run_id);
  });

  it("fences new requests after expiry and restores through the held token", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      crypto.randomUUID(),
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    );
    await pg.query(
      "update public.org_esign_canary_leases set started_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where run_id = $1",
      [lease.run_id],
    );

    await expectDatabaseError(
      () => pg.query("insert into public.esign_requests (org_id) values ($1)", [TEST_ORG_B_ID]),
      /expired eSign canary lease blocks new contract requests/i,
    );
    const dispatch = await pg.query<{ allowed: boolean }>(
      "select public.allow_esign_canary_provider_dispatch($1,$2) as allowed",
      [TEST_ORG_B_ID, crypto.randomUUID()],
    );
    expect(dispatch.rows[0]?.allowed).toBe(false);
    const autoFenced = await pg.query<{ sending_enabled: boolean; status: string }>(
      `select i.sending_enabled, l.status
       from public.org_esign_integrations i
       join public.org_esign_canary_leases l on l.org_id = i.org_id
       where l.run_id = $1`,
      [lease.run_id],
    );
    expect(autoFenced.rows[0]).toMatchObject({ sending_enabled: false, status: "expired" });
    const fence = await pg.query<{ result: string }>(
      "select public.fence_expired_esign_canary_lease($1,$2) as result",
      [TEST_ORG_B_ID, lease.run_id],
    );
    expect(fence.rows[0]?.result).toBe("fenced");
    const fenced = await pg.query<{ sending_enabled: boolean; status: string }>(
      `select i.sending_enabled, l.status
       from public.org_esign_integrations i
       join public.org_esign_canary_leases l on l.org_id = i.org_id
       where l.run_id = $1`,
      [lease.run_id],
    );
    expect(fenced.rows[0]).toMatchObject({ sending_enabled: false, status: "expired" });

    const restored = await restoreCanaryLease(
      TEST_ORG_B_ID, ownerId, lease.run_id, lease.lease_token,
    );
    expect(restored.outcome).toBe("restored");
    const final = await pg.query<{ test_mode: boolean; sending_enabled: boolean; status: string }>(
      `select i.test_mode, i.sending_enabled, l.status
       from public.org_esign_integrations i
       join public.org_esign_canary_leases l on l.org_id = i.org_id
       where l.run_id = $1`,
      [lease.run_id],
    );
    expect(final.rows[0]).toMatchObject({ test_mode: true, sending_enabled: false, status: "restored" });
  });

  it("requires a valid token to restore", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      crypto.randomUUID(),
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    );
    await expectDatabaseError(
      () =>
        restoreCanaryLease(
          TEST_ORG_B_ID,
          ownerId,
          lease.run_id,
          crypto.randomUUID(),
        ),
      /invalid/i,
    );
  });

  it("refuses the sales organization", async () => {
    const runId = crypto.randomUUID();
    await setServiceRole(pg);
    await expectDatabaseError(
      () =>
        startCanaryLease(
          BMH_ORG_ID,
          ownerId,
          runId,
          new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        ),
      /sales organization/i,
    );
  });

  it("reports conflict when state changed before restore", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      crypto.randomUUID(),
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    );
    await pg.query(
      "update public.org_esign_integrations set sending_enabled = false where org_id = $1",
      [TEST_ORG_B_ID],
    );
    await expectDatabaseError(
      () =>
        restoreCanaryLease(
          TEST_ORG_B_ID,
          ownerId,
          lease.run_id,
          lease.lease_token,
        ),
      /state has changed/i,
    );
  });

  it("restores captured original test/sending state with readback verification", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    await pg.query(
      "update public.org_esign_integrations set test_mode = false, sending_enabled = false where org_id = $1",
      [TEST_ORG_B_ID],
    );

    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      crypto.randomUUID(),
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    );

    const during = await pg.query<{
      test_mode: boolean;
      sending_enabled: boolean;
    }>("select test_mode, sending_enabled from public.org_esign_integrations where org_id=$1", [TEST_ORG_B_ID]);
    expect(during.rows[0]).toMatchObject({
      test_mode: true,
      sending_enabled: true,
    });

    const restored = await restoreCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      lease.run_id,
      lease.lease_token,
    );
    expect(restored.outcome).toBe("restored");

    const finalState = await pg.query<{
      test_mode: boolean;
      sending_enabled: boolean;
      status: string;
    }>(
      `select i.test_mode, i.sending_enabled, l.status
       from public.org_esign_integrations i
       join public.org_esign_canary_leases l on l.org_id = i.org_id and l.run_id = $2
       where i.org_id = $1`,
      [TEST_ORG_B_ID, lease.run_id],
    );
    expect(finalState.rows[0]).toMatchObject({
      test_mode: false,
      sending_enabled: false,
      status: "restored",
    });
  });

  it("never stores the plain lease token", async () => {
    await connectIntegration(TEST_ORG_B_ID);
    const lease = await startCanaryLease(
      TEST_ORG_B_ID,
      ownerId,
      crypto.randomUUID(),
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    );
    const row = await pg.query<{
      lease_token_hash: string;
    }>(
      `select lease_token_hash from public.org_esign_canary_leases where id = $1`,
      [lease.lease_id],
    );
    expect(row.rows[0].lease_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.rows[0].lease_token_hash).not.toContain(lease.lease_token);
  });
});
