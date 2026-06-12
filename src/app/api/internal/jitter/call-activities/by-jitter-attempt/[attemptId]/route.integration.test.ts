import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  createOrgUser,
} from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
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
        {},
        { "idempotency-key": "activity-missing" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "missing_required_field",
    });
  });

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
    const otherOrgLead = await seedDialerLead(testClient, { org_id: TEST_ORG_B_ID });
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
      source_external_id: attemptId,
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
      jsonRequest(requestUrl, "PUT", body, { "idempotency-key": "activity-dnc-replay-1" }),
      attemptContext(attemptId),
    );
    const replay = await PUT(
      jsonRequest(requestUrl, "PUT", body, { "idempotency-key": "activity-dnc-replay-2" }),
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
        { ...writebackBody(seeded), org_id: "00000000-0000-0000-0000-000000000ccc" },
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
});
