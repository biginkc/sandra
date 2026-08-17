import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
const createdAuthUsers: string[] = [];
const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => testClient,
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>(
    "next/server",
  );
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      afterCallbacks.push(fn);
    },
  };
});

vi.mock("@slack/web-api", () => ({
  WebClient: function MockWebClient() {
    return {
      chat: { update: vi.fn(async () => ({ ok: true })) },
      conversations: { open: vi.fn() },
    };
  },
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { upsertOAuthToken } from "@/lib/integrations/tokens/store";
import { POST } from "./route";

const signingSecret = "integration-slack-signing-secret";

async function createAuthUser(email: string): Promise<string> {
  const uniqueEmail = email.replace("@", `-${crypto.randomUUID()}@`);
  const { data, error } = await testClient.auth.admin.createUser({
    email: uniqueEmail,
    password: `test-pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser(${uniqueEmail}) failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  const { error: membershipError } = await testClient.from("memberships").insert({
    org_id: await getOrgId(),
    user_id: data.user.id,
    role: "member",
    access_status: "active",
  });
  if (membershipError) {
    throw new Error(
      `createAuthUser(${uniqueEmail}) membership failed: ${membershipError.message}`,
    );
  }
  return data.user.id;
}

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(testClient);
}

async function seedProperty(): Promise<string> {
  const { data, error } = await testClient
    .from("properties")
    .insert({ address: "123 Slack Webhook Ln", state: "MO", status: "prospect" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed property failed");
  return data.id;
}

async function seedTask(assigneeId: string): Promise<string> {
  const orgId = await getOrgId();
  const propertyId = await seedProperty();
  const { data, error } = await testClient
    .from("tasks")
    .insert({
      org_id: orgId,
      assignee_id: assigneeId,
      related_property_id: propertyId,
      type: "callback",
      title: "Call owner",
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_by: assigneeId,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed task failed");
  return data.id;
}

function signedSlackRequest(payload: unknown): Request {
  const timestamp = "1710000000";
  const rawBody = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  return new Request("https://sandra.test/api/webhooks/slack/actions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function payloadFor(taskId: string, slackUserId: string) {
  return {
    type: "block_actions",
    team: { id: "T_TEST" },
    user: { id: slackUserId, name: "Jarrad" },
    channel: { id: "D123" },
    message: { ts: "1710000000.000100" },
    actions: [{ action_id: "mark_done", value: taskId }],
  };
}

describe("webhooks/slack/actions route integration", () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date("2024-03-09T16:00:00.000Z"));
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "integration-oauth-key");
    afterCallbacks.length = 0;
    await resetTenantTables(testClient);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const id of createdAuthUsers) {
      await testClient.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  it("Mark Done updates tasks.status to completed for the right task", async () => {
    const assigneeId = await createAuthUser(
      `slack-right-${Date.now()}@test.invalid`,
    );
    await upsertOAuthToken({
      userId: assigneeId,
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-right",
      refreshToken: null,
      accessTokenExpiresAt: null,
      scopes: ["chat:write"],
      externalAccountId: "U_TEST",
    });
    const taskId = await seedTask(assigneeId);

    const response = await POST(signedSlackRequest(payloadFor(taskId, "U_TEST")));
    expect(response.status).toBe(200);
    await afterCallbacks[0]?.();

    const { data } = await testClient
      .from("tasks")
      .select("status, completed_by")
      .eq("id", taskId)
      .single();
    expect(data).toMatchObject({
      status: "completed",
      completed_by: assigneeId,
    });
  });

  it("does not allow completing a task assigned to a different user", async () => {
    const assigneeId = await createAuthUser(
      `slack-owner-${Date.now()}@test.invalid`,
    );
    const otherId = await createAuthUser(
      `slack-other-${Date.now()}@test.invalid`,
    );
    await upsertOAuthToken({
      userId: assigneeId,
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-owner",
      refreshToken: null,
      accessTokenExpiresAt: null,
      scopes: ["chat:write"],
      externalAccountId: "U_TEST",
    });
    await upsertOAuthToken({
      userId: otherId,
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-other",
      refreshToken: null,
      accessTokenExpiresAt: null,
      scopes: ["chat:write"],
      externalAccountId: "U_OTHER",
    });
    const taskId = await seedTask(assigneeId);

    const response = await POST(signedSlackRequest(payloadFor(taskId, "U_OTHER")));
    expect(response.status).toBe(200);
    await afterCallbacks[0]?.();

    const { data } = await testClient
      .from("tasks")
      .select("status, completed_by")
      .eq("id", taskId)
      .single();
    expect(data).toMatchObject({
      status: "open",
      completed_by: null,
    });
  });
});
