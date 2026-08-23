import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  context,
  jsonRequest,
  resetJitterIntegration,
  seedCallActivity,
  sleep,
} from "../../../_lib/test-helpers.integration";
import { POST } from "./route";

const testClient = createTestClient();

async function parent(callActivityId: string) {
  const { data, error } = await (testClient as any)
    .from("call_activities")
    .select("recording_status, updated_at")
    .eq("id", callActivityId)
    .single();
  if (error || !data) throw error ?? new Error("missing parent call activity");
  return data as { recording_status: string; updated_at: string };
}

describe("internal.jitter.call-activities recordings POST", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await POST(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        {
          method: "POST",
          headers: { "idempotency-key": "recording-no-auth" },
          body: "{}",
        },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const seeded = await seedCallActivity(testClient);
    const raw = JSON.stringify({ status: "pending" });
    const response = await POST(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "recording-bad-hmac",
            }),
          },
          body: raw,
        },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key header is missing", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        { status: "pending" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 422 on missing required body fields", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        {},
        { "idempotency-key": "recording-missing-status" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "status" });
  });

  it("rejects malformed and impossible recording payloads before reservation", async () => {
    const seeded = await seedCallActivity(testClient);
    const routeUrl = `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`;
    const malformedKey = "recording-malformed";
    const malformedBody = "{";
    const malformed = await POST(
      new Request(routeUrl, {
        method: "POST",
        headers: authHeaders(malformedBody, {
          "content-type": "application/json",
          "idempotency-key": malformedKey,
        }),
        body: malformedBody,
      }),
      context(seeded.callActivityId),
    );
    const missingPathKey = "recording-available-missing-path";
    const missingPath = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        { status: "available" },
        { "idempotency-key": missingPathKey },
      ),
      context(seeded.callActivityId),
    );
    const overflowKey = "recording-duration-overflow";
    const overflow = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        {
          status: "available",
          storage_path: "calls/overflow.wav",
          duration_seconds: 2_147_483_648,
        },
        { "idempotency-key": overflowKey },
      ),
      context(seeded.callActivityId),
    );

    expect(malformed.status).toBe(422);
    expect(missingPath.status).toBe(422);
    await expect(missingPath.json()).resolves.toMatchObject({
      field: "storage_path",
    });
    expect(overflow.status).toBe(422);
    await expect(overflow.json()).resolves.toMatchObject({
      field: "duration_seconds",
    });
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .in("external_id", [malformedKey, missingPathKey, overflowKey]);
    expect(events).toHaveLength(0);
  });

  it("returns 422 if call_activity_id is not found", async () => {
    const id = crypto.randomUUID();
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${id}/recordings`,
        "POST",
        { status: "pending" },
        { "idempotency-key": "recording-missing-parent" },
      ),
      context(id),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      field: "call_activity_id",
    });
  });

  it("denies an org-A token from reading or mutating an org-B activity", async () => {
    const seeded = await seedCallActivity(testClient, {
      org_id: TEST_ORG_B_ID,
    });
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        { status: "available", storage_path: "foreign.mp3" },
        { "idempotency-key": "recording-cross-org" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      field: "call_activity_id",
    });
    const { data: recordings } = await testClient
      .from("call_recordings")
      .select("id")
      .eq("call_activity_id", seeded.callActivityId);
    expect(recordings).toHaveLength(0);
  });

  it("rejects a same-org non-Jitter activity before reserving idempotency", async () => {
    const seeded = await seedCallActivity(testClient);
    const key = "recording-non-jitter";
    const { error } = await testClient
      .from("call_activities")
      .update({ provider: "twilio" })
      .eq("id", seeded.callActivityId);
    expect(error).toBeNull();
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        { status: "pending" },
        { "idempotency-key": key },
      ),
      context(seeded.callActivityId),
    );
    expect(response.status).toBe(422);
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .eq("external_id", key);
    expect(events).toHaveLength(0);
  });

  it("refuses a reused idempotency key with a different recording body", async () => {
    const seeded = await seedCallActivity(testClient);
    const url = `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`;
    const first = await POST(
      jsonRequest(
        url,
        "POST",
        { status: "pending" },
        { "idempotency-key": "recording-conflict" },
      ),
      context(seeded.callActivityId),
    );
    const second = await POST(
      jsonRequest(
        url,
        "POST",
        { status: "failed" },
        { "idempotency-key": "recording-conflict" },
      ),
      context(seeded.callActivityId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error_code: "idempotency_key_reused",
    });
    const { data: recording } = await testClient
      .from("call_recordings")
      .select("status")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(recording?.status).toBe("pending");
  });

  it("inserts a call_recordings row for an existing call_activity", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        {
          status: "available",
          storage_path: "recordings/test-call.mp3",
          duration_seconds: 72,
        },
        { "idempotency-key": "recording-insert" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recording: {
        call_activity_id: seeded.callActivityId,
        status: "available",
        storage_path: "recordings/test-call.mp3",
      },
    });
  });

  it("trigger fan-out advances parent updated_at and sets recording_status on insert and update", async () => {
    const seeded = await seedCallActivity(testClient);
    const url = `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`;
    const before = await parent(seeded.callActivityId);

    await sleep(20);
    const pending = await POST(
      jsonRequest(
        url,
        "POST",
        { status: "pending" },
        {
          "idempotency-key": "recording-trigger-pending",
        },
      ),
      context(seeded.callActivityId),
    );
    expect(pending.status).toBe(200);
    const afterPending = await parent(seeded.callActivityId);
    expect(afterPending.recording_status).toBe("pending");
    expect(new Date(afterPending.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );

    await sleep(20);
    const available = await POST(
      jsonRequest(
        url,
        "POST",
        { status: "available", storage_path: "calls/trigger.wav" },
        { "idempotency-key": "recording-trigger-available" },
      ),
      context(seeded.callActivityId),
    );
    expect(available.status).toBe(200);
    const afterAvailable = await parent(seeded.callActivityId);
    expect(afterAvailable.recording_status).toBe("available");
    expect(new Date(afterAvailable.updated_at).getTime()).toBeGreaterThan(
      new Date(afterPending.updated_at).getTime(),
    );
  });

  it("trigger fan-out sets parent recording_status to failed", async () => {
    const seeded = await seedCallActivity(testClient);
    await sleep(20);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/recordings`,
        "POST",
        { status: "failed", error_code: "provider_error" },
        { "idempotency-key": "recording-trigger-failed" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(200);
    const after = await parent(seeded.callActivityId);
    expect(after.recording_status).toBe("failed");
  });
});
