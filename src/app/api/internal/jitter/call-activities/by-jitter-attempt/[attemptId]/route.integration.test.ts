import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";

import {
  authHeaders,
  jsonRequest,
  resetJitterIntegration,
  seedDialerBatch,
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
