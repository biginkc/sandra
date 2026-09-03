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
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import {
  ESIGN_TEST_API_KEY,
  ESIGN_TEST_CALLBACK_HASH,
  ESIGN_TEST_CLIENT_ID,
  ESIGN_TEST_ENCRYPTION_KEY,
  ESIGN_TEST_PROVIDER_ACCOUNT_ID,
} from "@tests/integration/fixtures/esign";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const foundationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");
const atomicDisconnectSql = readFileSync(
  "supabase/migrations/20260902120100_esign_atomic_disconnect_state.sql",
  "utf8",
)
  .replace(/^\s*begin;\s*/i, "")
  .replace(/\s*commit;\s*$/i, "");
const allowTestModeSql = readFileSync(
  "supabase/migrations/20260903070000_esign_safe_event_data_allow_test_mode.sql",
  "utf8",
);

let pg: Client;
let ownerId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return url;
}

async function setServiceRole(): Promise<void> {
  await pg.query("set local role service_role");
  await pg.query(
    "select set_config('request.jwt.claim.role', 'service_role', true)",
  );
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

async function connectIntegration(): Promise<void> {
  await setServiceRole();
  await pg.query(
    `select public.upsert_org_esign_integration(
       $1, $2, right($2, 4), $3, $4, $5, $6, $7
     )`,
    [
      BMH_ORG_ID,
      ESIGN_TEST_API_KEY,
      ESIGN_TEST_CLIENT_ID,
      ESIGN_TEST_PROVIDER_ACCOUNT_ID,
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
  testMode?: boolean | null;
}) {
  const base: Record<string, unknown> = {
    event_time: input.eventTime ?? "1788033600",
    event_type: input.eventType,
    sign_request_id: input.signRequestId ?? null,
    related_signature_id: input.relatedSignatureId ?? null,
    reported_for_app_id:
      input.reportedForAppId === undefined
        ? ESIGN_TEST_CLIENT_ID
        : input.reportedForAppId,
  };
  if (input.testMode !== undefined) {
    base.test_mode = input.testMode;
  }
  return base;
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
  testMode?: boolean | null;
  safeEventDataOverride?: unknown;
}) {
  const eventAt = input.eventAt ?? "2026-08-29T20:00:00.000Z";
  const signRequestId = input.signRequestId ?? null;
  const relatedSignatureId = input.relatedSignatureId ?? null;
  const leaseId = input.leaseId ?? crypto.randomUUID();
  const safeEventData =
    input.safeEventDataOverride ??
    safeWebhookEventData({
      eventTime: String(Math.floor(new Date(eventAt).getTime() / 1000)),
      eventType: input.eventType,
      signRequestId,
      relatedSignatureId,
      reportedForAppId: input.reportedForAppId,
      testMode: input.testMode,
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
    email: `esign-test-mode-owner-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "owner",
  });
  ownerId = owner.userId;

  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
  await pg.query(foundationSql);
  await pg.query(atomicDisconnectSql);
  await pg.query(atomicDisconnectSql);
});

beforeEach(async () => {
  await pg.query("reset role");
  await pg.query("select set_config('request.jwt.claim.role', '', true)");
  await pg.query("savepoint esign_test_mode_case");
});

afterEach(async () => {
  await pg.query("rollback to savepoint esign_test_mode_case");
  await pg.query("release savepoint esign_test_mode_case");
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
  if (ownerId) await serviceClient.auth.admin.deleteUser(ownerId);
  await resetTenantTables(serviceClient);
});

describe("esign_safe_event_data_is_valid allows test_mode", () => {
  it("REGRESSION: pre-migration schema rejects safe event data carrying test_mode", async () => {
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    await expectDatabaseError(
      () =>
        claimWebhookReceipt({
          consumerId: consumer.rows[0].id,
          eventType: "signature_request_signed",
          signRequestId: "req-testmode-pre",
          relatedSignatureId: "sig-testmode-pre",
          testMode: true,
        }),
      /invalid safe event data/i,
    );
  });

  it("after migration: claims a receipt whose safe event data carries test_mode: true", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const claim = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_signed",
      signRequestId: "req-testmode-true",
      relatedSignatureId: "sig-testmode-true",
      testMode: true,
    });
    expect(claim.outcome).toBe("claimed");
    expect(
      (
        await pg.query(
          "select safe_event_data from public.esign_webhook_receipts where id = $1",
          [claim.receipt_id],
        )
      ).rows[0].safe_event_data,
    ).toMatchObject({ test_mode: true });
  });

  it("after migration: claims a receipt whose safe event data carries test_mode: false", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const claim = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_signed",
      signRequestId: "req-testmode-false",
      relatedSignatureId: "sig-testmode-false",
      testMode: false,
    });
    expect(claim.outcome).toBe("claimed");
  });

  it("after migration: claims a receipt whose safe event data carries test_mode: null", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const claim = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_signed",
      signRequestId: "req-testmode-null",
      relatedSignatureId: "sig-testmode-null",
      testMode: null,
    });
    expect(claim.outcome).toBe("claimed");
    expect(
      (
        await pg.query(
          "select safe_event_data from public.esign_webhook_receipts where id = $1",
          [claim.receipt_id],
        )
      ).rows[0].safe_event_data,
    ).toMatchObject({ test_mode: null });
  });

  it("after migration: still accepts the original five-key payload with no test_mode key", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    const claim = await claimWebhookReceipt({
      consumerId: consumer.rows[0].id,
      eventType: "signature_request_viewed",
      signRequestId: "req-five-key",
      relatedSignatureId: "sig-five-key",
    });
    expect(claim.outcome).toBe("claimed");
  });

  it("after migration: rejects test_mode encoded as a string instead of a boolean", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    await expectDatabaseError(
      () =>
        claimWebhookReceipt({
          consumerId: consumer.rows[0].id,
          eventType: "signature_request_signed",
          signRequestId: "req-testmode-string",
          relatedSignatureId: "sig-testmode-string",
          safeEventDataOverride: {
            ...safeWebhookEventData({
              eventType: "signature_request_signed",
              signRequestId: "req-testmode-string",
              relatedSignatureId: "sig-testmode-string",
              eventTime: String(
                Math.floor(
                  new Date("2026-08-29T20:00:00.000Z").getTime() / 1000,
                ),
              ),
            }),
            test_mode: "true",
          },
        }),
      /invalid safe event data/i,
    );
  });

  it("after migration: still rejects an unrelated unknown sixth key", async () => {
    await pg.query(allowTestModeSql);
    await connectIntegration();
    const consumer = await pg.query<{ id: string }>(
      "select id from public.webhook_consumers where consumer_type = 'esign_provider'",
    );
    await expectDatabaseError(
      () =>
        claimWebhookReceipt({
          consumerId: consumer.rows[0].id,
          eventType: "signature_request_signed",
          signRequestId: "req-unknown-key",
          relatedSignatureId: "sig-unknown-key",
          safeEventDataOverride: {
            ...safeWebhookEventData({
              eventType: "signature_request_signed",
              signRequestId: "req-unknown-key",
              relatedSignatureId: "sig-unknown-key",
              eventTime: String(
                Math.floor(
                  new Date("2026-08-29T20:00:00.000Z").getTime() / 1000,
                ),
              ),
            }),
            signer_email: "private@example.com",
          },
        }),
      /invalid safe event data/i,
    );
  });
});
