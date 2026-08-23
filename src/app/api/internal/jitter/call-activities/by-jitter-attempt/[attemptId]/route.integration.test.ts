import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  createOrgUser,
} from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  hashSecret,
  jsonRequest,
  resetJitterIntegration,
  seedDialerBatch,
  seedDialerLead,
} from "../../../_lib/test-helpers.integration";
import { PUT } from "./route";

const testClient = createTestClient();

function attemptContext(attemptId: string) {
  return { params: Promise.resolve({ attemptId }) };
}

function writebackBody(seeded: Awaited<ReturnType<typeof seedDialerBatch>>) {
  return {
    org_id: seeded.orgId,
    property_id: seeded.propertyId,
    contact_id: seeded.contactId,
    dialer_batch_item_id: seeded.itemId,
    jitter_session_id: "session-activity",
    provider: "jitter",
    outcome: "connected_human",
    duration_seconds: 91,
  };
}

describe("internal.jitter.call-activities writeback PUT", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        {
          method: "PUT",
          headers: { "idempotency-key": "activity-no-auth" },
          body: "{}",
        },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const raw = JSON.stringify(writebackBody(seeded));
    const response = await PUT(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "activity-bad-hmac",
            }),
          },
          body: raw,
        },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key header is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        writebackBody(seeded),
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key is empty", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        writebackBody(seeded),
        { "idempotency-key": "   " },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 422 on missing required body fields", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        { jitter_session_id: "session-activity" },
        { "idempotency-key": "activity-missing" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "missing_required_field",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", "   "],
  ])(
    "rejects a %s jitter_session_id before reserving idempotency",
    async (_label, jitterSessionId) => {
      const seeded = await seedDialerBatch(testClient);
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const idempotencyKey = `activity-invalid-session-${crypto.randomUUID()}`;
      const body = {
        ...writebackBody(seeded),
        jitter_session_id: jitterSessionId,
      };
      if (jitterSessionId === undefined) delete (body as any).jitter_session_id;

      const response = await PUT(
        jsonRequest(
          `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
          "PUT",
          body,
          { "idempotency-key": idempotencyKey },
        ),
        attemptContext(attemptId),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error_code: "invalid_jitter_session_id",
      });
      const { data: reservations, error } = await (testClient as any)
        .from("webhook_events")
        .select("id")
        .eq("external_id", idempotencyKey);
      expect(error).toBeNull();
      expect(reservations).toHaveLength(0);
    },
  );

  it("inserts a new call_activities row and updates the batch item pointer", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        writebackBody(seeded),
        { "idempotency-key": "activity-insert" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.call_activity).toMatchObject({
      jitter_attempt_id: attemptId,
      jitter_session_id: "session-activity",
      outcome: "connected_human",
      dialer_batch_item_id: seeded.itemId,
    });

    const { data: item } = await (testClient as any)
      .from("dialer_batch_items")
      .select("last_call_activity_id")
      .eq("id", seeded.itemId)
      .single();
    expect(item.last_call_activity_id).toBe(json.call_activity.id);
  });

  it("creates distinct rows when an attempt id is reused in two Jitter sessions", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;

    const first = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...writebackBody(seeded),
          jitter_session_id: "session-run-a",
        },
        { "idempotency-key": "activity-session-a" },
      ),
      attemptContext(attemptId),
    );
    const second = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...writebackBody(seeded),
          jitter_session_id: "session-run-b",
        },
        { "idempotency-key": "activity-session-b" },
      ),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = (await first.json()) as any;
    const secondJson = (await second.json()) as any;
    expect(firstJson.call_activity.id).not.toBe(secondJson.call_activity.id);

    const { data: activities, error } = await (testClient as any)
      .from("call_activities")
      .select("id, jitter_session_id")
      .eq("org_id", seeded.orgId)
      .eq("provider", "jitter")
      .eq("jitter_attempt_id", attemptId)
      .order("jitter_session_id");
    expect(error).toBeNull();
    expect(activities).toEqual([
      { id: firstJson.call_activity.id, jitter_session_id: "session-run-a" },
      { id: secondJson.call_activity.id, jitter_session_id: "session-run-b" },
    ]);
  });

  it("persists notes and recording_path on insert and on update", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;

    const first = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...writebackBody(seeded),
          notes: "Left a voicemail, will retry tomorrow.",
          recording_path: "recordings/2026/08/20/attempt-1.mp3",
        },
        { "idempotency-key": "activity-notes-insert" },
      ),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as any;
    expect(firstJson.call_activity.notes).toBe(
      "Left a voicemail, will retry tomorrow.",
    );
    expect(firstJson.call_activity.recording_path).toBe(
      "recordings/2026/08/20/attempt-1.mp3",
    );

    const { data: row } = await (testClient as any)
      .from("call_activities")
      .select("notes, recording_path")
      .eq("id", firstJson.call_activity.id)
      .single();
    expect(row.notes).toBe("Left a voicemail, will retry tomorrow.");
    expect(row.recording_path).toBe("recordings/2026/08/20/attempt-1.mp3");

    const second = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...writebackBody(seeded),
          notes: "Reached the contact on retry.",
          recording_path: "recordings/2026/08/20/attempt-2.mp3",
        },
        { "idempotency-key": "activity-notes-update" },
      ),
      attemptContext(attemptId),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as any;
    expect(secondJson.call_activity.notes).toBe(
      "Reached the contact on retry.",
    );
    expect(secondJson.call_activity.recording_path).toBe(
      "recordings/2026/08/20/attempt-2.mp3",
    );
  });

  it("accepts a writeback with notes and recording_path absent (backward compatible)", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        writebackBody(seeded),
        { "idempotency-key": "activity-notes-absent" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.call_activity.notes ?? null).toBeNull();
    expect(json.call_activity.recording_path ?? null).toBeNull();
  });

  it("rejects oversized or non-string notes/recording_path before reserving", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const invalidBodies = [
      { notes: 12345 },
      { notes: "x".repeat(10001) },
      { recording_path: 12345 },
      { recording_path: "x".repeat(2049) },
    ];

    for (const [index, invalidBody] of invalidBodies.entries()) {
      const key = `activity-invalid-notes-${index}`;
      const response = await PUT(
        jsonRequest(
          requestUrl,
          "PUT",
          { ...writebackBody(seeded), ...invalidBody },
          { "idempotency-key": key },
        ),
        attemptContext(attemptId),
      );

      expect(response.status).toBe(422);
    }

    const { data: reservations } = await (testClient as any)
      .from("webhook_events")
      .select("external_id")
      .in("external_id", [
        "activity-invalid-notes-0",
        "activity-invalid-notes-1",
        "activity-invalid-notes-2",
        "activity-invalid-notes-3",
      ]);
    expect(reservations).toHaveLength(0);
  });

  it("derives org, property, and contact from dialer_batch_item_id", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          dialer_batch_item_id: seeded.itemId,
          jitter_session_id: "session-activity",
          provider: "jitter",
          outcome: "connected_human",
          duration_seconds: 91,
        },
        { "idempotency-key": "activity-derived-batch-item" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.call_activity).toMatchObject({
      jitter_attempt_id: attemptId,
      outcome: "connected_human",
      dialer_batch_item_id: seeded.itemId,
      property_id: seeded.propertyId,
      contact_id: seeded.contactId,
    });
  });

  it("creates Sandra callback task semantics for callback_requested writeback", async () => {
    const seeded = await seedDialerBatch(testClient);
    const operator = await createOrgUser(testClient, {
      orgId: BMH_ORG_ID,
      email: `jitter-callback-${crypto.randomUUID()}@example.test`,
      role: "member",
    });
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const callbackAt = "2026-05-11T15:30:00.000Z";
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          ...writebackBody(seeded),
          disposition: "callback_requested",
          callback_at: callbackAt,
          operator_user_id: operator.userId,
        },
        { "idempotency-key": "activity-callback-task" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.callback_task.id).toEqual(expect.any(String));

    const { data: property } = await testClient
      .from("properties")
      .select("outreach_dispo, follow_up_at")
      .eq("id", seeded.propertyId)
      .single();
    expect(property).toBeTruthy();
    expect(property).toMatchObject({
      outreach_dispo: "callback_requested",
    });
    expect(new Date(property!.follow_up_at!).toISOString()).toBe(callbackAt);

    const { data: task } = await testClient
      .from("tasks")
      .select("type, status, due_at, assignee_id, related_property_id")
      .eq("id", json.callback_task.id)
      .single();
    expect(task).toBeTruthy();
    expect(task).toMatchObject({
      type: "callback",
      status: "open",
      assignee_id: operator.userId,
      related_property_id: seeded.propertyId,
    });
    expect(new Date(task!.due_at).toISOString()).toBe(callbackAt);
  });

  it("requires callback_at when callback_requested is written back", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          ...writebackBody(seeded),
          disposition: "callback_requested",
        },
        { "idempotency-key": "activity-callback-missing-at" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "callback_at_required",
      field: "callback_at",
    });

    const { data: reservations } = await (testClient as any)
      .from("webhook_events")
      .select("id")
      .eq("external_id", "activity-callback-missing-at");
    expect(reservations).toHaveLength(0);
  });

  it("rejects a non-Jitter provider before reserving the idempotency key", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        { ...writebackBody(seeded), provider: "twilio" },
        { "idempotency-key": "activity-provider-mismatch" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "provider_mismatch",
      field: "provider",
    });
    const { data: reservations } = await (testClient as any)
      .from("webhook_events")
      .select("id")
      .eq("external_id", "activity-provider-mismatch");
    expect(reservations).toHaveLength(0);
  });

  it("rejects UUID, timestamp, and duration cast failures before reserving", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const invalidBodies = [
      { operator_user_id: "not-a-uuid" },
      { started_at: "not-a-timestamp" },
      { duration_seconds: 1.5 },
    ];

    for (const [index, invalidBody] of invalidBodies.entries()) {
      const key = `activity-invalid-cast-${index}`;
      const response = await PUT(
        jsonRequest(
          requestUrl,
          "PUT",
          { ...writebackBody(seeded), ...invalidBody },
          { "idempotency-key": key },
        ),
        attemptContext(attemptId),
      );

      expect(response.status).toBe(422);
    }

    const { data: reservations } = await (testClient as any)
      .from("webhook_events")
      .select("external_id")
      .in("external_id", [
        "activity-invalid-cast-0",
        "activity-invalid-cast-1",
        "activity-invalid-cast-2",
      ]);
    expect(reservations).toHaveLength(0);
  });

  it("updates an existing row for the same provider and jitter_attempt_id", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;

    const first = await PUT(
      jsonRequest(requestUrl, "PUT", writebackBody(seeded), {
        "idempotency-key": "activity-upsert-1",
      }),
      attemptContext(attemptId),
    );
    const second = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        { ...writebackBody(seeded), outcome: "voicemail" },
        { "idempotency-key": "activity-upsert-2" },
      ),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = (await first.json()) as any;
    const secondJson = (await second.json()) as any;
    expect(secondJson.call_activity.id).toBe(firstJson.call_activity.id);
    expect(secondJson.call_activity.outcome).toBe("voicemail");
  });

  it("dedupes via Idempotency-Key and returns the cached body", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;

    const first = await PUT(
      jsonRequest(requestUrl, "PUT", writebackBody(seeded), {
        "idempotency-key": "activity-replay",
      }),
      attemptContext(attemptId),
    );
    const retry = await PUT(
      jsonRequest(requestUrl, "PUT", writebackBody(seeded), {
        "idempotency-key": "activity-replay",
      }),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toStrictEqual(await first.json());
  });

  it("returns 422 when the property is deleted", async () => {
    const seeded = await seedDialerBatch(testClient);
    await testClient
      .from("properties")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", seeded.propertyId);

    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        writebackBody(seeded),
        { "idempotency-key": "activity-deleted-property" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "property_deleted",
    });
  });

  it("returns 403 and writes nothing when the body org differs from the authenticated consumer org", async () => {
    // The seeded webhook consumer belongs to BMH_ORG_ID (webhook_consumers
    // org_id default). Submit internally-consistent org-B ids with that
    // org-A token — the route must refuse to touch org B.
    const otherOrgLead = await seedDialerLead(testClient, {
      org_id: TEST_ORG_B_ID,
    });
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          org_id: otherOrgLead.orgId,
          property_id: otherOrgLead.propertyId,
          contact_id: otherOrgLead.contactId,
          jitter_session_id: "session-activity",
          provider: "jitter",
          outcome: "connected_human",
          disposition: "dnc_request",
          do_not_call_requested: true,
        },
        { "idempotency-key": "activity-cross-org" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
      error_code: "org_consumer_mismatch",
    });

    const { data: activities } = await (testClient as any)
      .from("call_activities")
      .select("id")
      .eq("jitter_attempt_id", attemptId);
    expect(activities).toHaveLength(0);

    const { data: contact } = await testClient
      .from("contacts")
      .select("do_not_contact")
      .eq("id", otherOrgLead.contactId)
      .single();
    expect(contact?.do_not_contact).toBe(false);

    const { data: events } = await testClient
      .from("consent_events")
      .select("id")
      .eq("contact_id", otherOrgLead.contactId);
    expect(events).toHaveLength(0);
  });

  it("creates a separate org-B row when the same attemptId arrives from another org's consumer", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;

    const first = await PUT(
      jsonRequest(requestUrl, "PUT", writebackBody(seeded), {
        "idempotency-key": "activity-collide-org-a",
      }),
      attemptContext(attemptId),
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as any;

    // Second writeback consumer authenticated for org B (mirrors the BMH
    // consumer seeded by resetJitterIntegration).
    const ORG_B_TOKEN = "jitter-route-integration-token-org-b";
    const { error: consumerError } = await (testClient as any)
      .from("webhook_consumers")
      .insert({
        consumer_type: "jitter_writeback",
        name: "jitter-route-tests-org-b",
        secret_hash: hashSecret(ORG_B_TOKEN),
        enabled: true,
        org_id: TEST_ORG_B_ID,
      });
    expect(consumerError).toBeNull();

    const orgBLead = await seedDialerLead(testClient, {
      org_id: TEST_ORG_B_ID,
    });
    const orgBBody = JSON.stringify({
      org_id: orgBLead.orgId,
      property_id: orgBLead.propertyId,
      contact_id: orgBLead.contactId,
      jitter_session_id: "session-activity-org-b",
      provider: "jitter",
      outcome: "voicemail",
    });
    const second = await PUT(
      new Request(requestUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ORG_B_TOKEN}`,
          "x-sandra-signature":
            "sha256=" +
            createHmac("sha256", ORG_B_TOKEN).update(orgBBody).digest("hex"),
          "idempotency-key": "activity-collide-org-b",
        },
        body: orgBBody,
      }),
      attemptContext(attemptId),
    );

    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as any;
    expect(secondJson.call_activity.id).not.toBe(firstJson.call_activity.id);
    expect(secondJson.call_activity).toMatchObject({
      org_id: TEST_ORG_B_ID,
      jitter_attempt_id: attemptId,
      outcome: "voicemail",
    });

    // Org A's original row is unchanged by the colliding writeback.
    const { data: original } = await (testClient as any)
      .from("call_activities")
      .select("org_id, property_id, contact_id, outcome, jitter_attempt_id")
      .eq("id", firstJson.call_activity.id)
      .single();
    expect(original).toMatchObject({
      org_id: BMH_ORG_ID,
      property_id: seeded.propertyId,
      contact_id: seeded.contactId,
      outcome: "connected_human",
      jitter_attempt_id: attemptId,
    });
  });

  it("sets do_not_contact and records a voice opt-out consent event on DNC writeback", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          ...writebackBody(seeded),
          disposition: "dnc_request",
          do_not_call_requested: true,
        },
        { "idempotency-key": "activity-dnc" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);

    const { data: contact } = await testClient
      .from("contacts")
      .select("do_not_contact")
      .eq("id", seeded.contactId)
      .single();
    expect(contact?.do_not_contact).toBe(true);

    // (testClient as any): generated DB types predate the
    // consent_events.source_external_id column added in migration 071.
    const { data: events } = await (testClient as any)
      .from("consent_events")
      .select("channel, event_type, source, source_detail, source_external_id")
      .eq("contact_id", seeded.contactId);
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({
      channel: "voice",
      event_type: "opt_out",
      source: "jitter_writeback",
      source_external_id: `session-activity:${attemptId}`,
    });
    expect(events![0].source_detail).toMatchObject({
      disposition: "dnc_request",
      jitter_session_id: "session-activity",
    });
  });

  it("keeps exactly one consent event when a DNC writeback is replayed", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const body = {
      ...writebackBody(seeded),
      disposition: "dnc_request",
      do_not_call_requested: true,
    };

    const first = await PUT(
      jsonRequest(requestUrl, "PUT", body, {
        "idempotency-key": "activity-dnc-replay-1",
      }),
      attemptContext(attemptId),
    );
    const replay = await PUT(
      jsonRequest(requestUrl, "PUT", body, {
        "idempotency-key": "activity-dnc-replay-2",
      }),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);

    const { data: events } = await testClient
      .from("consent_events")
      .select("id")
      .eq("contact_id", seeded.contactId);
    expect(events).toHaveLength(1);

    const { data: contact } = await testClient
      .from("contacts")
      .select("do_not_contact")
      .eq("id", seeded.contactId)
      .single();
    expect(contact?.do_not_contact).toBe(true);
  });

  it("scopes DNC replay and consent deduplication to the Jitter session", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const dncBody = {
      ...writebackBody(seeded),
      disposition: "dnc_request",
      do_not_call_requested: true,
    };

    const first = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...dncBody,
          jitter_session_id: "session-dnc-a",
        },
        { "idempotency-key": "activity-dnc-session-a" },
      ),
      attemptContext(attemptId),
    );
    const second = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...dncBody,
          jitter_session_id: "session-dnc-b",
        },
        { "idempotency-key": "activity-dnc-session-b" },
      ),
      attemptContext(attemptId),
    );
    const replay = await PUT(
      jsonRequest(
        requestUrl,
        "PUT",
        {
          ...dncBody,
          jitter_session_id: "session-dnc-b",
        },
        { "idempotency-key": "activity-dnc-session-b-replay" },
      ),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstJson = (await first.json()) as any;
    const secondJson = (await second.json()) as any;
    const replayJson = (await replay.json()) as any;
    expect(firstJson.call_activity.id).not.toBe(secondJson.call_activity.id);
    expect(replayJson.call_activity.id).toBe(secondJson.call_activity.id);

    const { data: events, error } = await (testClient as any)
      .from("consent_events")
      .select("source_external_id")
      .eq("contact_id", seeded.contactId)
      .order("source_external_id");
    expect(error).toBeNull();
    expect(events).toEqual([
      { source_external_id: `session-dnc-a:${attemptId}` },
      { source_external_id: `session-dnc-b:${attemptId}` },
    ]);

    const { data: item, error: itemError } = await (testClient as any)
      .from("dialer_batch_items")
      .select("last_call_activity_id")
      .eq("id", seeded.itemId)
      .single();
    expect(itemError).toBeNull();
    expect(item.last_call_activity_id).toBe(firstJson.call_activity.id);
  });

  it("leaves consent and do_not_contact untouched when do_not_call_requested is false", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        { ...writebackBody(seeded), do_not_call_requested: false },
        { "idempotency-key": "activity-no-dnc" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);

    const { data: contact } = await testClient
      .from("contacts")
      .select("do_not_contact")
      .eq("id", seeded.contactId)
      .single();
    expect(contact?.do_not_contact).toBe(false);

    const { data: events } = await testClient
      .from("consent_events")
      .select("id")
      .eq("contact_id", seeded.contactId);
    expect(events).toHaveLength(0);
  });

  it("sets do_not_contact on the contact derived from dialer_batch_item_id", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          dialer_batch_item_id: seeded.itemId,
          jitter_session_id: "session-activity",
          provider: "jitter",
          outcome: "connected_human",
          disposition: "dnc_request",
          do_not_call_requested: true,
        },
        { "idempotency-key": "activity-dnc-derived" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);

    const { data: contact } = await testClient
      .from("contacts")
      .select("do_not_contact")
      .eq("id", seeded.contactId)
      .single();
    expect(contact?.do_not_contact).toBe(true);

    const { data: events } = await testClient
      .from("consent_events")
      .select("channel, event_type, source")
      .eq("contact_id", seeded.contactId);
    expect(events).toHaveLength(1);
  });

  it("returns 422 when org_id mismatches the property", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`,
        "PUT",
        {
          ...writebackBody(seeded),
          org_id: "00000000-0000-0000-0000-000000000ccc",
        },
        { "idempotency-key": "activity-org-mismatch" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_mismatch",
      field: "property_id",
    });
  });

  it("keeps one call_activity row for two identical concurrent writebacks", async () => {
    const seeded = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const body = writebackBody(seeded);

    const responses = await Promise.all([
      PUT(
        jsonRequest(requestUrl, "PUT", body, {
          "idempotency-key": "activity-race-a",
        }),
        attemptContext(attemptId),
      ),
      PUT(
        jsonRequest(requestUrl, "PUT", body, {
          "idempotency-key": "activity-race-b",
        }),
        attemptContext(attemptId),
      ),
    ]);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const { data: activities } = await (testClient as any)
      .from("call_activities")
      .select("id, org_id, provider, jitter_attempt_id, raw_event_count")
      .eq("org_id", seeded.orgId)
      .eq("provider", "jitter")
      .eq("jitter_session_id", "session-activity")
      .eq("jitter_attempt_id", attemptId);
    expect(activities).toHaveLength(1);
    expect(activities?.[0]?.raw_event_count).toBe(2);
  });

  it("atomically rejects conflicting first writes for one session-scoped attempt", async () => {
    const firstLead = await seedDialerBatch(testClient);
    const secondLead = await seedDialerBatch(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const requestUrl = `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}`;
    const sessionId = "session-conflicting-first-write";

    const responses = await Promise.all([
      PUT(
        jsonRequest(
          requestUrl,
          "PUT",
          { ...writebackBody(firstLead), jitter_session_id: sessionId },
          { "idempotency-key": "activity-conflicting-first-a" },
        ),
        attemptContext(attemptId),
      ),
      PUT(
        jsonRequest(
          requestUrl,
          "PUT",
          { ...writebackBody(secondLead), jitter_session_id: sessionId },
          { "idempotency-key": "activity-conflicting-first-b" },
        ),
        attemptContext(attemptId),
      ),
    ]);

    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(responses.filter(({ status }) => status >= 400)).toHaveLength(1);

    const { data: activities, error } = await (testClient as any)
      .from("call_activities")
      .select("property_id, contact_id, dialer_batch_item_id")
      .eq("org_id", firstLead.orgId)
      .eq("provider", "jitter")
      .eq("jitter_session_id", sessionId)
      .eq("jitter_attempt_id", attemptId);
    expect(error).toBeNull();
    expect(activities).toHaveLength(1);
    expect([
      {
        property_id: firstLead.propertyId,
        contact_id: firstLead.contactId,
        dialer_batch_item_id: firstLead.itemId,
      },
      {
        property_id: secondLead.propertyId,
        contact_id: secondLead.contactId,
        dialer_batch_item_id: secondLead.itemId,
      },
    ]).toContainEqual(activities![0]);
  });
});
