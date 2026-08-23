import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import { computeJitterRequestHash } from "../../../../_lib/auth";
import {
  jsonRequest,
  resetJitterIntegration,
  seedCallActivity,
} from "../../../../_lib/test-helpers.integration";
import { POST } from "./route";

const testClient = createTestClient();

function context(attemptId: string) {
  return { params: Promise.resolve({ attemptId }) };
}

function url(attemptId: string) {
  return `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}/recordings`;
}

describe("internal.jitter.call-activities by-attempt recordings POST", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("rejects requests without Jitter authentication", async () => {
    const response = await POST(
      new Request(url("missing-auth"), {
        method: "POST",
        headers: { "idempotency-key": "by-attempt-recording-no-auth" },
        body: "{}",
      }),
      context("missing-auth"),
    );

    expect(response.status).toBe(401);
  });

  it("requires an idempotency key", async () => {
    const response = await POST(
      jsonRequest(url("missing-key"), "POST", { status: "pending" }),
      context("missing-key"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("validates status before resolving the parent", async () => {
    const response = await POST(
      jsonRequest(
        url("invalid-status"),
        "POST",
        { status: "uploaded" },
        { "idempotency-key": "by-attempt-recording-invalid" },
      ),
      context("invalid-status"),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "status" });
  });

  it("rejects invalid metadata before reserving the idempotency key", async () => {
    const seeded = await seedCallActivity(testClient);
    const idempotencyKey = "by-attempt-recording-invalid-metadata";
    const response = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        { status: "available", duration_seconds: -1 },
        { "idempotency-key": idempotencyKey },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      field: "duration_seconds",
    });
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .eq("external_id", idempotencyKey);
    expect(events).toHaveLength(0);
  });

  it("returns the retryable 404 contract when the parent is missing", async () => {
    const attemptId = `missing-${crypto.randomUUID()}`;
    const response = await POST(
      jsonRequest(
        url(attemptId),
        "POST",
        { status: "available", storage_path: "calls/missing.wav" },
        { "idempotency-key": "by-attempt-recording-missing" },
      ),
      context(attemptId),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      error_code: "call_activity_not_found",
    });
  });

  it("does not resolve another organization's matching attempt", async () => {
    const seeded = await seedCallActivity(testClient, {
      org_id: TEST_ORG_B_ID,
    });
    const response = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        { status: "available", storage_path: "calls/foreign.wav" },
        { "idempotency-key": "by-attempt-recording-cross-org" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(404);
    const { data } = await testClient
      .from("call_recordings")
      .select("id")
      .eq("call_activity_id", seeded.callActivityId);
    expect(data).toHaveLength(0);
  });

  it("does not resolve a same-org non-Jitter activity", async () => {
    const seeded = await seedCallActivity(testClient);
    const { error } = await testClient
      .from("call_activities")
      .update({ provider: "twilio" })
      .eq("id", seeded.callActivityId);
    expect(error).toBeNull();

    const response = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        { status: "available", storage_path: "calls/wrong-provider.wav" },
        { "idempotency-key": "by-attempt-recording-wrong-provider" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(404);
    const { data } = await testClient
      .from("call_recordings")
      .select("id")
      .eq("call_activity_id", seeded.callActivityId);
    expect(data).toHaveLength(0);
  });

  it("writes the recording to the resolved call activity", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        {
          status: "available",
          storage_path: "calls/by-attempt.wav",
          duration_seconds: 45,
        },
        { "idempotency-key": "by-attempt-recording-fresh" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recording: {
        call_activity_id: seeded.callActivityId,
        status: "available",
        storage_path: "calls/by-attempt.wav",
        duration_seconds: 45,
      },
    });
  });

  it("returns the cached payload for an identical replay", async () => {
    const seeded = await seedCallActivity(testClient);
    const body = { status: "available", storage_path: "calls/cached.wav" };
    const headers = { "idempotency-key": "by-attempt-recording-cached" };
    const first = await POST(
      jsonRequest(url(seeded.jitterAttemptId), "POST", body, headers),
      context(seeded.jitterAttemptId),
    );
    const firstPayload = await first.json();
    const replay = await POST(
      jsonRequest(url(seeded.jitterAttemptId), "POST", body, headers),
      context(seeded.jitterAttemptId),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstPayload);
  });

  it("resumes a matching pending idempotency reservation", async () => {
    const seeded = await seedCallActivity(testClient);
    const body = { status: "available", storage_path: "calls/retry.wav" };
    const idempotencyKey = "by-attempt-recording-retry";
    const requestHash = computeJitterRequestHash({
      route: "call_recording_writeback",
      resourceId: seeded.callActivityId,
      payload: body,
    });
    const { error } = await testClient.from("webhook_events").insert({
      org_id: seeded.orgId,
      provider: "jitter",
      event_type: "call_recording_writeback",
      external_id: idempotencyKey,
      signature_verified: true,
      payload: body,
      request_hash: requestHash,
      processing_status: "pending",
    } as never);
    expect(error).toBeNull();

    const response = await POST(
      jsonRequest(url(seeded.jitterAttemptId), "POST", body, {
        "idempotency-key": idempotencyKey,
      }),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(200);
    const { data: event } = await testClient
      .from("webhook_events")
      .select("processing_status")
      .eq("external_id", idempotencyKey)
      .single();
    expect(event?.processing_status).toBe("processed");
  });

  it("rejects a reused idempotency key with a drifted body", async () => {
    const seeded = await seedCallActivity(testClient);
    const headers = { "idempotency-key": "by-attempt-recording-conflict" };
    const first = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        { status: "pending" },
        headers,
      ),
      context(seeded.jitterAttemptId),
    );
    const conflict = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        { status: "failed" },
        headers,
      ),
      context(seeded.jitterAttemptId),
    );

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error_code: "idempotency_key_reused",
    });
  });
});
