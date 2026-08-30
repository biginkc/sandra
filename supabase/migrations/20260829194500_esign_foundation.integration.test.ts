import { readFileSync } from "node:fs";

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
  await pg.query("select set_config('request.jwt.claim.role', $1, true)", [
    role,
  ]);
  await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [
    userId,
  ]);
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

async function seedProperty(
  orgId = BMH_ORG_ID,
  email = `seller-${crypto.randomUUID()}@example.com`,
): Promise<string> {
  await setRequestRole("service_role");
  const contactId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  await pg.query(
    `insert into public.contacts (id, org_id, first_name, last_name, email)
     values ($1, $2, 'eSign', $3, $4)`,
    [contactId, orgId, `Fixture ${contactId.slice(0, 8)}`, email],
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
    `insert into public.esign_template_staging_sources (
       id, org_id, storage_path, source_filename, source_size_bytes,
       content_type, source_sha256, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      fixture.staging_source_id,
      fixture.org_id,
      fixture.staging_path,
      fixture.source_filename,
      fixture.source_size_bytes,
      fixture.source_content_type,
      fixture.source_sha256,
      fixture.created_by,
    ],
  );
  await pg.query(
    `insert into public.esign_templates (
       id, org_id, name, document_type, seller_role, signer_roles,
       merge_field_names, sign_template_id, staging_source_id, source_filename,
       source_size_bytes, source_content_type, source_sha256, staging_path,
       finalized_at, lifecycle_state, created_by, updated_by
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17
     )`,
    [
      fixture.id,
      fixture.org_id,
      fixture.name,
      fixture.document_type,
      fixture.seller_role,
      JSON.stringify(fixture.signer_roles),
      fixture.merge_field_names,
      fixture.sign_template_id,
      fixture.staging_source_id,
      fixture.source_filename,
      fixture.source_size_bytes,
      fixture.source_content_type,
      fixture.source_sha256,
      fixture.staging_path,
      fixture.finalized_at,
      fixture.lifecycle_state,
      fixture.created_by,
    ],
  );
  return fixture.id;
}

async function seedVerifiedTemplateSource(input: {
  orgId?: string;
  actorId?: string;
  filename?: string;
} = {}): Promise<{ id: string; path: string }> {
  const orgId = input.orgId ?? BMH_ORG_ID;
  const actorId = input.actorId ?? ownerId;
  const id = crypto.randomUUID();
  const path = `${orgId}/${id}.pdf`;
  await setRequestRole("service_role");
  await pg.query(
    `insert into storage.objects (bucket_id, name, metadata)
     values ('esign-staging',$1,'{"mimetype":"application/pdf","size":1024}')`,
    [path],
  );
  await pg.query(
    `select public.record_verified_esign_template_source(
       $1,$2,$3,$4,1024,'application/pdf',$5,$6
     )`,
    [
      orgId,
      id,
      path,
      input.filename ?? "edit-revision.pdf",
      "f".repeat(64),
      actorId,
    ],
  );
  return { id, path };
}

async function seedTemplateEditRevision(input: {
  sourceTemplateId: string;
  providerTemplateId: string;
  orgId?: string;
  actorId?: string;
}): Promise<{ id: string; sourceId: string; sourcePath: string }> {
  const orgId = input.orgId ?? BMH_ORG_ID;
  const actorId = input.actorId ?? ownerId;
  const source = await seedVerifiedTemplateSource({ orgId, actorId });
  const revision = await pg.query<{ id: string }>(
    `select public.create_esign_template_edit_revision(
       $1,$2,$3,$4
     ) as id`,
    [orgId, input.sourceTemplateId, source.id, actorId],
  );
  const id = revision.rows[0].id;
  await pg.query(
    "select public.attach_esign_template_provider_id($1,$2,$3,$4)",
    [orgId, id, input.providerTemplateId, actorId],
  );
  return { id, sourceId: source.id, sourcePath: source.path };
}

async function publishTemplateEditRevision(input: {
  sourceTemplateId: string;
  revisionTemplateId: string;
  sourceProviderTemplateId: string;
  revisionProviderTemplateId: string;
  orgId?: string;
  actorId?: string;
  sellerRole?: string;
  signerRoles?: readonly { name: string; order: number }[];
}): Promise<string> {
  const result = await pg.query<{ result: string }>(
    `select public.publish_esign_template_edit_revision(
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9
     ) as result`,
    [
      input.orgId ?? BMH_ORG_ID,
      input.sourceTemplateId,
      input.revisionTemplateId,
      input.sourceProviderTemplateId,
      input.revisionProviderTemplateId,
      input.sellerRole ?? "Seller",
      JSON.stringify(
        input.signerRoles ?? [{ name: "Seller", order: 0 }],
      ),
      [
        "seller_name",
        "property_address",
        "offer_price",
        "closing_date",
        "earnest_money",
      ],
      input.actorId ?? ownerId,
    ],
  );
  return result.rows[0].result;
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

function safeWebhookEventData(input: {
  eventType: string;
  eventTime?: string;
  signRequestId?: string | null;
  relatedSignatureId?: string | null;
  reportedForAppId?: string | null;
}) {
  return {
    event_time: input.eventTime ?? "1788033600",
    event_type: input.eventType,
    sign_request_id: input.signRequestId ?? null,
    related_signature_id: input.relatedSignatureId ?? null,
    reported_for_app_id:
      input.reportedForAppId === undefined
        ? ESIGN_TEST_CLIENT_ID
        : input.reportedForAppId,
  };
}

async function claimWebhookReceipt(input: {
  consumerId: string;
  eventType: string;
  signRequestId?: string | null;
  relatedSignatureId?: string | null;
  eventAt?: string;
  eventHash?: string;
  fingerprint?: string;
  payloadHash?: string;
  leaseId?: string;
  reportedForAppId?: string | null;
}) {
  const eventAt = input.eventAt ?? "2026-08-29T20:00:00.000Z";
  const signRequestId = input.signRequestId ?? null;
  const relatedSignatureId = input.relatedSignatureId ?? null;
  const leaseId = input.leaseId ?? crypto.randomUUID();
  const safeEventData = safeWebhookEventData({
    eventTime: String(Math.floor(new Date(eventAt).getTime() / 1000)),
    eventType: input.eventType,
    signRequestId,
    relatedSignatureId,
    reportedForAppId: input.reportedForAppId,
  });
  const result = await pg.query<{
    outcome: string;
    receipt_id: string;
    lease_id: string | null;
  }>(
    `select * from public.claim_esign_webhook_receipt(
       $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb,now(),$11,300
     )`,
    [
      BMH_ORG_ID,
      input.consumerId,
      input.eventHash ?? "a".repeat(64),
      input.fingerprint ?? crypto.randomUUID().replaceAll("-", "").repeat(2),
      input.payloadHash ?? crypto.randomUUID().replaceAll("-", "").repeat(2),
      input.eventType,
      signRequestId,
      relatedSignatureId,
      eventAt,
      JSON.stringify(safeEventData),
      leaseId,
    ],
  );
  return result.rows[0];
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
    role: "owner",
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
    await expectDatabaseError(() => connectIntegration(), /already connected/i);
    await expectDatabaseError(
      () =>
        pg.query(
          `select public.upsert_org_esign_integration(
             $1,$2,right($2,4),$3,$4,$5,$6
           )`,
          [
            BMH_ORG_ID,
            ESIGN_TEST_API_KEY,
            ESIGN_TEST_CLIENT_ID,
            ESIGN_TEST_CALLBACK_HASH,
            memberId,
            ESIGN_TEST_ENCRYPTION_KEY,
          ],
        ),
      /owner/i,
    );
    await expectDatabaseError(
      () =>
        pg.query("select public.delete_org_esign_integration($1,$2)", [
          BMH_ORG_ID,
          memberId,
        ]),
      /owner/i,
    );
  });

  it("owner-gates sending atomically and supports a safe disconnect-reconnect cycle", async () => {
    await connectIntegration();
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.set_org_esign_sending_enabled($1,$2,true)",
          [BMH_ORG_ID, memberId],
        ),
      /owner/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.set_org_esign_sending_enabled($1,$2,true)",
          [BMH_ORG_ID, ownerId],
        ),
      /verify.*callback/i,
    );
    await pg.query(
      `update public.org_esign_integrations
       set callback_verified_at = now() where org_id = $1`,
      [BMH_ORG_ID],
    );
    await pg.query(
      "select public.set_org_esign_sending_enabled($1,$2,true)",
      [BMH_ORG_ID, ownerId],
    );
    expect(
      (
        await pg.query<{ sending_enabled: boolean }>(
          "select sending_enabled from public.org_esign_integrations where org_id = $1",
          [BMH_ORG_ID],
        )
      ).rows[0].sending_enabled,
    ).toBe(true);
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.set_org_esign_sending_enabled($1,$2,true)",
          [TEST_ORG_B_ID, outsiderId],
        ),
      /not connected/i,
    );

    const firstConsumer = (
      await pg.query<{ callback_consumer_id: string }>(
        "select callback_consumer_id from public.org_esign_integrations where org_id = $1",
        [BMH_ORG_ID],
      )
    ).rows[0].callback_consumer_id;
    const processedAcrossReconnect = {
      consumerId: firstConsumer,
      eventType: "account_callback_test",
      signRequestId: null,
      relatedSignatureId: null,
      reportedForAppId: ESIGN_TEST_CLIENT_ID,
      eventAt: "2026-08-29T19:30:00.000Z",
      eventHash: "7".repeat(64),
      fingerprint: "8".repeat(64),
      payloadHash: "9".repeat(64),
    };
    const processedClaim = await claimWebhookReceipt(processedAcrossReconnect);
    await pg.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [processedClaim.receipt_id, processedClaim.lease_id],
    );
    await pg.query("select public.delete_org_esign_integration($1,$2)", [
      BMH_ORG_ID,
      ownerId,
    ]);
    await connectIntegration();
    const reconnected = (
      await pg.query<{
        callback_consumer_id: string;
        enabled: boolean;
        revoked_at: Date | null;
      }>(
        `select integration.callback_consumer_id, consumer.enabled,
           consumer.revoked_at
         from public.org_esign_integrations integration
         join public.webhook_consumers consumer
           on consumer.id = integration.callback_consumer_id
         where integration.org_id = $1`,
        [BMH_ORG_ID],
      )
    ).rows[0];
    expect(reconnected).toMatchObject({ enabled: true, revoked_at: null });
    expect(reconnected.callback_consumer_id).not.toBe(firstConsumer);
    expect(
      await claimWebhookReceipt({
        ...processedAcrossReconnect,
        consumerId: reconnected.callback_consumer_id,
      }),
    ).toEqual({
      outcome: "already_processed",
      receipt_id: processedClaim.receipt_id,
      lease_id: null,
    });
    expect(
      (
        await pg.query<{ enabled: boolean; revoked_at: Date | null }>(
          "select enabled, revoked_at from public.webhook_consumers where id = $1",
          [firstConsumer],
        )
      ).rows[0],
    ).toMatchObject({ enabled: false, revoked_at: expect.any(Date) });
    await expectDatabaseError(
      () =>
        claimWebhookReceipt({
          consumerId: firstConsumer,
          eventType: "account_callback_test",
          signRequestId: null,
          relatedSignatureId: null,
          reportedForAppId: ESIGN_TEST_CLIENT_ID,
        }),
      /callback consumer/i,
    );
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
      () =>
        pg.query("select api_key_encrypted from public.org_esign_integrations"),
      /permission denied/i,
    );
    await expectDatabaseError(
      () => pg.query("select * from public.esign_template_staging_sources"),
      /permission denied/i,
    );
    await expectDatabaseError(
      () =>
        pg.query("insert into public.esign_templates (id) values ($1)", [
          crypto.randomUUID(),
        ]),
      /permission denied/i,
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
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_requests (
             id, org_id, property_id, template_id, signer_snapshot,
             merge_value_snapshot, send_intent_id, payload_hash, created_by,
             status, delivery_state, created_at, sign_request_id,
             completed_at, signed_pdf_path
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,
             'signed','sent',now() + interval '1 year','forged-provider',
             now(), 'forged.pdf'
           )`,
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
        ),
      /permission denied/i,
    );

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

  it("returns one active-org latest request per property through the bounded RPC", async () => {
    const templateId = await seedTemplate();
    const statusProperties: string[] = [];
    const statuses = [
      "awaiting",
      "viewed",
      "signed",
      "declined",
      "voided",
      "error",
    ] as const;
    for (const status of statuses) {
      const propertyId = await seedProperty();
      statusProperties.push(propertyId);
      const requestId = await seedRequest({ propertyId, templateId });
      await setRequestRole("service_role");
      if (status === "error") {
        await pg.query(
          `update public.esign_requests
           set status = 'error', completed_at = now(), error_message = 'PROVIDER_ERROR'
           where id = $1`,
          [requestId],
        );
      } else if (status !== "awaiting") {
        await pg.query(
          `update public.esign_requests
           set status = $2::public.esign_request_status, delivery_state = 'sent',
               sign_request_id = $3, sent_at = now(),
               completed_at = case when $2::text = 'viewed' then null else now() end,
               void_requested_at = case when $2::text = 'voided' then now() else null end
           where id = $1`,
          [requestId, status, `provider-${status}`],
        );
      }
    }

    const tiePropertyId = await seedProperty();
    const sameCreatedAt = "2026-08-29T20:00:00.000Z";
    const lowerId = "00000000-0000-4000-8000-000000000001";
    const higherId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await seedRequest({
      propertyId: tiePropertyId,
      templateId,
      id: lowerId,
      createdAt: sameCreatedAt,
    });
    await seedRequest({
      propertyId: tiePropertyId,
      templateId,
      id: higherId,
      createdAt: sameCreatedAt,
    });
    for (let index = 0; index < 6; index += 1) {
      await seedRequest({
        propertyId: tiePropertyId,
        templateId,
        createdAt: new Date(
          Date.parse(sameCreatedAt) - index - 1,
        ).toISOString(),
      });
    }
    const otherPropertyId = await seedProperty();
    const otherRequestId = await seedRequest({
      propertyId: otherPropertyId,
      templateId,
    });
    const noContractPropertyId = await seedProperty();

    await setRequestRole("authenticated", memberId);
    const canonical = await pg.query<{ status: string }>(
      `select status
       from public.get_latest_esign_requests_for_properties($1,$2::uuid[])`,
      [BMH_ORG_ID, statusProperties],
    );
    expect(canonical.rows.map((row) => row.status).sort()).toEqual(
      [...statuses].sort(),
    );

    const bounded = await pg.query<{
      org_id: string;
      property_id: string;
      id: string;
      created_at: Date;
      status: string;
    }>(
      "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
      [BMH_ORG_ID, [tiePropertyId, otherPropertyId, noContractPropertyId]],
    );
    expect(bounded.rows).toHaveLength(2);
    const tieRow = bounded.rows.find(
      (row) => row.property_id === tiePropertyId,
    );
    expect(Object.keys(tieRow ?? {}).sort()).toEqual(
      ["org_id", "property_id", "id", "created_at", "status"].sort(),
    );
    expect(tieRow).toMatchObject({
      org_id: BMH_ORG_ID,
      property_id: tiePropertyId,
      id: higherId,
      status: "awaiting",
    });
    expect(tieRow?.created_at).toBeInstanceOf(Date);
    expect(bounded.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          org_id: BMH_ORG_ID,
          property_id: otherPropertyId,
          id: otherRequestId,
          status: "awaiting",
        }),
      ]),
    );

    const exactlyFifty = Array.from({ length: 50 }, () => crypto.randomUUID());
    expect(
      (
        await pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [BMH_ORG_ID, exactlyFifty],
        )
      ).rows,
    ).toEqual([]);

    for (const invalidIds of [
      [],
      [tiePropertyId, tiePropertyId],
      Array.from({ length: 51 }, () => crypto.randomUUID()),
    ]) {
      await expectDatabaseError(
        () =>
          pg.query(
            "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
            [BMH_ORG_ID, invalidIds],
          ),
        /1 to 50 distinct UUIDs/i,
      );
    }
    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.get_latest_esign_requests_for_properties(
             $1,array[$2::uuid,null]::uuid[]
           )`,
          [BMH_ORG_ID, tiePropertyId],
        ),
      /1 to 50 distinct UUIDs/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [TEST_ORG_B_ID, [tiePropertyId]],
        ),
      /active organization membership required/i,
    );
    await setRequestRole("authenticated", outsiderId);
    await expectDatabaseError(
      () =>
        pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [BMH_ORG_ID, [tiePropertyId]],
        ),
      /active organization membership required/i,
    );
    expect(
      (
        await pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [TEST_ORG_B_ID, [tiePropertyId]],
        )
      ).rows,
    ).toEqual([]);
    await setRequestRole("authenticated", memberId);
    expect(
      (
        await pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [BMH_ORG_ID, [crypto.randomUUID()]],
        )
      ).rows,
    ).toEqual([]);

    await setRequestRole("service_role");
    await pg.query(
      "update public.memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
      [memberId, BMH_ORG_ID],
    );
    await setRequestRole("authenticated", memberId);
    await expectDatabaseError(
      () =>
        pg.query(
          "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [BMH_ORG_ID, [tiePropertyId]],
        ),
      /active organization membership required/i,
    );
  });

  it("blocks credential deletion until callbacks and signed PDF capture are complete", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    await setRequestRole("service_role");
    await expectDatabaseError(
      () =>
        pg.query("select public.delete_org_esign_integration($1,$2)", [
          BMH_ORG_ID,
          ownerId,
        ]),
      /Finish active signatures/i,
    );

    await pg.query(
      `update public.esign_requests
       set status = 'signed', delivery_state = 'sent', completed_at = now(),
           sign_request_id = 'provider-request-artifact', sent_at = now()
       where id = $1`,
      [requestId],
    );
    await expectDatabaseError(
      () =>
        pg.query("select public.delete_org_esign_integration($1,$2)", [
          BMH_ORG_ID,
          ownerId,
        ]),
      /save signed PDFs/i,
    );
    await pg.query(
      "update public.esign_requests set signed_pdf_path = $2 where id = $1",
      [requestId, `${BMH_ORG_ID}/fabricated.pdf`],
    );
    await expectDatabaseError(
      () =>
        pg.query("select public.delete_org_esign_integration($1,$2)", [
          BMH_ORG_ID,
          ownerId,
        ]),
      /save signed PDFs/i,
    );

    await pg.query(
      "update public.esign_requests set signed_pdf_path = null where id = $1",
      [requestId],
    );
    const validPath = `${BMH_ORG_ID}/${propertyId}/esign/${requestId}/signed.pdf`;
    const fileName = `signed-contract-${requestId.slice(0, 8)}.pdf`;
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('lead-files', $1, '{"mimetype":"application/pdf","size":1024}')`,
      [validPath],
    );
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const leaseId = crypto.randomUUID();
    const receipt = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_downloadable",
      signRequestId: "provider-request-artifact",
      leaseId,
    });
    expect(
      (
        await pg.query(
          `select * from public.link_esign_signed_artifact(
             $1,$2,$3,$4,$5,'lead-files',$6,'application/pdf',$7,
             'esign_signed_pdf_ready',$8::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            receipt.receipt_id,
            leaseId,
            requestId,
            validPath,
            1024,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", lead_file_id: requestId });
    await pg.query("select public.delete_org_esign_integration($1,$2)", [
      BMH_ORG_ID,
      ownerId,
    ]);
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
         org_id, callback_consumer_id, event_hash, event_fingerprint, payload_hash,
         event_type, sign_request_id, related_signature_id, safe_event_data
       ) values
       ($1,$2,$3,$4,$6,'signature_request_viewed','request-a','signature-a',$7::jsonb),
       ($1,$2,$3,$5,$6,'signature_request_viewed','request-b','signature-b',$8::jsonb)`,
      [
        BMH_ORG_ID,
        consumerId,
        "d".repeat(64),
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        JSON.stringify(
          safeWebhookEventData({
            eventType: "signature_request_viewed",
            signRequestId: "request-a",
            relatedSignatureId: "signature-a",
          }),
        ),
        JSON.stringify(
          safeWebhookEventData({
            eventType: "signature_request_viewed",
            signRequestId: "request-b",
            relatedSignatureId: "signature-b",
          }),
        ),
      ],
    );
    expect(
      (
        await pg.query(
          "select count(*)::int as count from public.esign_webhook_receipts where event_hash = $1",
          ["d".repeat(64)],
        )
      ).rows[0].count,
    ).toBe(2);
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_webhook_receipts (
             org_id, callback_consumer_id, event_hash, event_fingerprint,
             payload_hash, event_type, safe_event_data
           ) values ($1,$2,$3,$4,$5,'signature_request_viewed',$6::jsonb)`,
          [
            BMH_ORG_ID,
            consumerId,
            "e".repeat(64),
            "1".repeat(64),
            "3".repeat(64),
            JSON.stringify(
              safeWebhookEventData({ eventType: "signature_request_viewed" }),
            ),
          ],
        ),
      /unique constraint/i,
    );
  });

  it("claims, reclaims, and completes webhook receipts with org-safe linkage", async () => {
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const firstLease = crypto.randomUUID();
    const secondLease = crypto.randomUUID();
    const thirdLease = crypto.randomUUID();
    const stable = {
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_viewed",
      eventHash: "f".repeat(64),
      fingerprint: "4".repeat(64),
      payloadHash: "5".repeat(64),
    };
    const firstClaim = await claimWebhookReceipt({
      ...stable,
      leaseId: firstLease,
    });
    const receiptId = firstClaim.receipt_id;
    expect(firstClaim).toEqual({
      outcome: "claimed",
      receipt_id: receiptId,
      lease_id: firstLease,
    });
    expect(
      await claimWebhookReceipt({ ...stable, leaseId: secondLease }),
    ).toEqual({
      outcome: "in_progress",
      receipt_id: receiptId,
      lease_id: null,
    });

    await pg.query(
      "update public.esign_webhook_receipts set processing_started_at = now() - interval '10 minutes' where id = $1",
      [receiptId],
    );
    expect(
      (await claimWebhookReceipt({ ...stable, leaseId: secondLease })).outcome,
    ).toBe("claimed");
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
          [receiptId, firstLease],
        ),
      /lease is not active/i,
    );
    await pg.query(
      "select public.complete_esign_webhook_receipt($1,$2,'error',$3)",
      [receiptId, secondLease, "TRANSIENT_PROVIDER_FAILURE"],
    );
    expect(
      (await claimWebhookReceipt({ ...stable, leaseId: thirdLease })).outcome,
    ).toBe("claimed");
    await pg.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [receiptId, thirdLease],
    );
    expect(
      (
        await pg.query(
          `select processing_status, attempt_count, processed_at is not null as processed,
             processing_lease_id, processing_error
           from public.esign_webhook_receipts where id = $1`,
          [receiptId],
        )
      ).rows[0],
    ).toEqual({
      processing_status: "processed",
      attempt_count: 3,
      processed: true,
      processing_lease_id: null,
      processing_error: null,
    });
    expect((await claimWebhookReceipt(stable)).outcome).toBe(
      "already_processed",
    );

    const ignoredLease = crypto.randomUUID();
    const ignored = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "account_callback_test",
      signRequestId: null,
      relatedSignatureId: null,
      reportedForAppId: null,
      leaseId: ignoredLease,
    });
    await pg.query(
      "select public.complete_esign_webhook_receipt($1,$2,'ignored',$3)",
      [ignored.receipt_id, ignoredLease, "CALLBACK_WITHOUT_REQUEST"],
    );
    expect(
      (
        await pg.query(
          `select processing_status, processing_error, safe_event_data
           from public.esign_webhook_receipts where id = $1`,
          [ignored.receipt_id],
        )
      ).rows[0],
    ).toEqual({
      processing_status: "ignored",
      processing_error: "CALLBACK_WITHOUT_REQUEST",
      safe_event_data: {
        event_time: "1788033600",
        event_type: "account_callback_test",
        sign_request_id: null,
        related_signature_id: null,
        reported_for_app_id: null,
      },
    });

    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.claim_esign_webhook_receipt(
             $1,$2,$3,$4,$5,'signature_request_viewed',null,null,now(),
             $6::jsonb,now(),$7,300
           )`,
          [
            BMH_ORG_ID,
            consumer.rows[0].id,
            "9".repeat(64),
            "a".repeat(64),
            "b".repeat(64),
            JSON.stringify({ signer_email: "private@example.com" }),
            crypto.randomUUID(),
          ],
        ),
      /invalid safe event data/i,
    );
    for (const invalidSafeData of [
      null,
      {},
      {
        event_time: "1788033600",
        event_type: "signature_request_viewed",
        sign_request_id: null,
        related_signature_id: null,
      },
      safeWebhookEventData({
        eventType: "signature_request_viewed",
        eventTime: "private@example.com",
      }),
      safeWebhookEventData({ eventType: "Signature Request Viewed" }),
    ]) {
      await expectDatabaseError(
        () =>
          pg.query(
            `select * from public.claim_esign_webhook_receipt(
               $1,$2,$3,$4,$5,'signature_request_viewed',null,null,now(),
               $6::jsonb,now(),$7,300
             )`,
            [
              BMH_ORG_ID,
              consumer.rows[0].id,
              "9".repeat(64),
              crypto.randomUUID().replaceAll("-", "").repeat(2),
              crypto.randomUUID().replaceAll("-", "").repeat(2),
              JSON.stringify(invalidSafeData),
              crypto.randomUUID(),
            ],
          ),
        /invalid safe event data/i,
      );
    }
    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.claim_esign_webhook_receipt(
             $1,$2,$3,$4,$5,'signature_request_viewed',null,null,
             '2026-08-29T20:00:00Z'::timestamptz,$6::jsonb,now(),$7,300
           )`,
          [
            BMH_ORG_ID,
            consumer.rows[0].id,
            "6".repeat(64),
            "7".repeat(64),
            "8".repeat(64),
            JSON.stringify(
              safeWebhookEventData({
                eventType: "signature_request_viewed",
                eventTime: String(
                  Math.floor(
                    new Date("2026-08-29T20:00:01Z").getTime() / 1000,
                  ),
                ),
              }),
            ),
            crypto.randomUUID(),
          ],
        ),
      /normalized receipt identity/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_webhook_receipts (
             org_id, callback_consumer_id, event_hash, event_fingerprint,
             payload_hash, event_type, safe_event_data
           ) values ($1,$2,$3,$4,$5,'signature_request_viewed',$6::jsonb)`,
          [
            BMH_ORG_ID,
            consumer.rows[0].id,
            "9".repeat(64),
            "a".repeat(64),
            "b".repeat(64),
            JSON.stringify({ signer_email: "private@example.com" }),
          ],
        ),
      /check constraint/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_webhook_receipts (
             org_id, callback_consumer_id, event_hash, event_fingerprint,
             payload_hash, event_type, safe_event_data,
             processing_status, processing_error
           ) values (
             $1,$2,$3,$4,$5,'signature_request_viewed',$6::jsonb,'error',$7
           )`,
          [
            BMH_ORG_ID,
            consumer.rows[0].id,
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            JSON.stringify(
              safeWebhookEventData({ eventType: "signature_request_viewed" }),
            ),
            "private provider error text",
          ],
        ),
      /check constraint/i,
    );

    await setRequestRole("authenticated", ownerId);
    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.claim_esign_webhook_receipt(
             $1,$2,$3,$4,$5,'signature_request_viewed',null,null,now(),
             '{}'::jsonb,now(),$6,300
           )`,
          [
            BMH_ORG_ID,
            consumer.rows[0].id,
            "1".repeat(64),
            "2".repeat(64),
            "3".repeat(64),
            crypto.randomUUID(),
          ],
        ),
      /permission denied/i,
    );

    await setRequestRole("service_role");
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    const otherConsumer = await pg.query<{ id: string }>(
      `insert into public.webhook_consumers (
         name, secret_hash, consumer_type, org_id, enabled
       ) values ($1,$2,'esign_provider',$3,true) returning id`,
      [
        `eSign cross-org ${crypto.randomUUID()}`,
        crypto.randomUUID().replaceAll("-", ""),
        TEST_ORG_B_ID,
      ],
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into public.esign_webhook_receipts (
             org_id, callback_consumer_id, esign_request_id, event_hash,
             event_fingerprint, payload_hash, event_type, safe_event_data
           ) values (
             $1,$2,$3,$4,$5,$6,'signature_request_signed',$7::jsonb
           )`,
          [
            TEST_ORG_B_ID,
            otherConsumer.rows[0].id,
            requestId,
            "8".repeat(64),
            "6".repeat(64),
            "7".repeat(64),
            JSON.stringify(
              safeWebhookEventData({ eventType: "signature_request_signed" }),
            ),
          ],
        ),
      /esign_webhook_receipts_request_org_fkey/i,
    );
  });

  it("applies callback status and signed artifacts with atomic exact activity events", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    await setRequestRole("service_role");
    await pg.query(
      `update public.esign_requests
       set delivery_state = 'sent', sign_request_id = 'provider-atomic', sent_at = now()
       where id = $1`,
      [requestId],
    );
    const providerSignatureId = "provider-signature-atomic";
    await pg.query(
      `insert into public.esign_request_signers (
         org_id, request_id, role_name, signer_order, signer_name,
         signer_email, provider_signature_id
       ) values ($1,$2,'Seller',0,'Seller One','seller@example.com',$3)`,
      [BMH_ORG_ID, requestId, providerSignatureId],
    );
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    let sequence = 16;
    const claimReceipt = async (
      eventType: string,
      eventAt: string,
      relatedSignatureId: string | null = null,
    ) => {
      const fingerprint = (sequence++).toString(16).padStart(64, "0");
      return claimWebhookReceipt({
        consumerId: consumer.rows[0].id,
        eventType,
        signRequestId: "provider-atomic",
        eventAt,
        eventHash: "a".repeat(64),
        fingerprint,
        payloadHash: (sequence++).toString(16).padStart(64, "0"),
        relatedSignatureId,
      });
    };

    const unknownViewed = await claimReceipt(
      "signature_request_viewed",
      "2026-08-29T19:59:00.000Z",
      "unknown-provider-signature",
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'awaiting','viewed',$5::timestamptz,
             'esign_viewed',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            unknownViewed.receipt_id,
            unknownViewed.lease_id,
            "2026-08-29T19:59:00.000Z",
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        ),
      /matching.*signer/i,
    );

    const viewed = await claimReceipt(
      "signature_request_viewed",
      "2026-08-29T20:00:00.000Z",
      providerSignatureId,
    );
    expect(
      (
        await pg.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'awaiting','viewed',$5::timestamptz,
             'esign_viewed',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            viewed.receipt_id,
            viewed.lease_id,
            "2026-08-29T20:00:00.000Z",
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "viewed" });
    expect(
      (
        await pg.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'awaiting','viewed',$5::timestamptz,
             'esign_viewed',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            viewed.receipt_id,
            viewed.lease_id,
            "2026-08-29T20:00:00.000Z",
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0].outcome,
    ).toBe("no_change");

    const signed = await claimReceipt(
      "signature_request_all_signed",
      "2026-08-29T20:01:00.000Z",
    );
    expect(
      (
        await pg.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'viewed','signed',$5::timestamptz,
             'esign_signed',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            signed.receipt_id,
            signed.lease_id,
            "2026-08-29T20:01:00.000Z",
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "signed" });

    const regression = await claimReceipt(
      "signature_request_declined",
      "2026-08-29T20:02:00.000Z",
      providerSignatureId,
    );
    expect(
      (
        await pg.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'signed','declined',$5::timestamptz,
             'esign_declined',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            regression.receipt_id,
            regression.lease_id,
            "2026-08-29T20:02:00.000Z",
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0].outcome,
    ).toBe("terminal_ignored");
    expect(
      (
        await pg.query(
          "select status, signed_pdf_path from public.esign_requests where id = $1",
          [requestId],
        )
      ).rows[0],
    ).toEqual({ status: "signed", signed_pdf_path: null });
    expect(
      (
        await pg.query<{ status: string }>(
          "select status from public.esign_request_signers where request_id = $1",
          [requestId],
        )
      ).rows[0].status,
    ).toBe("signed");

    const statusEvents = await pg.query(
      `select event_type, actor_type, actor_id, payload, source_type, source_id
       from public.lead_events
       where source_type = 'esign_status_receipt'
       order by event_type`,
    );
    expect(statusEvents.rows).toEqual([
      {
        event_type: "esign_signed",
        actor_type: "system",
        actor_id: null,
        payload: { template_title: "Purchase agreement" },
        source_type: "esign_status_receipt",
        source_id: signed.receipt_id,
      },
      {
        event_type: "esign_viewed",
        actor_type: "system",
        actor_id: null,
        payload: { template_title: "Purchase agreement" },
        source_type: "esign_status_receipt",
        source_id: viewed.receipt_id,
      },
    ]);
    const downloadable = await claimReceipt(
      "signature_request_downloadable",
      "2026-08-29T20:03:00.000Z",
    );
    const storagePath = `${BMH_ORG_ID}/${propertyId}/esign/${requestId}/signed.pdf`;
    const fileName = `signed-contract-${requestId.slice(0, 8)}.pdf`;
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('lead-files',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [storagePath],
    );
    const link = async (
      receipt = downloadable,
      leadFileId = receipt.receipt_id,
    ) =>
      pg.query<{ outcome: string; lead_file_id: string }>(
        `select * from public.link_esign_signed_artifact(
           $1,$2,$3,$4,$5,'lead-files',$6,'application/pdf',$7,
           'esign_signed_pdf_ready',$8::jsonb
         )`,
        [
          BMH_ORG_ID,
          requestId,
          receipt.receipt_id,
          receipt.lease_id,
          leadFileId,
          storagePath,
          1024,
          JSON.stringify({ template_title: "Purchase agreement" }),
        ],
      );
    expect((await link()).rows[0]).toEqual({
      outcome: "applied",
      lead_file_id: downloadable.receipt_id,
    });
    expect((await link()).rows[0]).toEqual({
      outcome: "already_linked",
      lead_file_id: downloadable.receipt_id,
    });
    const duplicateDownloadable = await claimReceipt(
      "signature_request_downloadable",
      "2026-08-29T20:04:00.000Z",
    );
    expect((await link(duplicateDownloadable)).rows[0]).toEqual({
      outcome: "already_linked",
      lead_file_id: downloadable.receipt_id,
    });

    await resetRequestRole();
    await pg.query(
      "delete from public.lead_events where source_type = 'esign_signed_pdf_request' and source_id = $1",
      [requestId],
    );
    await setRequestRole("service_role");
    expect((await link()).rows[0].outcome).toBe("already_linked");
    await pg.query(
      "delete from public.lead_files where source_request_id = $1",
      [requestId],
    );
    expect((await link()).rows[0].outcome).toBe("applied");
    expect(
      (
        await pg.query(
          `select count(*)::int as count
           from public.lead_events
           where source_type = 'esign_signed_pdf_request' and source_id = $1`,
          [requestId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pg.query(
          `select event_type, actor_type, actor_id, payload
           from public.lead_events
           where source_type = 'esign_signed_pdf_request' and source_id = $1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      event_type: "esign_signed_pdf_ready",
      actor_type: "system",
      actor_id: null,
      payload: { template_title: "Purchase agreement" },
    });
    expect(
      (
        await pg.query(
          "select created_by, storage_path, file_name from public.lead_files where source_request_id = $1",
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      created_by: null,
      storage_path: storagePath,
      file_name: fileName,
    });
    await expectDatabaseError(
      () =>
        pg.query(
          `select * from public.link_esign_signed_artifact(
             $1,$2,$3,$4,$5,'lead-files',$6,'application/pdf',$7,
             'esign_signed_pdf_ready',$8::jsonb
           )`,
          [
            BMH_ORG_ID,
            requestId,
            downloadable.receipt_id,
            downloadable.lease_id,
            downloadable.receipt_id,
            `${BMH_ORG_ID}/${requestId}/wrong.pdf`,
            1024,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        ),
      /artifact metadata is invalid/i,
    );
  });

  it("accepts downloadable recovery and every normalized provider error event", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const cases = [
      {
        eventType: "signature_request_downloadable",
        requestedStatus: "signed",
        leadEventType: "esign_signed",
      },
      {
        eventType: "signature_request_invalid",
        requestedStatus: "error",
        leadEventType: null,
      },
      {
        eventType: "signature_request_expired",
        requestedStatus: "error",
        leadEventType: null,
      },
      {
        eventType: "signature_request_email_bounce",
        requestedStatus: "error",
        leadEventType: null,
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const requestId = await seedRequest({ propertyId, templateId });
      const providerId = `provider-status-case-${index}`;
      const eventAt = `2026-08-29T20:0${index}:00.000Z`;
      await setRequestRole("service_role");
      await pg.query(
        `update public.esign_requests
         set delivery_state = 'sent', sign_request_id = $2, sent_at = now()
         where id = $1`,
        [requestId, providerId],
      );
      const receipt = await claimWebhookReceipt({
        consumerId: consumer.rows[0].id,
        eventType: testCase.eventType,
        signRequestId: providerId,
        eventAt,
      });
      const payload = testCase.leadEventType
        ? JSON.stringify({ template_title: "Purchase agreement" })
        : null;
      if (index === 0) {
        await expectDatabaseError(
          () =>
            pg.query(
              `select * from public.apply_esign_webhook_status_decision(
                 $1,$2,$3,$4,'awaiting',$5,
                 ($6::timestamptz + interval '1 second'),$7,$8::jsonb
               )`,
              [
                BMH_ORG_ID,
                requestId,
                receipt.receipt_id,
                receipt.lease_id,
                testCase.requestedStatus,
                eventAt,
                testCase.leadEventType,
                payload,
              ],
            ),
          /active matching webhook receipt lease not found/i,
        );
      }
      expect(
        (
          await pg.query<{ outcome: string; status: string }>(
            `select * from public.apply_esign_webhook_status_decision(
               $1,$2,$3,$4,'awaiting',$5,$6::timestamptz,$7,$8::jsonb
             )`,
            [
              BMH_ORG_ID,
              requestId,
              receipt.receipt_id,
              receipt.lease_id,
              testCase.requestedStatus,
              eventAt,
              testCase.leadEventType,
              payload,
            ],
          )
        ).rows[0],
      ).toEqual({ outcome: "applied", status: testCase.requestedStatus });
    }

    const persisted = await pg.query(
      `select status, error_message from public.esign_requests
       where sign_request_id like 'provider-status-case-%'
       order by sign_request_id`,
    );
    expect(persisted.rows).toEqual([
      { status: "signed", error_message: null },
      { status: "error", error_message: "PROVIDER_ERROR" },
      { status: "error", error_message: "PROVIDER_ERROR" },
      { status: "error", error_message: "PROVIDER_ERROR" },
    ]);
  });

  it("reconciles signer audit callbacks and emits declined and voided activity exactly once", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const consumerId = (
      await pg.query<{ id: string }>(
        "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
      )
    ).rows[0].id;

    const signerRequestId = await seedRequest({ propertyId, templateId });
    const signerId = crypto.randomUUID();
    const laterSignerId = crypto.randomUUID();
    await setRequestRole("service_role");
    await pg.query(
      `update public.esign_requests
       set delivery_state='sent', sign_request_id='provider-signer-audit', sent_at=now()
       where id=$1`,
      [signerRequestId],
    );
    await pg.query(
      `insert into public.esign_request_signers (
         id,org_id,request_id,role_name,signer_order,signer_name,signer_email,
         provider_signature_id
       ) values
         ($1,$3,$4,'Seller',0,'Test Seller','seller@example.com',$5),
         ($2,$3,$4,'Buyer',1,'Test Buyer','buyer@example.com',$6)`,
      [
        signerId,
        laterSignerId,
        BMH_ORG_ID,
        signerRequestId,
        "provider-signer-audit-id",
        "provider-later-signer-id",
      ],
    );
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, signerRequestId, laterSignerId, crypto.randomUUID()],
        )
      ).rows[0].outcome,
    ).toBe("ineligible");
    const signerReceipt = await claimWebhookReceipt({
      consumerId,
      eventType: "signature_request_signed",
      signRequestId: "provider-signer-audit",
      relatedSignatureId: "provider-signer-audit-id",
    });
    await pg.query(
      "select public.complete_esign_webhook_receipt($1,$2,'ignored','AUDIT_ONLY_EVENT')",
      [signerReceipt.receipt_id, signerReceipt.lease_id],
    );
    expect(
      (
        await pg.query(
          `select signer.status, signer.signed_at is not null as signed,
             receipt.esign_request_id, receipt.processing_error
           from public.esign_request_signers signer
           join public.esign_webhook_receipts receipt on receipt.id=$2
           where signer.id=$1`,
          [signerId, signerReceipt.receipt_id],
        )
      ).rows[0],
    ).toEqual({
      status: "signed",
      signed: true,
      esign_request_id: signerRequestId,
      processing_error: "AUDIT_ONLY_EVENT",
    });
    const laterClaimToken = crypto.randomUUID();
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, signerRequestId, laterSignerId, laterClaimToken],
        )
      ).rows[0].outcome,
    ).toBe("claimed");
    await pg.query(
      "select public.release_esign_signer_reminder($1,$2,$3,$4)",
      [BMH_ORG_ID, signerRequestId, laterSignerId, laterClaimToken],
    );

    for (const [index, transition] of [
      {
        eventType: "signature_request_declined",
        requestedStatus: "declined",
        leadEventType: "esign_declined",
      },
      {
        eventType: "signature_request_canceled",
        requestedStatus: "voided",
        leadEventType: "esign_voided",
      },
    ].entries()) {
      const requestId = await seedRequest({ propertyId, templateId });
      const providerId = `provider-material-${index}`;
      const eventAt = `2026-08-29T21:0${index}:00.000Z`;
      await setRequestRole("service_role");
      await pg.query(
        `update public.esign_requests
         set delivery_state='sent', sign_request_id=$2, sent_at=now()
         where id=$1`,
        [requestId, providerId],
      );
      const providerSignatureId = `material-signature-${index}`;
      if (transition.requestedStatus === "declined") {
        await pg.query(
          `insert into public.esign_request_signers (
             org_id, request_id, role_name, signer_order, signer_name,
             signer_email, provider_signature_id
           ) values ($1,$2,'Seller',0,'Seller One','seller@example.com',$3)`,
          [BMH_ORG_ID, requestId, providerSignatureId],
        );
      }
      const receipt = await claimWebhookReceipt({
        consumerId,
        eventType: transition.eventType,
        signRequestId: providerId,
        eventAt,
        relatedSignatureId:
          transition.requestedStatus === "declined"
            ? providerSignatureId
            : null,
      });
      expect(
        (
          await pg.query<{ outcome: string; status: string }>(
            `select * from public.apply_esign_webhook_status_decision(
               $1,$2,$3,$4,'awaiting',$5,$6::timestamptz,$7,$8::jsonb
             )`,
            [
              BMH_ORG_ID,
              requestId,
              receipt.receipt_id,
              receipt.lease_id,
              transition.requestedStatus,
              eventAt,
              transition.leadEventType,
              JSON.stringify({ template_title: "Purchase agreement" }),
            ],
          )
        ).rows[0],
      ).toEqual({ outcome: "applied", status: transition.requestedStatus });
      if (transition.requestedStatus === "declined") {
        expect(
          (
            await pg.query<{ status: string }>(
              "select status from public.esign_request_signers where request_id=$1",
              [requestId],
            )
          ).rows[0].status,
        ).toBe("declined");
      }
      expect(
        (
          await pg.query(
            `select event_type, actor_type, actor_id, payload
             from public.lead_events
             where source_type='esign_status_receipt' and source_id=$1`,
            [receipt.receipt_id],
          )
        ).rows,
      ).toEqual([
        {
          event_type: transition.leadEventType,
          actor_type: "system",
          actor_id: null,
          payload: { template_title: "Purchase agreement" },
        },
      ]);
    }
  });

  it("publishes a verified hidden edit revision without mutating live or historical state", async () => {
    const sourceTemplateId = await seedTemplate();
    const editedRoles = [
      { name: "Seller", order: 0 },
      { name: "seller", order: 1 },
    ] as const;
    const sourceProviderTemplateId = (
      await pg.query<{ sign_template_id: string }>(
        "select sign_template_id from public.esign_templates where id = $1",
        [sourceTemplateId],
      )
    ).rows[0].sign_template_id;
    const revisionProviderTemplateId = `provider-edit-${crypto.randomUUID()}`;
    const revision = await seedTemplateEditRevision({
      sourceTemplateId,
      providerTemplateId: revisionProviderTemplateId,
    });
    const propertyId = await seedProperty(BMH_ORG_ID, "seller@example.com");
    await connectIntegration();
    await pg.query(
      `update public.org_esign_integrations
       set callback_verified_at = now(), sending_enabled = true
       where org_id = $1`,
      [BMH_ORG_ID],
    );
    const historicalRequest = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId,
      templateId: sourceTemplateId,
      userId: memberId,
    });
    const historicalClaim = await pg.query<{
      outcome: string;
      id: string;
      template_id: string;
    }>(
      "select outcome, id, template_id from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,null,$8)",
      [
        BMH_ORG_ID,
        propertyId,
        sourceTemplateId,
        JSON.stringify(historicalRequest.signer_snapshot),
        JSON.stringify(historicalRequest.merge_value_snapshot),
        historicalRequest.send_intent_id,
        historicalRequest.payload_hash,
        memberId,
      ],
    );
    expect(historicalClaim.rows[0]).toMatchObject({
      outcome: "created",
      template_id: sourceTemplateId,
    });
    const historicalRequestId = historicalClaim.rows[0].id;

    expect(
      (
        await pg.query<{ id: string }>(
          `select id from public.available_esign_templates
           where org_id = $1 order by id`,
          [BMH_ORG_ID],
        )
      ).rows,
    ).toEqual([{ id: sourceTemplateId }]);
    expect(
      (
        await pg.query(
          `select lifecycle_state, finalized_at, supersedes_template_id,
             staging_source_id
           from public.esign_templates where id = $1`,
          [revision.id],
        )
      ).rows[0],
    ).toEqual({
      lifecycle_state: "editing",
      finalized_at: null,
      supersedes_template_id: sourceTemplateId,
      staging_source_id: revision.sourceId,
    });

    await setRequestRole("authenticated", ownerId);
    await expectDatabaseError(
      () =>
        pg.query(
          "update public.esign_templates set finalized_at = now() where id = $1",
          [revision.id],
        ),
      /permission denied/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.create_esign_template_edit_revision($1,$2,$3,$4)",
          [BMH_ORG_ID, sourceTemplateId, revision.sourceId, ownerId],
        ),
      /permission denied/i,
    );
    await expectDatabaseError(
      () =>
        publishTemplateEditRevision({
          sourceTemplateId,
          revisionTemplateId: revision.id,
          sourceProviderTemplateId,
          revisionProviderTemplateId,
        }),
      /permission denied/i,
    );
    await setRequestRole("service_role");
    await expectDatabaseError(
      () =>
        pg.query(
          `select public.finalize_esign_template(
             $1,$2,$3,'Seller',$4::jsonb,$5,$6
           )`,
          [
            BMH_ORG_ID,
            revision.id,
            revisionProviderTemplateId,
            JSON.stringify([{ name: "Seller", order: 0 }]),
            [
              "seller_name",
              "property_address",
              "offer_price",
              "closing_date",
              "earnest_money",
            ],
            ownerId,
          ],
        ),
      /atomic publish/i,
    );
    await expectDatabaseError(
      () =>
        publishTemplateEditRevision({
          sourceTemplateId,
          revisionTemplateId: revision.id,
          sourceProviderTemplateId,
          revisionProviderTemplateId: sourceProviderTemplateId,
        }),
      /contract is invalid/i,
    );
    await expectDatabaseError(
      () =>
        publishTemplateEditRevision({
          sourceTemplateId,
          revisionTemplateId: revision.id,
          sourceProviderTemplateId: "stale-provider-id",
          revisionProviderTemplateId,
        }),
      /no longer active or current/i,
    );
    await expectDatabaseError(
      () =>
        publishTemplateEditRevision({
          sourceTemplateId,
          revisionTemplateId: revision.id,
          sourceProviderTemplateId,
          revisionProviderTemplateId,
          actorId: outsiderId,
        }),
      /active organization owner required/i,
    );

    expect(
      await publishTemplateEditRevision({
        sourceTemplateId,
        revisionTemplateId: revision.id,
        sourceProviderTemplateId,
        revisionProviderTemplateId,
        signerRoles: editedRoles,
      }),
    ).toBe("published");
    expect(
      await publishTemplateEditRevision({
        sourceTemplateId,
        revisionTemplateId: revision.id,
        sourceProviderTemplateId,
        revisionProviderTemplateId,
        signerRoles: editedRoles,
      }),
    ).toBe("already_published");

    expect(
      (
        await pg.query(
          `select id, lifecycle_state, deleted_at is not null as deleted,
             supersedes_template_id
           from public.esign_templates
           where id in ($1,$2) order by id`,
          [sourceTemplateId, revision.id],
        )
      ).rows,
    ).toEqual(
      [
        {
          id: sourceTemplateId,
          lifecycle_state: "deleted",
          deleted: true,
          supersedes_template_id: null,
        },
        {
          id: revision.id,
          lifecycle_state: "finalized",
          deleted: false,
          supersedes_template_id: sourceTemplateId,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      (
        await pg.query<{ id: string; signer_roles: unknown }>(
          `select id, signer_roles from public.available_esign_templates
           where org_id = $1 order by id`,
          [BMH_ORG_ID],
        )
      ).rows,
    ).toEqual([{ id: revision.id, signer_roles: editedRoles }]);
    expect(
      (
        await pg.query<{ count: string }>(
          `select count(*) from public.esign_requests
           where id = $1 and template_id = $2`,
          [historicalRequestId, sourceTemplateId],
        )
      ).rows[0].count,
    ).toBe("1");

    const oldRequest = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId,
      templateId: sourceTemplateId,
      userId: memberId,
    });
    const newRequest = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId,
      templateId: revision.id,
      userId: memberId,
    });
    const editedSignerSnapshot = [
      {
        role: "Seller",
        name: "Primary seller",
        emailAddress: "seller@example.com",
      },
      {
        role: "seller",
        name: "Secondary signer",
        emailAddress: "secondary@example.com",
      },
    ];
    const oldClaim = await pg.query<{ outcome: string; blocker_code: string }>(
      "select outcome, blocker_code from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,null,$8)",
      [
        BMH_ORG_ID,
        propertyId,
        sourceTemplateId,
        JSON.stringify(oldRequest.signer_snapshot),
        JSON.stringify(oldRequest.merge_value_snapshot),
        oldRequest.send_intent_id,
        oldRequest.payload_hash,
        memberId,
      ],
    );
    expect(oldClaim.rows[0]).toEqual({
      outcome: "blocked",
      blocker_code: "FINALIZED_TEMPLATE_NOT_FOUND",
    });
    const newClaim = await pg.query<{ outcome: string; template_id: string }>(
      "select outcome, template_id from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,null,$8)",
      [
        BMH_ORG_ID,
        propertyId,
        revision.id,
        JSON.stringify(editedSignerSnapshot),
        JSON.stringify(newRequest.merge_value_snapshot),
        newRequest.send_intent_id,
        newRequest.payload_hash,
        memberId,
      ],
    );
    expect(newClaim.rows[0]).toEqual({
      outcome: "created",
      template_id: revision.id,
    });
    expect(
      (
        await pg.query(
          `select role_name, signer_order
           from public.esign_request_signers
           where request_id = (
             select id from public.esign_requests
             where org_id = $1 and send_intent_id = $2
           )
           order by signer_order`,
          [BMH_ORG_ID, newRequest.send_intent_id],
        )
      ).rows,
    ).toEqual([
      { role_name: "Seller", signer_order: 0 },
      { role_name: "seller", signer_order: 1 },
    ]);
  });

  it("abandons and cleans only the hidden edit revision", async () => {
    const sourceTemplateId = await seedTemplate();
    const revision = await seedTemplateEditRevision({
      sourceTemplateId,
      providerTemplateId: `provider-edit-${crypto.randomUUID()}`,
    });
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.abandon_esign_template_draft($1,$2,$3) as result",
          [BMH_ORG_ID, revision.id, ownerId],
        )
      ).rows[0].result,
    ).toBe("abandoned");

    await pg.query(
      "select set_config('storage.allow_delete_query','true',true)",
    );
    try {
      await pg.query(
        "delete from storage.objects where bucket_id = 'esign-staging' and name = $1",
        [revision.sourcePath],
      );
    } finally {
      await pg.query(
        "select set_config('storage.allow_delete_query','false',true)",
      );
    }
    await pg.query(
      `select public.record_esign_template_source_cleanup(
         $1,$2,$3,'deleted',null,$4
       )`,
      [BMH_ORG_ID, revision.id, revision.sourcePath, ownerId],
    );
    expect(
      (
        await pg.query(
          `select id, lifecycle_state, deleted_at, staging_deleted_at,
             supersedes_template_id
           from public.esign_templates
           where id in ($1,$2) order by id`,
          [sourceTemplateId, revision.id],
        )
      ).rows,
    ).toEqual(
      [
        {
          id: sourceTemplateId,
          lifecycle_state: "finalized",
          deleted_at: null,
          staging_deleted_at: null,
          supersedes_template_id: null,
        },
        {
          id: revision.id,
          lifecycle_state: "abandoned",
          deleted_at: null,
          staging_deleted_at: expect.any(Date),
          supersedes_template_id: sourceTemplateId,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      (
        await pg.query<{ id: string }>(
          "select id from public.available_esign_templates where id = $1",
          [sourceTemplateId],
        )
      ).rows,
    ).toEqual([{ id: sourceTemplateId }]);
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
    const buckets = await pg.query<{
      id: string;
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(
      `select id, public, file_size_limit, allowed_mime_types
       from storage.buckets
       where id in ('esign-staging','lead-files') order by id`,
    );
    expect(buckets.rows).toEqual([
      {
        id: "esign-staging",
        public: false,
        file_size_limit: "41943040",
        allowed_mime_types: ["application/pdf"],
      },
      {
        id: "lead-files",
        public: false,
        file_size_limit: "41943040",
        allowed_mime_types: ["application/pdf"],
      },
    ]);
    expect(definition.rows).toHaveLength(1);
  });

  it("keeps drafts and provider finalization behind owner-authorized service RPCs", async () => {
    await setRequestRole("service_role");
    const sourceId = crypto.randomUUID();
    const sourcePath = `${BMH_ORG_ID}/${sourceId}.pdf`;
    const caseDistinctRoles = [
      { name: "Seller", order: 0 },
      { name: "seller", order: 1 },
    ] as const;
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('esign-staging',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [sourcePath],
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `select public.record_verified_esign_template_source(
           $1,$2,$3,'purchase-agreement.pdf',2048,'application/pdf',$4,$5
         )`,
          [BMH_ORG_ID, sourceId, sourcePath, "c".repeat(64), ownerId],
        ),
      /does not match storage/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `select public.record_verified_esign_template_source(
           $1,$2,$3,'purchase-agreement.pdf',1024,'application/pdf',$4,$5
         )`,
          [
            BMH_ORG_ID,
            crypto.randomUUID(),
            `${BMH_ORG_ID}/${crypto.randomUUID()}.pdf`,
            "c".repeat(64),
            ownerId,
          ],
        ),
      /metadata is invalid|does not match storage/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          `select public.record_verified_esign_template_source(
           $1,$2,$3,'purchase-agreement.pdf',1024,'application/pdf',$4,$5
         )`,
          [TEST_ORG_B_ID, sourceId, sourcePath, "c".repeat(64), ownerId],
        ),
      /active organization owner required/i,
    );
    await pg.query(
      `select public.record_verified_esign_template_source(
         $1,$2,$3,'purchase-agreement.pdf',1024,'application/pdf',$4,$5
       )`,
      [BMH_ORG_ID, sourceId, sourcePath, "c".repeat(64), ownerId],
    );
    for (const invalidName of [" leading space", "x".repeat(161)]) {
      await expectDatabaseError(
        () =>
          pg.query(
            `select public.create_esign_template_draft(
               $1,$2,$3,'purchase_agreement','Seller',$4::jsonb,$5
             )`,
            [
              BMH_ORG_ID,
              sourceId,
              invalidName,
              JSON.stringify([{ name: "Seller", order: 0 }]),
              ownerId,
            ],
          ),
        /check constraint/i,
      );
    }
    for (const invalidRoles of [
      [
        { name: "Seller", order: 0 },
        { name: "Seller", order: 1 },
      ],
      [{ name: "Seller", order: 1 }],
    ]) {
      await expectDatabaseError(
        () =>
          pg.query(
            `select public.create_esign_template_draft(
               $1,$2,'Invalid roles','purchase_agreement','Seller',$3::jsonb,$4
             )`,
            [BMH_ORG_ID, sourceId, JSON.stringify(invalidRoles), ownerId],
          ),
        /violates check constraint/i,
      );
    }
    const draft = await pg.query<{ id: string }>(
      `select public.create_esign_template_draft(
         $1,$2,'Purchase agreement','purchase_agreement','Seller',$3::jsonb,$4
       ) as id`,
      [
        BMH_ORG_ID,
        sourceId,
        JSON.stringify(caseDistinctRoles),
        ownerId,
      ],
    );
    const templateId = draft.rows[0].id;

    await setRequestRole("authenticated", memberId);
    expect(
      (
        await pg.query("select id from public.esign_templates where id = $1", [
          templateId,
        ])
      ).rows,
    ).toEqual([]);
    await expectDatabaseError(
      () =>
        pg.query(
          "update public.esign_templates set finalized_at = now(), sign_template_id = 'forged' where id = $1",
          [templateId],
        ),
      /permission denied/i,
    );

    await setRequestRole("service_role");
    await expectDatabaseError(
      () =>
        pg.query(
          "update public.esign_templates set staging_deleted_at = now() where id = $1",
          [templateId],
        ),
      /staging_cleanup/i,
    );
    for (const invalidFields of [
      ["seller_name", "property_address", "offer_price", "closing_date"],
      [
        "Seller_Name",
        "property_address",
        "offer_price",
        "closing_date",
        "earnest_money",
      ],
      [
        "seller_name",
        "property_address",
        "offer_price",
        "closing_date",
        "earnest_money",
        "unexpected",
      ],
    ]) {
      await expectDatabaseError(
        () =>
          pg.query(
            "select public.finalize_esign_template($1,$2,$3,$4,$5::jsonb,$6,$7)",
            [
              BMH_ORG_ID,
              templateId,
              "provider-template",
              "Seller",
              JSON.stringify([{ name: "Seller", order: 0 }]),
              invalidFields,
              ownerId,
            ],
          ),
        /provider-reconciled template contract is invalid/i,
      );
    }
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.attach_esign_template_provider_id($1,$2,$3,$4) as result",
          [BMH_ORG_ID, templateId, "provider-template", ownerId],
        )
      ).rows[0].result,
    ).toBe("attached");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.attach_esign_template_provider_id($1,$2,$3,$4) as result",
          [BMH_ORG_ID, templateId, "provider-template", ownerId],
        )
      ).rows[0].result,
    ).toBe("already_attached");
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.attach_esign_template_provider_id($1,$2,$3,$4)",
          [BMH_ORG_ID, templateId, "provider-conflict", ownerId],
        ),
      /conflicts/i,
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.finalize_esign_template($1,$2,$3,$4,$5::jsonb,$6,$7)",
          [
            BMH_ORG_ID,
            templateId,
            "provider-template",
            "SELLER",
            JSON.stringify(caseDistinctRoles),
            [
              "seller_name",
              "property_address",
              "offer_price",
              "closing_date",
              "earnest_money",
            ],
            ownerId,
          ],
        ),
      /provider-reconciled template contract is invalid/i,
    );
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.finalize_esign_template($1,$2,$3,$4,$5::jsonb,$6,$7) as result",
          [
            BMH_ORG_ID,
            templateId,
            "provider-template",
            "Seller",
            JSON.stringify(caseDistinctRoles),
            [
              "earnest_money",
              "closing_date",
              "offer_price",
              "property_address",
              "seller_name",
            ],
            ownerId,
          ],
        )
      ).rows[0].result,
    ).toBe("finalized");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.finalize_esign_template($1,$2,$3,$4,$5::jsonb,$6,$7) as result",
          [
            BMH_ORG_ID,
            templateId,
            "provider-template",
            "Seller",
            JSON.stringify(caseDistinctRoles),
            [
              "seller_name",
              "property_address",
              "offer_price",
              "closing_date",
              "earnest_money",
            ],
            ownerId,
          ],
        )
      ).rows[0].result,
    ).toBe("already_finalized");
    expect(
      (
        await pg.query<{ signer_roles: unknown; seller_role: string }>(
          `select signer_roles, seller_role
           from public.available_esign_templates where id = $1`,
          [templateId],
        )
      ).rows[0],
    ).toEqual({
      signer_roles: caseDistinctRoles,
      seller_role: "Seller",
    });

    const propertyIdForClaim = await seedProperty(
      BMH_ORG_ID,
      "seller@example.com",
    );
    await connectIntegration();
    await pg.query(
      `update public.org_esign_integrations
       set callback_verified_at = now(), sending_enabled = true
       where org_id = $1`,
      [BMH_ORG_ID],
    );
    const requestForClaim = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId: propertyIdForClaim,
      templateId,
      userId: memberId,
    });
    const caseDistinctSignerSnapshot = [
      {
        role: "Seller",
        name: "Primary seller",
        emailAddress: "seller@example.com",
      },
      {
        role: "seller",
        name: "Secondary signer",
        emailAddress: "secondary@example.com",
      },
    ];
    const caseDistinctClaim = await pg.query<{
      outcome: string;
      signer_snapshot: unknown;
    }>(
      `select outcome, signer_snapshot
       from public.create_esign_request(
         $1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,null,$8
       )`,
      [
        BMH_ORG_ID,
        propertyIdForClaim,
        templateId,
        JSON.stringify(caseDistinctSignerSnapshot),
        JSON.stringify(requestForClaim.merge_value_snapshot),
        requestForClaim.send_intent_id,
        requestForClaim.payload_hash,
        memberId,
      ],
    );
    expect(caseDistinctClaim.rows[0]).toEqual({
      outcome: "created",
      signer_snapshot: caseDistinctSignerSnapshot,
    });
    expect(
      (
        await pg.query(
          `select role_name, signer_order
           from public.esign_request_signers
           where request_id = (
             select id from public.esign_requests
             where org_id = $1 and send_intent_id = $2
           )
           order by signer_order`,
          [BMH_ORG_ID, requestForClaim.send_intent_id],
        )
      ).rows,
    ).toEqual([
      { role_name: "Seller", signer_order: 0 },
      { role_name: "seller", signer_order: 1 },
    ]);
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.record_esign_template_source_cleanup($1,$2,$3,'failed',$4,$5) as result",
          [
            BMH_ORG_ID,
            templateId,
            sourcePath,
            "STORAGE_DELETE_FAILED",
            ownerId,
          ],
        )
      ).rows[0].result,
    ).toBe("failed");

    const duplicate = await pg.query<{ id: string }>(
      "select public.create_esign_template_duplicate_draft($1,$2,'Purchase agreement copy',$3) as id",
      [BMH_ORG_ID, templateId, ownerId],
    );
    expect(
      (
        await pg.query(
          "select lifecycle_state, duplicate_of_template_id, staging_source_id from public.esign_templates where id = $1",
          [duplicate.rows[0].id],
        )
      ).rows[0],
    ).toEqual({
      lifecycle_state: "preparing",
      duplicate_of_template_id: templateId,
      staging_source_id: null,
    });
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.abandon_esign_template_draft($1,$2,$3) as result",
          [BMH_ORG_ID, duplicate.rows[0].id, ownerId],
        )
      ).rows[0].result,
    ).toBe("abandoned");

    const needsConfirmation = await pg.query<{
      outcome: string;
      recent_send_count: string;
    }>("select * from public.soft_delete_esign_template($1,$2,false,$3)", [
      BMH_ORG_ID,
      templateId,
      ownerId,
    ]);
    expect(needsConfirmation.rows[0]).toEqual({
      outcome: "needs_confirmation",
      recent_send_count: "1",
    });
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.soft_delete_esign_template($1,$2,true,$3)",
          [BMH_ORG_ID, templateId, ownerId],
        )
      ).rows[0].outcome,
    ).toBe("deleted");

    await setRequestRole("authenticated", memberId);
    expect(
      (
        await pg.query(
          "select id from public.available_esign_templates where id = $1",
          [templateId],
        )
      ).rows,
    ).toEqual([]);
    await expectDatabaseError(
      () =>
        pg.query("delete from public.esign_templates where id = $1", [
          templateId,
        ]),
      /permission denied/i,
    );
  });

  it("audits source-backed abandon cleanup only after the private object is gone", async () => {
    await setRequestRole("service_role");
    const sourceId = crypto.randomUUID();
    const sourcePath = `${BMH_ORG_ID}/${sourceId}.pdf`;
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('esign-staging',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [sourcePath],
    );
    await pg.query(
      `select public.record_verified_esign_template_source(
         $1,$2,$3,'abandoned-source.pdf',1024,'application/pdf',$4,$5
       )`,
      [BMH_ORG_ID, sourceId, sourcePath, "e".repeat(64), ownerId],
    );
    const draft = await pg.query<{ id: string }>(
      `select public.create_esign_template_draft(
         $1,$2,'Abandoned agreement','purchase_agreement','Seller',$3::jsonb,$4
       ) as id`,
      [
        BMH_ORG_ID,
        sourceId,
        JSON.stringify([{ name: "Seller", order: 0 }]),
        ownerId,
      ],
    );
    await pg.query("select public.abandon_esign_template_draft($1,$2,$3)", [
      BMH_ORG_ID,
      draft.rows[0].id,
      ownerId,
    ]);
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.record_esign_template_source_cleanup($1,$2,$3,'deleted',null,$4)",
          [BMH_ORG_ID, draft.rows[0].id, sourcePath, ownerId],
        ),
      /object still exists/i,
    );

    // The production adapter removes bytes through the private Storage API.
    // This transaction-local migration test simulates that already-completed
    // external step because the HTTP service cannot see uncommitted test DDL.
    await pg.query(
      "select set_config('storage.allow_delete_query','true',true)",
    );
    try {
      await pg.query(
        "delete from storage.objects where bucket_id = 'esign-staging' and name = $1",
        [sourcePath],
      );
    } finally {
      await pg.query(
        "select set_config('storage.allow_delete_query','false',true)",
      );
    }
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.record_esign_template_source_cleanup($1,$2,$3,'deleted',null,$4) as result",
          [BMH_ORG_ID, draft.rows[0].id, sourcePath, ownerId],
        )
      ).rows[0].result,
    ).toBe("deleted");
    expect(
      (
        await pg.query(
          `select template.lifecycle_state,
             template.staging_deleted_at is not null as staging_deleted,
             source.cleanup_outcome,
             source.cleanup_attempted_at is not null as cleanup_attempted,
             source.cleanup_error_code
           from public.esign_templates template
           join public.esign_template_staging_sources source
             on source.id = template.staging_source_id
           where template.id = $1`,
          [draft.rows[0].id],
        )
      ).rows[0],
    ).toEqual({
      lifecycle_state: "abandoned",
      staging_deleted: true,
      cleanup_outcome: "deleted",
      cleanup_attempted: true,
      cleanup_error_code: null,
    });
  });

  it("rejects cross-org owners across every template mutation RPC", async () => {
    const templateId = await seedTemplate();
    const template = (
      await pg.query<{ staging_source_id: string; staging_path: string }>(
        "select staging_source_id, staging_path from public.esign_templates where id = $1",
        [templateId],
      )
    ).rows[0];
    await setRequestRole("service_role");
    const attempts = [
      () =>
        pg.query(
          `select public.record_verified_esign_template_source(
             $1,$2,$3,'cross-org.pdf',1024,'application/pdf',$4,$5
           )`,
          [
            BMH_ORG_ID,
            crypto.randomUUID(),
            `${BMH_ORG_ID}/${crypto.randomUUID()}.pdf`,
            "d".repeat(64),
            outsiderId,
          ],
        ),
      () =>
        pg.query(
          `select public.create_esign_template_draft(
             $1,$2,'Cross-org draft','purchase_agreement','Seller',$3::jsonb,$4
           )`,
          [
            BMH_ORG_ID,
            template.staging_source_id,
            JSON.stringify([{ name: "Seller", order: 0 }]),
            outsiderId,
          ],
        ),
      () =>
        pg.query(
          "select public.create_esign_template_duplicate_draft($1,$2,'Cross-org copy',$3)",
          [BMH_ORG_ID, templateId, outsiderId],
        ),
      () =>
        pg.query(
          "select public.create_esign_template_edit_revision($1,$2,$3,$4)",
          [
            BMH_ORG_ID,
            templateId,
            template.staging_source_id,
            outsiderId,
          ],
        ),
      () =>
        pg.query(
          "select public.attach_esign_template_provider_id($1,$2,'forged-provider',$3)",
          [BMH_ORG_ID, templateId, outsiderId],
        ),
      () =>
        pg.query(
          `select public.finalize_esign_template(
             $1,$2,$3,'Seller',$4::jsonb,$5,$6
           )`,
          [
            BMH_ORG_ID,
            templateId,
            `provider-${templateId}`,
            JSON.stringify([{ name: "Seller", order: 0 }]),
            [
              "seller_name",
              "property_address",
              "offer_price",
              "closing_date",
              "earnest_money",
            ],
            outsiderId,
          ],
        ),
      () =>
        pg.query(
          `select public.publish_esign_template_edit_revision(
             $1,$2,$3,$4,$5,'Seller',$6::jsonb,$7,$8
           )`,
          [
            BMH_ORG_ID,
            templateId,
            crypto.randomUUID(),
            `provider-${templateId}`,
            `provider-edit-${templateId}`,
            JSON.stringify([{ name: "Seller", order: 0 }]),
            [
              "seller_name",
              "property_address",
              "offer_price",
              "closing_date",
              "earnest_money",
            ],
            outsiderId,
          ],
        ),
      () =>
        pg.query("select public.abandon_esign_template_draft($1,$2,$3)", [
          BMH_ORG_ID,
          templateId,
          outsiderId,
        ]),
      () =>
        pg.query(
          "select public.record_esign_template_source_cleanup($1,$2,$3,'failed','FORGED',$4)",
          [BMH_ORG_ID, templateId, template.staging_path, outsiderId],
        ),
      () =>
        pg.query(
          "select * from public.soft_delete_esign_template($1,$2,true,$3)",
          [BMH_ORG_ID, templateId, outsiderId],
        ),
    ];
    for (const attempt of attempts) {
      await expectDatabaseError(attempt, /active organization owner required/i);
    }
  });

  it("enforces owner-scoped PDF staging policies and opaque paths", async () => {
    const sourceId = crypto.randomUUID();
    const ownPath = `${BMH_ORG_ID}/${sourceId}.pdf`;
    await setRequestRole("authenticated", ownerId);
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('esign-staging', $1, '{"mimetype":"application/pdf","size":1024}')`,
      [ownPath],
    );
    await setRequestRole("service_role");
    await pg.query(
      `select public.record_verified_esign_template_source(
         $1,$2,$3,'source.pdf',1024,'application/pdf',$4,$5
       )`,
      [BMH_ORG_ID, sourceId, ownPath, "a".repeat(64), ownerId],
    );
    await setRequestRole("authenticated", ownerId);
    expect(
      (
        await pg.query(
          `update storage.objects set metadata = '{"mimetype":"application/pdf","size":2048}'
           where bucket_id = 'esign-staging' and name = $1 returning id`,
          [ownPath],
        )
      ).rows,
    ).toEqual([]);
    await expectDatabaseError(
      () =>
        pg.query(
          `delete from storage.objects
           where bucket_id = 'esign-staging' and name = $1 returning id`,
          [ownPath],
        ),
      /storage api|row-level security|permission denied/i,
    );
    expect(
      (
        await pg.query<{ size: string }>(
          `select metadata ->> 'size' as size from storage.objects
           where bucket_id = 'esign-staging' and name = $1`,
          [ownPath],
        )
      ).rows,
    ).toEqual([{ size: "1024" }]);

    await setRequestRole("authenticated", memberId);
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into storage.objects (bucket_id, name, metadata)
           values ('esign-staging', $1, '{"mimetype":"application/pdf","size":1024}')`,
          [`${BMH_ORG_ID}/${crypto.randomUUID()}.pdf`],
        ),
      /row-level security/i,
    );

    await setRequestRole("authenticated", ownerId);
    await expectDatabaseError(
      () =>
        pg.query(
          `insert into storage.objects (bucket_id, name, metadata)
           values ('esign-staging', $1, '{"mimetype":"application/pdf","size":1024}')`,
          [`${TEST_ORG_B_ID}/${crypto.randomUUID()}.pdf`],
        ),
      /row-level security/i,
    );
  });

  it("creates authoritative initial requests and newer same-contract retries only", async () => {
    await connectIntegration();
    await setRequestRole("service_role");
    await pg.query(
      `update public.org_esign_integrations
       set callback_verified_at = now(), sending_enabled = true
       where org_id = $1`,
      [BMH_ORG_ID],
    );
    const propertyId = await seedProperty(BMH_ORG_ID, "seller@example.com");
    const noContractPropertyId = await seedProperty();
    const otherPropertyId = await seedProperty();
    const templateId = await seedTemplate();
    const otherTemplateId = await seedTemplate();
    const requestFixture = esignRequestFixture({
      orgId: BMH_ORG_ID,
      propertyId,
      templateId,
      userId: memberId,
    });
    const created = await pg.query<{
      outcome: string;
      blocker_code: string | null;
      id: string;
      org_id: string;
      property_id: string;
      template_id: string;
      send_intent_id: string;
      payload_hash: string;
      retry_of_request_id: string | null;
      signer_snapshot: unknown;
      merge_value_snapshot: unknown;
      status: string;
      delivery_state: string;
      test_mode: boolean;
      created_at: string;
    }>(
      "select * from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
      [
        BMH_ORG_ID,
        propertyId,
        templateId,
        JSON.stringify(requestFixture.signer_snapshot),
        JSON.stringify(requestFixture.merge_value_snapshot),
        requestFixture.send_intent_id,
        requestFixture.payload_hash,
        null,
        memberId,
      ],
    );
    const requestId = created.rows[0].id;
    expect(created.rows[0]).toMatchObject({
      outcome: "created",
      blocker_code: null,
      id: requestId,
      org_id: BMH_ORG_ID,
      property_id: propertyId,
      template_id: templateId,
      send_intent_id: requestFixture.send_intent_id,
      payload_hash: requestFixture.payload_hash,
      retry_of_request_id: null,
      signer_snapshot: requestFixture.signer_snapshot,
      merge_value_snapshot: requestFixture.merge_value_snapshot,
      status: "awaiting",
      delivery_state: "sending",
      test_mode: true,
    });
    expect(
      (
        await pg.query<{ outcome: string; id: string }>(
          "select outcome, id from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
          [
            BMH_ORG_ID,
            propertyId,
            templateId,
            JSON.stringify(requestFixture.signer_snapshot),
            JSON.stringify(requestFixture.merge_value_snapshot),
            requestFixture.send_intent_id,
            requestFixture.payload_hash,
            null,
            memberId,
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "existing_same_payload", id: requestId });
    expect(
      (
        await pg.query<{ outcome: string; blocker_code: string }>(
          "select outcome, blocker_code from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
          [
            BMH_ORG_ID,
            propertyId,
            templateId,
            JSON.stringify(requestFixture.signer_snapshot),
            JSON.stringify(requestFixture.merge_value_snapshot),
            requestFixture.send_intent_id,
            "d".repeat(64),
            null,
            memberId,
          ],
        )
      ).rows[0],
    ).toEqual({
      outcome: "intent_conflict",
      blocker_code: "SEND_INTENT_CONFLICT",
    });
    expect(
      (
        await pg.query(
          `select status, delivery_state, test_mode, sign_request_id,
             completed_at, signed_pdf_path
           from public.esign_requests where id = $1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      status: "awaiting",
      delivery_state: "sending",
      test_mode: true,
      sign_request_id: null,
      completed_at: null,
      signed_pdf_path: null,
    });
    expect(
      (
        await pg.query(
          `select role_name, signer_order, signer_email, provider_signature_id
           from public.esign_request_signers where request_id = $1`,
          [requestId],
        )
      ).rows,
    ).toEqual([
      {
        role_name: "Seller",
        signer_order: 0,
        signer_email: "seller@example.com",
        provider_signature_id: null,
      },
    ]);
    expect(
      (
        await pg.query(
          `select event_type, actor_type, actor_id, payload
           from public.lead_events
           where source_type = 'esign_request' and source_id = $1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      event_type: "esign_awaiting",
      actor_type: "system",
      actor_id: null,
      payload: { template_title: "Purchase agreement" },
    });
    expect(
      (
        await pg.query(
          "select id from public.esign_requests where property_id = $1",
          [noContractPropertyId],
        )
      ).rows,
    ).toEqual([]);

    await pg.query(
      "select public.mark_esign_request_send_outcome($1,$2,'failed',$3)",
      [BMH_ORG_ID, requestId, "PROVIDER_REJECTED"],
    );
    expect(
      (
        await pg.query(
          `select status, delivery_state, completed_at is not null as completed,
             error_message
           from public.esign_requests where id = $1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      status: "error",
      delivery_state: "failed",
      completed: true,
      error_message: "PROVIDER_REJECTED",
    });
    const retry = await pg.query<{ id: string; outcome: string }>(
      "select id, outcome from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
      [
        BMH_ORG_ID,
        propertyId,
        templateId,
        JSON.stringify(requestFixture.signer_snapshot),
        JSON.stringify(requestFixture.merge_value_snapshot),
        crypto.randomUUID(),
        requestFixture.payload_hash,
        requestId,
        memberId,
      ],
    );
    expect(retry.rows[0].outcome).toBe("created");
    const latest = await pg.query<{
      id: string;
      retry_of_request_id: string | null;
    }>(
      `select id, retry_of_request_id
       from public.esign_requests
       where org_id = $1 and property_id = $2
       order by created_at desc, id desc limit 1`,
      [BMH_ORG_ID, propertyId],
    );
    expect(latest.rows[0]).toEqual({
      id: retry.rows[0].id,
      retry_of_request_id: requestId,
    });
    await setRequestRole("authenticated", memberId);
    expect(
      (
        await pg.query<{ id: string }>(
          "select id from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
          [BMH_ORG_ID, [propertyId]],
        )
      ).rows,
    ).toEqual([{ id: retry.rows[0].id }]);
    await setRequestRole("service_role");

    const otherSellerEmail = (
      await pg.query<{ email: string }>(
        `select contact.email
         from public.properties property
         join public.contacts contact on contact.id = property.homeowner_contact_id
         where property.id = $1`,
        [otherPropertyId],
      )
    ).rows[0].email;
    const otherPropertySigners = requestFixture.signer_snapshot.map(
      (signer) => ({
        ...signer,
        emailAddress: otherSellerEmail,
      }),
    );
    for (const [candidateProperty, candidateTemplate, candidateSigners] of [
      [otherPropertyId, templateId, otherPropertySigners],
      [propertyId, otherTemplateId, requestFixture.signer_snapshot],
    ]) {
      expect(
        (
          await pg.query<{ outcome: string; blocker_code: string }>(
            "select outcome, blocker_code from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
            [
              BMH_ORG_ID,
              candidateProperty,
              candidateTemplate,
              JSON.stringify(candidateSigners),
              JSON.stringify(requestFixture.merge_value_snapshot),
              crypto.randomUUID(),
              requestFixture.payload_hash,
              requestId,
              memberId,
            ],
          )
        ).rows[0],
      ).toEqual({ outcome: "blocked", blocker_code: "RETRY_NOT_ELIGIBLE" });
    }

    await pg.query(
      `update public.contacts contact set email = null
       from public.properties property
       where property.id = $1 and contact.id = property.homeowner_contact_id`,
      [propertyId],
    );
    expect(
      (
        await pg.query<{ outcome: string; blocker_code: string }>(
          "select outcome, blocker_code from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
          [
            BMH_ORG_ID,
            propertyId,
            templateId,
            JSON.stringify(requestFixture.signer_snapshot),
            JSON.stringify(requestFixture.merge_value_snapshot),
            crypto.randomUUID(),
            requestFixture.payload_hash,
            null,
            memberId,
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "blocked", blocker_code: "MISSING_HOMEOWNER_EMAIL" });

    await pg.query(
      "update public.memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
      [memberId, BMH_ORG_ID],
    );
    expect(
      (
        await pg.query<{ outcome: string; blocker_code: string }>(
          "select outcome, blocker_code from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)",
          [
            BMH_ORG_ID,
            propertyId,
            templateId,
            JSON.stringify(requestFixture.signer_snapshot),
            JSON.stringify(requestFixture.merge_value_snapshot),
            crypto.randomUUID(),
            requestFixture.payload_hash,
            null,
            memberId,
          ],
        )
      ).rows[0],
    ).toEqual({
      outcome: "blocked",
      blocker_code: "ACTIVE_MEMBERSHIP_REQUIRED",
    });
    await setRequestRole("authenticated", memberId);
    expect(
      (await pg.query("select id from public.esign_requests")).rows,
    ).toEqual([]);
  });

  it("reconciles provider delivery without partial signer mappings", async () => {
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    const signerId = crypto.randomUUID();
    await setRequestRole("service_role");
    await pg.query(
      `insert into public.esign_request_signers (
         id, org_id, request_id, role_name, signer_order, signer_name, signer_email
       ) values ($1,$2,$3,'Seller',0,'Test Seller','seller@example.com')`,
      [signerId, BMH_ORG_ID, requestId],
    );
    const providerSigners = JSON.stringify([
      {
        role: "Seller",
        order: 0,
        name: "Test Seller",
        emailAddress: "seller@example.com",
        signatureId: "provider-signature-one",
      },
    ]);
    await pg.query(
      "select public.reconcile_esign_request_delivery($1,$2,$3,$4,$5::jsonb)",
      [
        BMH_ORG_ID,
        requestId,
        "provider-request-one",
        "https://app.hellosign.com/home/manage?guid=provider-request-one",
        providerSigners,
      ],
    );
    expect(
      (
        await pg.query(
          `select request.delivery_state, request.sign_request_id,
             signer.provider_signature_id
           from public.esign_requests request
           join public.esign_request_signers signer on signer.request_id = request.id
           where request.id = $1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      delivery_state: "sent",
      sign_request_id: "provider-request-one",
      provider_signature_id: "provider-signature-one",
    });

    const failedRequestId = await seedRequest({ propertyId, templateId });
    const failedSignerId = crypto.randomUUID();
    await pg.query(
      `insert into public.esign_request_signers (
         id, org_id, request_id, role_name, signer_order, signer_name, signer_email
       ) values ($1,$2,$3,'Seller',0,'Test Seller','seller@example.com')`,
      [failedSignerId, BMH_ORG_ID, failedRequestId],
    );
    await pg.query(
      "update public.esign_requests set delivery_state = 'failed', error_message = 'PROVIDER_FAILED' where id = $1",
      [failedRequestId],
    );
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.reconcile_esign_request_delivery($1,$2,$3,$4,$5::jsonb)",
          [
            BMH_ORG_ID,
            failedRequestId,
            "provider-request-failed",
            "https://app.hellosign.com/home/manage?guid=provider-request-failed",
            JSON.stringify([
              {
                role: "Seller",
                order: 0,
                name: "Test Seller",
                emailAddress: "seller@example.com",
                signatureId: "provider-signature-failed",
              },
            ]),
          ],
        ),
      /not awaiting provider reconciliation/i,
    );
    expect(
      (
        await pg.query<{ provider_signature_id: string | null }>(
          "select provider_signature_id from public.esign_request_signers where id = $1",
          [failedSignerId],
        )
      ).rows[0].provider_signature_id,
    ).toBeNull();
    await expectDatabaseError(
      () =>
        pg.query(
          "select public.reconcile_esign_request_delivery($1,$2,$3,$4,$5::jsonb)",
          [
            BMH_ORG_ID,
            failedRequestId,
            "provider-request-one",
            "https://app.hellosign.com/home/manage?guid=provider-request-one",
            providerSigners,
          ],
        ),
      /unique|not awaiting/i,
    );
  });

  it("serializes reminder and void provider calls with recoverable leases", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    const signerId = crypto.randomUUID();
    await setRequestRole("service_role");
    await pg.query(
      `update public.esign_requests
       set delivery_state = 'sent', sign_request_id = 'provider-lease-request', sent_at = now()
       where id = $1`,
      [requestId],
    );
    await pg.query(
      `insert into public.esign_request_signers (
         id, org_id, request_id, role_name, signer_order, signer_name,
         signer_email, provider_signature_id
       ) values ($1,$2,$3,'Seller',0,'Test Seller','seller@example.com','provider-lease-signature')`,
      [signerId, BMH_ORG_ID, requestId],
    );

    const reminderOne = crypto.randomUUID();
    const reminderTwo = crypto.randomUUID();
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, requestId, signerId, reminderOne],
        )
      ).rows[0].outcome,
    ).toBe("claimed");
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, requestId, signerId, reminderTwo],
        )
      ).rows[0].outcome,
    ).toBe("in_progress");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.release_esign_signer_reminder($1,$2,$3,$4) as result",
          [BMH_ORG_ID, requestId, signerId, reminderOne],
        )
      ).rows[0].result,
    ).toBe("released");
    await pg.query("select public.claim_esign_signer_reminder($1,$2,$3,$4)", [
      BMH_ORG_ID,
      requestId,
      signerId,
      reminderTwo,
    ]);
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.finalize_esign_signer_reminder($1,$2,$3,$4) as result",
          [BMH_ORG_ID, requestId, signerId, reminderTwo],
        )
      ).rows[0].result,
    ).toBe("applied");
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, requestId, signerId, crypto.randomUUID()],
        )
      ).rows[0].outcome,
    ).toBe("cooldown");

    await pg.query(
      "update public.esign_request_signers set last_reminded_at = null where id = $1",
      [signerId],
    );
    const staleReminder = crypto.randomUUID();
    const recoveredReminder = crypto.randomUUID();
    await pg.query("select public.claim_esign_signer_reminder($1,$2,$3,$4)", [
      BMH_ORG_ID,
      requestId,
      signerId,
      staleReminder,
    ]);
    await pg.query(
      "update public.esign_request_signers set reminder_claimed_at = now() - interval '10 minutes' where id = $1",
      [signerId],
    );
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, requestId, signerId, recoveredReminder],
        )
      ).rows[0].outcome,
    ).toBe("claimed");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.release_esign_signer_reminder($1,$2,$3,$4) as result",
          [BMH_ORG_ID, requestId, signerId, staleReminder],
        )
      ).rows[0].result,
    ).toBe("lease_lost");
    await pg.query("select public.release_esign_signer_reminder($1,$2,$3,$4)", [
      BMH_ORG_ID,
      requestId,
      signerId,
      recoveredReminder,
    ]);
    const voidLease = crypto.randomUUID();
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_request_void($1,$2,$3)",
          [BMH_ORG_ID, requestId, voidLease],
        )
      ).rows[0].outcome,
    ).toBe("claimed");
    expect(
      (
        await pg.query<{ outcome: string }>(
          "select * from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [BMH_ORG_ID, requestId, signerId, crypto.randomUUID()],
        )
      ).rows[0].outcome,
    ).toBe("in_progress");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.release_esign_request_void($1,$2,$3) as result",
          [BMH_ORG_ID, requestId, voidLease],
        )
      ).rows[0].result,
    ).toBe("released");

    const staleVoidLease = crypto.randomUUID();
    const finalVoidLease = crypto.randomUUID();
    await pg.query("select public.claim_esign_request_void($1,$2,$3)", [
      BMH_ORG_ID,
      requestId,
      staleVoidLease,
    ]);
    await pg.query(
      "update public.esign_requests set void_claimed_at = now() - interval '10 minutes' where id = $1",
      [requestId],
    );
    await pg.query("select public.claim_esign_request_void($1,$2,$3)", [
      BMH_ORG_ID,
      requestId,
      finalVoidLease,
    ]);
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.release_esign_request_void($1,$2,$3) as result",
          [BMH_ORG_ID, requestId, staleVoidLease],
        )
      ).rows[0].result,
    ).toBe("lease_lost");
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.finalize_esign_request_void($1,$2,$3) as result",
          [BMH_ORG_ID, requestId, finalVoidLease],
        )
      ).rows[0].result,
    ).toBe("applied");
    expect(
      (
        await pg.query(
          "select status, void_requested_at is not null as requested from public.esign_requests where id = $1",
          [requestId],
        )
      ).rows[0],
    ).toEqual({ status: "awaiting", requested: true });

    const raceRequestId = await seedRequest({ propertyId, templateId });
    await pg.query(
      `update public.esign_requests
       set delivery_state = 'sent', sign_request_id = 'provider-race-request', sent_at = now()
       where id = $1`,
      [raceRequestId],
    );
    const raceVoidLease = crypto.randomUUID();
    await pg.query("select public.claim_esign_request_void($1,$2,$3)", [
      BMH_ORG_ID,
      raceRequestId,
      raceVoidLease,
    ]);
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const signedReceipt = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_all_signed",
      signRequestId: "provider-race-request",
    });
    expect(
      (
          await pg.query<{ outcome: string; status: string }>(
            `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'awaiting','signed',$5::timestamptz,
             'esign_signed',$6::jsonb
           )`,
          [
            BMH_ORG_ID,
            raceRequestId,
              signedReceipt.receipt_id,
              signedReceipt.lease_id,
              "2026-08-29T20:00:00.000Z",
              JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "signed" });
    expect(
      (
        await pg.query<{ result: string }>(
          "select public.finalize_esign_request_void($1,$2,$3) as result",
          [BMH_ORG_ID, raceRequestId, raceVoidLease],
        )
      ).rows[0].result,
    ).toBe("lease_lost");
    expect(
      (
        await pg.query(
          "select status, void_requested_at from public.esign_requests where id = $1",
          [raceRequestId],
        )
      ).rows[0],
    ).toEqual({ status: "signed", void_requested_at: null });

    await setRequestRole("authenticated", memberId);
    await expectDatabaseError(
      () =>
        pg.query("select * from public.claim_esign_request_void($1,$2,$3)", [
          BMH_ORG_ID,
          requestId,
          crypto.randomUUID(),
        ]),
      /permission denied/i,
    );
  });

  it("moves eSign dependents when duplicate properties merge", async () => {
    const keeperId = await seedProperty();
    const loserId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId: loserId, templateId });
    await setRequestRole("service_role");
    const fileId = requestId;
    const fileName = `signed-contract-${requestId.slice(0, 8)}.pdf`;
    const storagePath = `${BMH_ORG_ID}/${loserId}/esign/${requestId}/signed.pdf`;
    await pg.query(
      `insert into public.lead_files (
         id, org_id, property_id, source_request_id, file_name,
         size_bytes, storage_path
       ) values ($1, $2, $3, $4, $5, 1024, $6)`,
      [fileId, BMH_ORG_ID, loserId, requestId, fileName, storagePath],
    );
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('lead-files',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [storagePath],
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
          "select property_id, storage_path from public.lead_files where source_request_id = $1",
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      property_id: keeperId,
      storage_path: `${BMH_ORG_ID}/${loserId}/esign/${requestId}/signed.pdf`,
    });
    expect(
      (
        await pg.query(
          "select name from storage.objects where bucket_id = 'lead-files'",
        )
      ).rows,
    ).toEqual([
      { name: `${BMH_ORG_ID}/${loserId}/esign/${requestId}/signed.pdf` },
    ]);
    expect(
      (
        await pg.query(
          "select count(*)::int as count from public.properties where id = $1",
          [loserId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("clears all eSign relational rows through the shared reset helper", async () => {
    await connectIntegration();
    const propertyId = await seedProperty();
    const templateId = await seedTemplate();
    const requestId = await seedRequest({ propertyId, templateId });
    await setRequestRole("service_role");
    const fileId = requestId;
    const leadPath = `${BMH_ORG_ID}/${propertyId}/esign/${requestId}/signed.pdf`;
    const fileName = `signed-contract-${requestId.slice(0, 8)}.pdf`;
    await pg.query(
      `insert into public.lead_files (
         id, org_id, property_id, source_request_id, file_name,
         size_bytes, storage_path
       ) values ($1,$2,$3,$4,$5,1024,$6)`,
      [fileId, BMH_ORG_ID, propertyId, requestId, fileName, leadPath],
    );
    await pg.query("select public.reset_tenant_tables()");
    const counts = await pg.query<{ table_name: string; count: number }>(
      `select 'integrations' as table_name, count(*)::int as count
         from public.org_esign_integrations
       union all
       select 'templates', count(*)::int from public.esign_templates
       union all
       select 'staging_sources', count(*)::int from public.esign_template_staging_sources
       union all
       select 'requests', count(*)::int from public.esign_requests
       union all
       select 'files', count(*)::int from public.lead_files
       union all
       select 'receipts', count(*)::int from public.esign_webhook_receipts`,
    );
    expect(counts.rows).toEqual([
      { table_name: "integrations", count: 0 },
      { table_name: "templates", count: 0 },
      { table_name: "staging_sources", count: 0 },
      { table_name: "requests", count: 0 },
      { table_name: "files", count: 0 },
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
    const reset = functions.rows.find(
      (row) => row.name === "reset_tenant_tables",
    );
    const merge = functions.rows.find(
      (row) => row.name === "merge_duplicate_properties",
    );
    expect(reset?.definition).toMatch(/esign_webhook_receipts/);
    expect(reset?.definition).toMatch(/org_esign_integrations/);
    expect(reset?.definition).not.toMatch(/delete from storage\.objects/i);
    const resetHelper = readFileSync("tests/integration/reset.ts", "utf8");
    expect(resetHelper).toMatch(/storage\.emptyBucket\(bucket\)/);
    expect(resetHelper).toContain('"esign-staging"');
    expect(resetHelper).toContain('"lead-files"');
    expect(merge?.definition).toMatch(/update public\.esign_requests/i);
    expect(merge?.definition).toMatch(/update public\.lead_files/i);
  });
});
