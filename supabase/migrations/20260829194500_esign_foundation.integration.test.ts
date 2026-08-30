import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  ESIGN_TEST_CALLBACK_HASH,
  ESIGN_TEST_CLIENT_ID,
  ESIGN_TEST_ENCRYPTION_KEY,
  esignRequestFixture,
  esignTemplateFixture,
} from "@tests/integration/fixtures/esign";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const migrationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");

let pg: Client;
let ownerId = "";
let memberId = "";
let outsiderId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return url;
}

async function setRequestRole(
  role: "service_role" | "authenticated",
  userId = "",
): Promise<void> {
  await pg.query(`set local role ${role}`);
  await pg.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
  await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

async function resetRequestRole(): Promise<void> {
  await pg.query("reset role");
  await pg.query("select set_config('request.jwt.claim.role', '', true)");
  await pg.query("select set_config('request.jwt.claim.sub', '', true)");
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await pg.query("savepoint expected_database_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await pg.query("rollback to savepoint expected_database_error");
  await pg.query("release savepoint expected_database_error");
  expect(caught).toMatchObject({ message: expect.stringMatching(pattern) });
}

async function seedProperty(orgId = BMH_ORG_ID): Promise<string> {
  await setRequestRole("service_role");
  const contactId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  await pg.query(
    `insert into public.contacts (id, org_id, first_name, last_name)
     values ($1, $2, 'eSign', $3)`,
    [contactId, orgId, `Fixture ${contactId.slice(0, 8)}`],
  );
  await pg.query(
    `insert into public.properties (
       id, org_id, address, state, status, homeowner_contact_id
     ) values ($1, $2, $3, 'MO', 'new_lead', $4)`,
    [propertyId, orgId, `eSign ${propertyId}`, contactId],
  );
  return propertyId;
}

async function seedTemplate(
  actorId = ownerId,
  orgId = BMH_ORG_ID,
): Promise<string> {
  const fixture = esignTemplateFixture({ orgId, userId: actorId });
  await setRequestRole("service_role");
  await pg.query(
    `insert into public.esign_templates (
       id, org_id, name, document_type, seller_role, signer_roles,
       merge_field_names, sign_template_id, source_filename, staging_path,
       finalized_at, created_by, updated_by
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12
     )`,
    [
      fixture.id,
      fixture.org_id,
      fixture.name,
      fixture.document_type,
      fixture.seller_role,
      fixture.signer_roles,
      fixture.merge_field_names,
      fixture.sign_template_id,
      fixture.source_filename,
      fixture.staging_path,
      fixture.finalized_at,
      fixture.created_by,
    ],
  );
  return fixture.id;
}

async function seedRequest(input: {
  propertyId: string;
  templateId: string;
  actorId?: string;
  id?: string;
  sendIntentId?: string;
  createdAt?: string;
}): Promise<string> {
  const fixture = esignRequestFixture({
    orgId: BMH_ORG_ID,
    propertyId: input.propertyId,
    templateId: input.templateId,
    userId: input.actorId ?? memberId,
    id: input.id,
    sendIntentId: input.sendIntentId,
  });
  await setRequestRole("service_role");
  await pg.query(
    `insert into public.esign_requests (
       id, org_id, property_id, template_id, signer_snapshot,
       merge_value_snapshot, send_intent_id, payload_hash, created_by,
       created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()))`,
    [
      fixture.id,
      fixture.org_id,
      fixture.property_id,
      fixture.template_id,
      JSON.stringify(fixture.signer_snapshot),
      JSON.stringify(fixture.merge_value_snapshot),
      fixture.send_intent_id,
      fixture.payload_hash,
      fixture.created_by,
      input.createdAt ?? null,
    ],
  );
  return fixture.id;
}

async function connectIntegration(): Promise<void> {
  await setRequestRole("service_role");
  await pg.query(
    `select public.upsert_org_esign_integration(
       $1, $2, right($2, 4), $3, $4, $5, $6
     )`,
    [
      BMH_ORG_ID,
      ESIGN_TEST_API_KEY,
      ESIGN_TEST_CLIENT_ID,
      ESIGN_TEST_CALLBACK_HASH,
      ownerId,
      ESIGN_TEST_ENCRYPTION_KEY,
    ],
  );
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
  const owner = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `esign-owner-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "owner",
  });
  const member = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `esign-member-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  const outsider = await createOrgUser(serviceClient, {
    orgId: TEST_ORG_B_ID,
    email: `esign-outsider-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  ownerId = owner.userId;
  memberId = member.userId;
  outsiderId = outsider.userId;

  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
  await pg.query(migrationSql);
});

beforeEach(async () => {
  await resetRequestRole();
  await pg.query("savepoint esign_case");
});

afterEach(async () => {
  await pg.query("rollback to savepoint esign_case");
  await pg.query("release savepoint esign_case");
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
  for (const id of [ownerId, memberId, outsiderId]) {
    if (id) await serviceClient.auth.admin.deleteUser(id);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 20260829194500 — eSign foundation", () => {
  it("encrypts API keys and exposes only a dedicated eSign callback consumer", async () => {
    await connectIntegration();
    const stored = await pg.query<{
      plaintext: boolean;
      consumer_type: string;
      callback_consumer_id: string;
    }>(
      `select
         integration.api_key_encrypted = convert_to($1, 'utf8') as plaintext,
         consumer.consumer_type,
         integration.callback_consumer_id
       from public.org_esign_integrations integration
       join public.webhook_consumers consumer
         on consumer.id = integration.callback_consumer_id`,
      [ESIGN_TEST_API_KEY],
    );
    expect(stored.rows[0]).toMatchObject({
      plaintext: false,
      consumer_type: "esign_provider",
    });

    const decrypted = await pg.query<{ api_key: string; test_mode: boolean }>(
      "select api_key, test_mode from public.get_org_esign_credentials($1, $2)",
      [BMH_ORG_ID, ESIGN_TEST_ENCRYPTION_KEY],
    );
    expect(decrypted.rows).toEqual([
      { api_key: ESIGN_TEST_API_KEY, test_mode: true },
    ]);
  });

  it("lets active members send and view but keeps credentials and templates owner-only", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();

    await setRequestRole("authenticated", memberId);
    const visible = await pg.query(
      "select api_key_last_four from public.org_esign_integrations",
    );
    expect(visible.rows).toHaveLength(1);
    await expectDatabaseError(
      () => pg.query("select api_key_encrypted from public.org_esign_integrations"),
      /permission denied/i,
    );
    const blockedTemplate = esignTemplateFixture({
      orgId: BMH_ORG_ID,
      userId: memberId,
    });
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_templates (
             id, org_id, name, document_type, seller_role, signer_roles,
             merge_field_names, sign_template_id, source_filename,
             staging_path, finalized_at, created_by, updated_by
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
          [
            blockedTemplate.id,
            blockedTemplate.org_id,
            blockedTemplate.name,
            blockedTemplate.document_type,
            blockedTemplate.seller_role,
            blockedTemplate.signer_roles,
            blockedTemplate.merge_field_names,
            blockedTemplate.sign_template_id,
            blockedTemplate.source_filename,
            blockedTemplate.staging_path,
            blockedTemplate.finalized_at,
            memberId,
          ],
        ),
      /row-level security/i,
    );

    await resetRequestRole();
    const templateId = await seedTemplate();
    const request = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId,
      templateId,
      userId: memberId,
    });
    await setRequestRole("authenticated", memberId);
    await pg.query(
      `insert into public.esign_requests (
         id, org_id, property_id, template_id, signer_snapshot,
         merge_value_snapshot, send_intent_id, payload_hash, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        request.id,
        request.org_id,
        request.property_id,
        request.template_id,
        JSON.stringify(request.signer_snapshot),
        JSON.stringify(request.merge_value_snapshot),
        request.send_intent_id,
        request.payload_hash,
        memberId,
      ],
    );
    expect(
      (await pg.query("select id from public.esign_requests")).rows,
    ).toEqual([{ id: request.id }]);

    await setRequestRole("authenticated", outsiderId);
    expect(
      (await pg.query("select id from public.esign_requests")).rows,
    ).toEqual([]);
  });

  it("keeps request snapshots and latest-per-property ordering immutable", async () => {
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const createdAt = "2026-08-29T12:00:00.000Z";
    const firstId = "00000000-0000-0000-0000-000000000101";
    const secondId = "00000000-0000-0000-0000-000000000102";
    await seedRequest({ propertyId, templateId, id: firstId, createdAt });
    await seedRequest({ propertyId, templateId, id: secondId, createdAt });

    await setRequestRole("service_role");
    await pg.query(
      "update public.esign_requests set updated_at = now() + interval '1 day' where id = $1",
      [firstId],
    );
    const latest = await pg.query<{ id: string }>(
      `select id from public.esign_requests
       where org_id = $1 and property_id = $2
       order by created_at desc, id desc limit 1`,
      [BMH_ORG_ID, propertyId],
    );
    expect(latest.rows[0].id).toBe(secondId);
    await expectDatabaseError(
      () =>
        pg.query(
          "update public.esign_requests set created_at = created_at + interval '1 second' where id = $1",
          [firstId],
        ),
      /immutable/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "update public.esign_requests set merge_value_snapshot = '{}' where id = $1",
          [firstId],
        ),
      /immutable/i,
    );
  });

  it("blocks credential deletion until callbacks and signed PDF capture are complete", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    await setRequestRole("service_role");
    await expectDatabaseError(
      () => pg.query("select public.delete_org_esign_integration($1)", [BMH_ORG_ID]),
      /Finish active signatures/i,
    );

    await pg.query(
      `update public.esign_requests
       set status = 'signed', delivery_state = 'sent', completed_at = now()
       where id = $1`,
      [requestId],
    );
    await expectDatabaseError(
      () => pg.query("select public.delete_org_esign_integration($1)", [BMH_ORG_ID]),
      /save signed PDFs/i,
    );
    await pg.query(
      "update public.esign_requests set signed_pdf_path = $2 where id = $1",
      [requestId, `${BMH_ORG_ID}/opaque.pdf`],
    );
    await pg.query("select public.delete_org_esign_integration($1)", [BMH_ORG_ID]);
    expect(
      (
        await pg.query(
          "select count(*)::int as count from public.org_esign_integrations where org_id = $1",
          [BMH_ORG_ID],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pg.query(
          "select enabled, revoked_at is not null as revoked from public.webhook_consumers where consumer_type = 'esign_provider'",
        )
      ).rows[0],
    ).toEqual({ enabled: false, revoked: true });
  });

  it("deduplicates callback receipts by composite fingerprint, not event_hash", async () => {
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const consumerId = consumer.rows[0].id;
    await pg.query(
      `insert into public.esign_webhook_receipts (
         org_id, callback_consumer_id, event_hash, event_fingerprint,
         event_type, sign_request_id, related_signature_id
       ) values
       ($1,$2,'same-hmac',$3,'signature_request_viewed','request-a','signature-a'),
       ($1,$2,'same-hmac',$4,'signature_request_viewed','request-b','signature-b')`,
      [BMH_ORG_ID, consumerId, "1".repeat(64), "2".repeat(64)],
    );
    expect(
      (
        await pg.query(
          "select count(*)::int as count from public.esign_webhook_receipts where event_hash = 'same-hmac'",
        )
      ).rows[0].count,
    ).toBe(2);
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_webhook_receipts (
             org_id, callback_consumer_id, event_hash, event_fingerprint, event_type
           ) values ($1,$2,'different-hmac',$3,'signature_request_viewed')`,
          [BMH_ORG_ID, consumerId, "1".repeat(64)],
        ),
      /unique constraint/i,
    );
  });

  it("keeps draft templates hidden and both storage buckets private", async () => {
    const definition = await pg.query<{ predicate: string }>(
      `select pg_get_expr(indexprs, indrelid) as predicate
       from pg_index where indexrelid = 'public.idx_esign_templates_active'::regclass`,
    );
    const indexDef = (
      await pg.query<{ definition: string }>(
        "select pg_get_indexdef('public.idx_esign_templates_active'::regclass) as definition",
      )
    ).rows[0].definition;
    expect(indexDef).toMatch(/deleted_at IS NULL/i);
    expect(indexDef).toMatch(/finalized_at IS NOT NULL/i);
    const buckets = await pg.query<{ id: string; public: boolean }>(
      "select id, public from storage.buckets where id in ('esign-staging','lead-files') order by id",
    );
    expect(buckets.rows).toEqual([
      { id: "esign-staging", public: false },
      { id: "lead-files", public: false },
    ]);
    expect(definition.rows).toHaveLength(1);
  });

  it("moves eSign dependents when duplicate properties merge", async () => {
    const keeperId = await seedProperty();
    const loserId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId: loserId, templateId });
    await setRequestRole("service_role");
    await pg.query(
      `insert into public.lead_files (
         org_id, property_id, source_request_id, file_name, storage_path
       ) values ($1, $2, $3, 'signed.pdf', $4)`,
      [BMH_ORG_ID, loserId, requestId, `${BMH_ORG_ID}/opaque-signed.pdf`],
    );

    await setRequestRole("authenticated", ownerId);
    await pg.query("select public.merge_duplicate_properties($1, $2)", [
      keeperId,
      loserId,
    ]);
    expect(
      (
        await pg.query(
          "select property_id from public.esign_requests where id = $1",
          [requestId],
        )
      ).rows[0].property_id,
    ).toBe(keeperId);
    expect(
      (
        await pg.query(
          "select property_id from public.lead_files where source_request_id = $1",
          [requestId],
        )
      ).rows[0].property_id,
    ).toBe(keeperId);
    expect(
      (
        await pg.query("select count(*)::int as count from public.properties where id = $1", [
          loserId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("clears all eSign tenant rows through the shared reset helper", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    await seedRequest({ propertyId, templateId });
    await setRequestRole("service_role");
    await pg.query("select public.reset_tenant_tables()");
    const counts = await pg.query<{ table_name: string; count: number }>(
      `select 'integrations' as table_name, count(*)::int as count
         from public.org_esign_integrations
       union all
       select 'templates', count(*)::int from public.esign_templates
       union all
       select 'requests', count(*)::int from public.esign_requests
       union all
       select 'receipts', count(*)::int from public.esign_webhook_receipts`,
    );
    expect(counts.rows).toEqual([
      { table_name: "integrations", count: 0 },
      { table_name: "templates", count: 0 },
      { table_name: "requests", count: 0 },
      { table_name: "receipts", count: 0 },
    ]);
  });

  it("defines reset and merge helpers with all eSign dependents", async () => {
    const functions = await pg.query<{ name: string; definition: string }>(
      `select proname as name, pg_get_functiondef(oid) as definition
       from pg_proc
       where oid in (
         'public.reset_tenant_tables()'::regprocedure,
         'public.merge_duplicate_properties(uuid,uuid)'::regprocedure
       )`,
    );
    const reset = functions.rows.find((row) => row.name === "reset_tenant_tables");
    const merge = functions.rows.find(
      (row) => row.name === "merge_duplicate_properties",
    );
    expect(reset?.definition).toMatch(/esign_webhook_receipts/);
    expect(reset?.definition).toMatch(/org_esign_integrations/);
    expect(merge?.definition).toMatch(/update public\.esign_requests/i);
    expect(merge?.definition).toMatch(/update public\.lead_files/i);
  });
});
