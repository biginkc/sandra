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

function url(attemptId: string, scopeId = "scope-default") {
  return `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}/recordings?scopeId=${encodeURIComponent(scopeId)}`;
}

function effectiveKey(scopeId: string, key: string) {
  return `${scopeId.length}:${scopeId}:${key}`;
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

  it("requires a scope id after authentication", async () => {
    const attemptId = "missing-scope";
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}/recordings`,
        "POST",
        { status: "pending" },
        { "idempotency-key": "by-attempt-recording-missing-scope" },
      ),
      context(attemptId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "scope_id_required",
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
        { status: "available", storage_path: "   " },
        { "idempotency-key": idempotencyKey },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      field: "storage_path",
    });
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .eq("external_id", effectiveKey(seeded.jitterSessionId, idempotencyKey));
    expect(events).toHaveLength(0);
  });

  it("rejects durations outside PostgreSQL integer range without a reservation", async () => {
    const seeded = await seedCallActivity(testClient);
    const idempotencyKey = "by-attempt-recording-duration-overflow";
    const response = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "POST",
        {
          status: "available",
          storage_path: "calls/overflow.wav",
          duration_seconds: 2_147_483_648,
        },
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
      .eq("external_id", effectiveKey(seeded.jitterSessionId, idempotencyKey));
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

  it("resolves duplicate attempt ids only within the requested scope", async () => {
    const attemptId = `attempt-shared-${crypto.randomUUID()}`;
    const first = await seedCallActivity(testClient, {
      attemptId,
      sessionId: "scope-first",
    });
    const second = await seedCallActivity(testClient, {
      attemptId,
      sessionId: "scope-second",
    });

    const response = await POST(
      jsonRequest(
        url(attemptId, first.jitterSessionId),
        "POST",
        { status: "available", storage_path: "calls/scoped.wav" },
        {
          "idempotency-key": `${first.jitterSessionId}:${attemptId}:recording`,
        },
      ),
      context(attemptId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recording: { call_activity_id: first.callActivityId },
    });
    const { data: wrongScopeRows } = await testClient
      .from("call_recordings")
      .select("id")
      .eq("call_activity_id", second.callActivityId);
    expect(wrongScopeRows).toHaveLength(0);
  });

  it("accepts the same caller key for the same attempt in different scopes", async () => {
    const attemptId = `attempt-shared-key-${crypto.randomUUID()}`;
    const first = await seedCallActivity(testClient, {
      attemptId,
      sessionId: "scope-key-first",
    });
    const second = await seedCallActivity(testClient, {
      attemptId,
      sessionId: "scope-key-second",
    });
    const key = `${attemptId}:recording`;

    const responses = await Promise.all([
      POST(
        jsonRequest(
          url(attemptId, first.jitterSessionId),
          "POST",
          { status: "available", storage_path: "calls/first.wav" },
          { "idempotency-key": key },
        ),
        context(attemptId),
      ),
      POST(
        jsonRequest(
          url(attemptId, second.jitterSessionId),
          "POST",
          { status: "available", storage_path: "calls/second.wav" },
          { "idempotency-key": key },
        ),
        context(attemptId),
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const { data: events } = await testClient
      .from("webhook_events")
      .select("external_id")
      .in("external_id", [
        effectiveKey(first.jitterSessionId, key),
        effectiveKey(second.jitterSessionId, key),
      ]);
    expect(events).toHaveLength(2);
  });

  it("serializes concurrent distinct-key first writes into one recording", async () => {
    const seeded = await seedCallActivity(testClient);
    const bodies = [
      { status: "available", storage_path: "calls/concurrent-a.wav" },
      { status: "available", storage_path: "calls/concurrent-b.wav" },
    ];
    const keys = ["recording-concurrent-a", "recording-concurrent-b"];
    const responses = await Promise.all([
      POST(
        jsonRequest(
          url(seeded.jitterAttemptId, seeded.jitterSessionId),
          "POST",
          bodies[0],
          { "idempotency-key": keys[0] },
        ),
        context(seeded.jitterAttemptId),
      ),
      POST(
        jsonRequest(
          url(seeded.jitterAttemptId, seeded.jitterSessionId),
          "POST",
          bodies[1],
          { "idempotency-key": keys[1] },
        ),
        context(seeded.jitterAttemptId),
      ),
    ]);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    const loserIndex = responses.findIndex(({ status }) => status === 409);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    await expect(responses[loserIndex].json()).resolves.toEqual({
      error: "conflict",
      error_code: "call_artifact_conflict",
    });
    const replay = await POST(
      jsonRequest(
        url(seeded.jitterAttemptId, seeded.jitterSessionId),
        "POST",
        bodies[loserIndex],
        { "idempotency-key": keys[loserIndex] },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      error_code: "call_artifact_conflict",
    });
    const { data: rows } = await testClient
      .from("call_recordings")
      .select("status, storage_path")
      .eq("call_activity_id", seeded.callActivityId);
    expect(rows).toHaveLength(1);
    expect(rows![0].status).toBe("available");
    expect(["calls/concurrent-a.wav", "calls/concurrent-b.wav"]).toContain(
      rows![0].storage_path,
    );
  });

  it("rejects a distinct-key downgrade and preserves an available recording", async () => {
    const seeded = await seedCallActivity(testClient);
    const routeUrl = url(seeded.jitterAttemptId, seeded.jitterSessionId);
    const available = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        { status: "available", storage_path: "calls/durable.wav" },
        { "idempotency-key": "recording-durable" },
      ),
      context(seeded.jitterAttemptId),
    );
    const downgrade = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        { status: "failed", error_code: "late_failure" },
        { "idempotency-key": "recording-late-failure" },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(available.status).toBe(200);
    expect(downgrade.status).toBe(409);
    const { data: row } = await testClient
      .from("call_recordings")
      .select("status, storage_path, error_code")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(row).toMatchObject({
      status: "available",
      storage_path: "calls/durable.wav",
      error_code: null,
    });
  });

  it("allows a failed recording to recover to available", async () => {
    const seeded = await seedCallActivity(testClient);
    const routeUrl = url(seeded.jitterAttemptId, seeded.jitterSessionId);
    const failed = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        { status: "failed", error_code: "temporary" },
        { "idempotency-key": "recording-temporary-failure" },
      ),
      context(seeded.jitterAttemptId),
    );
    const recovered = await POST(
      jsonRequest(
        routeUrl,
        "POST",
        { status: "available", storage_path: "calls/recovered.wav" },
        { "idempotency-key": "recording-recovered" },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(failed.status).toBe(200);
    expect(recovered.status).toBe(200);
    const { data: row } = await testClient
      .from("call_recordings")
      .select("status, storage_path")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(row).toMatchObject({
      status: "available",
      storage_path: "calls/recovered.wav",
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
      external_id: effectiveKey(seeded.jitterSessionId, idempotencyKey),
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
      .eq("external_id", effectiveKey(seeded.jitterSessionId, idempotencyKey))
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
