import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestClient } from "../integration/client";
import { resetTenantTables } from "../integration/reset";
import { BMH_ORG_ID } from "../integration/fixtures/multi-user";
import {
  ensureE2ERunEnvironment,
  identityForPrincipal,
} from "../../src/lib/supabase/e2e-identity-guard";

const forbidden = vi.hoisted(() => ({
  ai: vi.fn(),
  workflow: vi.fn(async () => {
    throw new Error("Workflow dispatch forbidden in this canary proof");
  }),
}));
vi.mock("@/lib/ai-responder/dispatch", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai-responder/dispatch")
  >("@/lib/ai-responder/dispatch");
  return {
    ...actual,
    dispatchAiResponse: forbidden.ai.mockImplementation(
      actual.dispatchAiResponse,
    ),
  };
});
vi.mock("workflow/api", () => ({ start: forbidden.workflow }));
vi.mock("../../scripts/canary-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../scripts/canary-helpers")
  >("../../scripts/canary-helpers");
  const { createTestClient: client } = await import("../integration/client");
  return {
    ...actual,
    env: {
      PROD_EMAIL: process.env.E2E_TEST_USER_EMAIL,
      PROD_ORG_ID: "00000000-0000-0000-0000-000000000bbb",
      PROD_CANARY_SMS_TO: "+12025550102",
      PROD_CANARY_SMS_ALLOWLIST: "+12025550102",
      SENDILLO_FROM_NUMBER: "+12025550101",
    },
    prodSupabase: client,
    pollUntil: async (
      fn: () => Promise<unknown>,
      options: Parameters<typeof actual.pollUntil>[1],
    ) => {
      try {
        return await actual.pollUntil(fn, {
          ...options,
          timeoutMs: Math.min(options?.timeoutMs ?? 5000, 5000),
        });
      } catch (error) {
        console.log("Local proof failed poll:", options?.label);
        for (const [table, columns] of [
          ["consent_events", "event_type,occurred_at,source_detail"],
          ["contacts", "sms_opted_out"],
          ["sequence_enrollments", "status"],
          ["sms_phone_suppressions", "first_contact_id,provider,source_detail"],
        ] as const) {
          const result = await client().from(table).select(columns);
          console.log(table, JSON.stringify(result.data));
        }
        throw error;
      }
    },
    fireSendilloInboundWebhook: async (
      payload: Parameters<typeof actual.fireSendilloInboundWebhook>[0],
    ) => {
      const { POST } = await import(
        "../../src/app/api/webhooks/sendillo/sms/route"
      );
      const response = await POST(
        new Request("https://example.invalid/api/webhooks/sendillo/sms", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sendillo-webhook-secret": "local-proof-secret",
          },
          body: JSON.stringify({
            event: payload.event ?? "inbound.received",
            data: payload.data,
          }),
        }),
      );
      return response.status;
    },
  };
});

const client = createTestClient();
let userId: string | undefined;
let sentinels: Record<string, string> = {};

beforeAll(async () => {
  const identity = identityForPrincipal(ensureE2ERunEnvironment());
  const { data: inventory, error: inventoryError } =
    await client.auth.admin.listUsers();
  expect(inventoryError).toBeNull();
  expect(
    inventory.users,
    "This proof requires an empty task-owned Auth baseline",
  ).toHaveLength(0);
  const { data, error } = await client.auth.admin.createUser({
    email: identity.email,
    password: identity.password,
    email_confirm: true,
    app_metadata: identity.appMetadata,
  });
  expect(error).toBeNull();
  userId = data.user!.id;
  const { error: membershipError } = await client
    .from("memberships")
    .insert({ user_id: userId, org_id: BMH_ORG_ID, role: "owner" });
  expect(membershipError).toBeNull();
});

beforeEach(async () => {
  await resetTenantTables(client);
  vi.resetModules();
  forbidden.ai.mockClear();
  forbidden.workflow.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.TEST_SUPABASE_URL!);
  vi.stubEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!,
  );
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("SENDILLO_API_KEY", "local-proof-not-a-real-key");
  vi.stubEnv("SENDILLO_FROM_NUMBER", "+12025550101");
  vi.stubEnv("SENDILLO_WEBHOOK_SECRET", "local-proof-secret");
  vi.stubEnv("SKIP_INTENT_GATE", "1");
  const contact = await client
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      first_name: "Unrelated synthetic sentinel",
      phone_1: "+12025550109",
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  expect(contact.error).toBeNull();
  const property = await client
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: "Unrelated synthetic sentinel property",
      state: "MO",
      homeowner_contact_id: contact.data!.id,
    })
    .select("id")
    .single();
  expect(property.error).toBeNull();
  const suppression = await client
    .from("sms_phone_suppressions")
    .insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      phone_e164: "+12025550109",
      first_contact_id: contact.data!.id,
      provider: "sendillo",
      source: "local-canary-sentinel",
      source_detail: { externalId: "unrelated-sentinel" },
    })
    .select("id")
    .single();
  expect(suppression.error).toBeNull();
  sentinels = {
    contacts: contact.data!.id,
    properties: property.data!.id,
    sms_phone_suppressions: suppression.data!.id,
  };
});

it.each(["regular", "stop"])(
  "runs the %s smoke against the real local route and leaves no owned fixtures",
  async (mode) => {
    vi.stubEnv("SENDILLO_SMOKE_MODE", mode);
    const { runSendilloWebhookSmoke } = await import(
      "../../scripts/smoke-sendillo-webhook-prod"
    );
    const result = await runSendilloWebhookSmoke({
      disposableLocalStop: mode === "stop",
    });
    expect(result).toMatchObject({ mode, status: "PASS" });
    for (const dispatch of forbidden.ai.mock.results) {
      await expect(dispatch.value).resolves.toMatchObject({
        outcome: "skipped",
      });
    }
    expect(forbidden.workflow.mock.calls.length).toBe(0);
    for (const table of [
      "contacts",
      "properties",
      "messages",
      "notifications",
      "sms_phone_suppressions",
      "sms_inbound_intents",
      "sms_inbound_deliveries",
      "webhook_events",
      "sequence_enrollments",
      "sequence_steps",
      "sequences",
      "consent_events",
      "lead_events",
      "ai_response_claims",
    ] as const) {
      const { data, error } = await client.from(table).select("id");
      expect(error, table).toBeNull();
      expect(data, table).toEqual(
        sentinels[table] ? [{ id: sentinels[table] }] : [],
      );
    }
  },
);

afterAll(async () => {
  vi.unstubAllEnvs();
  // The parent verifies exclusive ownership, restores the initially empty
  // membership baseline under both locks, and invokes exact-run Auth cleanup.
});
