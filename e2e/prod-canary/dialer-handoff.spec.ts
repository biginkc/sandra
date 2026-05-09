import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { checkQuietHours, STATE_TO_TZ } from "../../src/lib/messaging/quiet-hours";
import type { Database } from "../../src/lib/supabase/types";

import {
  deleteCanaryContactsByLastName,
  deleteCanaryDialerArtifactsByBatchTitle,
  deleteCanaryPropertiesByAddressPrefix,
  deleteCanaryWebhookConsumersByName,
  deleteCanaryWebhookEventsByExternalIds,
  fetchSingleUntypedRow,
  insertCanaryJitterWebhookConsumer,
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  signCanaryJson,
} from "./support";

function callableStateForNow(): string {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return "HI";
}

function e164FromToken(token: string): string {
  const digits = token.replace(/\D/g, "").padEnd(7, "0").slice(-7);
  return `+1816${digits}`;
}

async function resolveAuthUserId(
  client: SupabaseClient<Database>,
  email: string,
): Promise<string> {
  const { data, error } = await client.auth.admin.listUsers();
  if (error) {
    throw new Error(`Could not list production canary auth users: ${error.message}`);
  }

  const user = data.users.find(
    (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    throw new Error(`Could not resolve production canary user id for ${email}.`);
  }
  return user.id;
}

async function resolvePrimaryMembershipOrgId(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const { data, error } = await client
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .limit(2);
  if (error) {
    throw new Error(`Could not resolve production canary membership: ${error.message}`);
  }
  if (!data || data.length !== 1) {
    throw new Error(
      `Expected exactly one production canary membership, found ${data?.length ?? 0}.`,
    );
  }
  return data[0].org_id;
}

async function signedRequest(
  url: string,
  input: {
    method: "GET" | "POST" | "PUT";
    token: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<Response> {
  const rawBody = input.body === undefined ? "" : JSON.stringify(input.body);
  return fetch(url, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-sandra-signature": signCanaryJson(rawBody, input.token),
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
    },
    body: input.method === "GET" ? undefined : rawBody,
  });
}

test("production canary creates a dialer batch and accepts signed Jitter writeback", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const canaryUserId = await resolveAuthUserId(supabase, env.email);
  const orgId = await resolvePrimaryMembershipOrgId(supabase, canaryUserId);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Dialer ${token}`;
  const address = `${prefix} 901 Call St`;
  const contactLastName = `${prefix} Contact`;
  const batchTitle = `${prefix} Batch`;
  const consumerName = `${prefix} Jitter Consumer`;
  const jitterToken = `${prefix} Token ${crypto.randomUUID()}`;
  const jitterSessionId = `${prefix} Session`;
  const attemptId = `${prefix} Attempt`;
  const claimKey = `${prefix} claim`;
  const writebackKey = `${prefix} writeback`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryWebhookEventsByExternalIds(supabase, [claimKey, writebackKey]);
  await deleteCanaryWebhookConsumersByName(supabase, consumerName);
  await deleteCanaryDialerArtifactsByBatchTitle(supabase, batchTitle);
  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        contact_type: "person",
        do_not_contact: false,
        first_name: "PROD-CANARY",
        last_name: contactLastName,
        org_id: orgId,
        phone_1: e164FromToken(token),
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();
    expect(contact?.id).toEqual(expect.any(String));

    const prospect = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        cass_status: "verified",
        homeowner_contact_id: contact!.id,
        org_id: orgId,
        state: callableStateForNow(),
        status: "prospect",
      },
    });

    await insertCanaryJitterWebhookConsumer(supabase, {
      name: consumerName,
      orgId,
      token: jitterToken,
    });

    await page.goto("/properties");
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByTestId("prospects-search").fill(token);
    await expect(page.getByText(address)).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("checkbox", { name: "Select all prospects on this page" })
      .check();
    await page.getByRole("button", { name: /actions for 1 selected/i }).click();
    await page.getByRole("menuitem", { name: "Create dialer batch" }).click();
    await expect(
      page.getByRole("dialog", { name: "Create dialer batch" }),
    ).toBeVisible();
    await expect(page.getByText("1 callable")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Batch title").fill(batchTitle);
    await page.getByRole("button", { name: "Create batch" }).click();

    const batch = await pollUntil(
      async () => {
        const row = await fetchSingleUntypedRow(
          supabase,
          "dialer_batches",
          "id, title, status, source_kind",
          { column: "title", value: batchTitle },
        ).catch(() => null);
        return row?.status === "pending" ? row : null;
      },
      { label: "canary dialer batch", timeoutMs: 30_000 },
    );

    const batchUrl = `${env.baseURL}/api/internal/jitter/dialer-batches/${batch.id}`;
    const getResponse = await signedRequest(`${batchUrl}?include=items`, {
      method: "GET",
      token: jitterToken,
    });
    expect(getResponse.status).toBe(200);
    const getJson = (await getResponse.json()) as {
      batch: { id: string; status: string };
      items: Array<{ id: string; property_id: string; contact_id: string }>;
    };
    expect(getJson.batch).toMatchObject({ id: String(batch.id), status: "pending" });
    expect(getJson.items).toHaveLength(1);
    expect(getJson.items[0]).toMatchObject({
      property_id: prospect.id,
      contact_id: contact!.id,
    });

    const claimResponse = await signedRequest(`${batchUrl}/claim`, {
      method: "POST",
      token: jitterToken,
      body: { jitter_session_id: jitterSessionId },
      idempotencyKey: claimKey,
    });
    expect(claimResponse.status).toBe(200);
    await expect(claimResponse.json()).resolves.toMatchObject({
      batch: { id: String(batch.id), status: "claimed", jitter_session_id: jitterSessionId },
    });

    const item = getJson.items[0];
    const startedAt = new Date().toISOString();
    const writebackResponse = await signedRequest(
      `${env.baseURL}/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
      {
        method: "PUT",
        token: jitterToken,
        body: {
          contact_id: contact!.id,
          dialer_batch_item_id: item.id,
          duration_seconds: 97,
          jitter_session_id: jitterSessionId,
          org_id: orgId,
          outcome: "connected_human",
          provider: "jitter",
          property_id: prospect.id,
          started_at: startedAt,
        },
        idempotencyKey: writebackKey,
      },
    );
    expect(writebackResponse.status).toBe(200);
    await expect(writebackResponse.json()).resolves.toMatchObject({
      call_activity: {
        contact_id: contact!.id,
        dialer_batch_item_id: item.id,
        jitter_attempt_id: attemptId,
        outcome: "connected_human",
        property_id: prospect.id,
      },
    });

    await pollUntil(
      async () => {
        const activity = await fetchSingleUntypedRow(
          supabase,
          "call_activities",
          "id, outcome, dialer_batch_item_id",
          { column: "jitter_attempt_id", value: attemptId },
        ).catch(() => null);
        return activity?.outcome === "connected_human" ? activity : null;
      },
      { label: "canary call activity writeback", timeoutMs: 30_000 },
    );

    await page.goto(`/leads/${prospect.id}`);
    await expect(page.getByRole("region", { name: "Calls" })).toContainText(
      "1 call",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("latest-outcome-badge")).toHaveText("Connected");
  } finally {
    await deleteCanaryWebhookEventsByExternalIds(supabase, [claimKey, writebackKey]);
    await deleteCanaryWebhookConsumersByName(supabase, consumerName);
    await deleteCanaryDialerArtifactsByBatchTitle(supabase, batchTitle);
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
    await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
