import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import { computeJitterRequestHash } from "../../../../_lib/auth";
import {
  jsonRequest,
  resetJitterIntegration,
  seedCallActivity,
} from "../../../../_lib/test-helpers.integration";
import { PUT } from "./route";

const testClient = createTestClient();

function context(attemptId: string) {
  return { params: Promise.resolve({ attemptId }) };
}

function url(attemptId: string, scopeId = "scope-default") {
  return `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}/transcript?scopeId=${encodeURIComponent(scopeId)}`;
}

function effectiveKey(scopeId: string, key: string) {
  return `${scopeId.length}:${scopeId}:${key}`;
}

describe("internal.jitter.call-activities by-attempt transcript PUT", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("rejects requests without Jitter authentication", async () => {
    const response = await PUT(
      new Request(url("missing-auth"), {
        method: "PUT",
        headers: { "idempotency-key": "by-attempt-transcript-no-auth" },
        body: "{}",
      }),
      context("missing-auth"),
    );

    expect(response.status).toBe(401);
  });

  it("requires an idempotency key", async () => {
    const response = await PUT(
      jsonRequest(url("missing-key"), "PUT", { status: "pending" }),
      context("missing-key"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("requires a scope id after authentication", async () => {
    const attemptId = "missing-scope";
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/${attemptId}/transcript`,
        "PUT",
        { status: "pending" },
        { "idempotency-key": "by-attempt-transcript-missing-scope" },
      ),
      context(attemptId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "scope_id_required",
    });
  });

  it("validates transcript and summary statuses", async () => {
    const invalidTranscript = await PUT(
      jsonRequest(
        url("invalid-transcript"),
        "PUT",
        { status: "complete" },
        { "idempotency-key": "by-attempt-transcript-invalid" },
      ),
      context("invalid-transcript"),
    );
    const invalidSummary = await PUT(
      jsonRequest(
        url("invalid-summary"),
        "PUT",
        { status: "available", summary_status: "complete" },
        { "idempotency-key": "by-attempt-summary-invalid" },
      ),
      context("invalid-summary"),
    );

    expect(invalidTranscript.status).toBe(422);
    await expect(invalidTranscript.json()).resolves.toMatchObject({
      field: "status",
    });
    expect(invalidSummary.status).toBe(422);
    await expect(invalidSummary.json()).resolves.toMatchObject({
      field: "summary_status",
    });
  });

  it("rejects invalid metadata before reserving the idempotency key", async () => {
    const seeded = await seedCallActivity(testClient);
    const idempotencyKey = "by-attempt-transcript-invalid-metadata";
    const incoherentKey = "by-attempt-transcript-incoherent-summary";
    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        {
          status: "available",
          text: "Transcript exists",
          summary_status: "available",
          summary: "   ",
        },
        { "idempotency-key": idempotencyKey },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "summary" });
    const incoherentResponse = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "failed", summary_status: "failed" },
        { "idempotency-key": incoherentKey },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(incoherentResponse.status).toBe(422);
    await expect(incoherentResponse.json()).resolves.toMatchObject({
      field: "summary_status",
    });
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .in("external_id", [
        effectiveKey(seeded.jitterSessionId, idempotencyKey),
        effectiveKey(seeded.jitterSessionId, incoherentKey),
      ]);
    expect(events).toHaveLength(0);
  });

  it("returns the retryable 404 contract when the parent is missing", async () => {
    const attemptId = `missing-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        url(attemptId),
        "PUT",
        { status: "available", text: "orphan" },
        { "idempotency-key": "by-attempt-transcript-missing" },
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
    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "available", text: "foreign" },
        { "idempotency-key": "by-attempt-transcript-cross-org" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(404);
    const { data } = await testClient
      .from("call_transcripts")
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

    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "available", text: "wrong provider" },
        { "idempotency-key": "by-attempt-transcript-wrong-provider" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(404);
    const { data } = await testClient
      .from("call_transcripts")
      .select("id")
      .eq("call_activity_id", seeded.callActivityId);
    expect(data).toHaveLength(0);
  });

  it("adopts the authenticated scope on a wrap-up-first softphone parent", async () => {
    const callId = crypto.randomUUID();
    const seeded = await seedCallActivity(testClient, { attemptId: `sandra-${callId}` });
    const scopeId = `sandra-softphone-session-${callId}:run-1`;
    const { error: seedError } = await testClient
      .from("call_activities")
      .update({ provider: "sandra_softphone", jitter_session_id: null })
      .eq("id", seeded.callActivityId);
    expect(seedError).toBeNull();

    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId, scopeId),
        "PUT",
        { status: "available", text: "Softphone transcript" },
        { "idempotency-key": "by-attempt-transcript-softphone-scope" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(200);
    const { data: activity, error: activityError } = await testClient
      .from("call_activities")
      .select("jitter_session_id")
      .eq("id", seeded.callActivityId)
      .single();
    expect(activityError).toBeNull();
    expect(activity?.jitter_session_id).toBe(scopeId);
    const { data: transcripts } = await testClient
      .from("call_transcripts")
      .select("status, text")
      .eq("call_activity_id", seeded.callActivityId);
    expect(transcripts).toEqual([
      { status: "available", text: "Softphone transcript" },
    ]);
  });

  it("writes transcript and summary fields and fans summary status to the parent", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        {
          status: "available",
          text: "Seller asked for a follow-up next week.",
          language: "en",
          summary: "Seller is open to a follow-up next week.",
          summary_status: "available",
        },
        { "idempotency-key": "by-attempt-transcript-fresh" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      transcript: {
        call_activity_id: seeded.callActivityId,
        status: "available",
        summary: "Seller is open to a follow-up next week.",
        summary_status: "available",
      },
    });
    const { data: parent } = await testClient
      .from("call_activities")
      .select("transcript_status, summary_status")
      .eq("id", seeded.callActivityId)
      .single();
    expect(parent).toMatchObject({
      transcript_status: "available",
      summary_status: "available",
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

    const response = await PUT(
      jsonRequest(
        url(attemptId, second.jitterSessionId),
        "PUT",
        {
          status: "available",
          text: "Scoped transcript",
          summary_status: "none",
        },
        {
          "idempotency-key": `${second.jitterSessionId}:${attemptId}:transcript`,
        },
      ),
      context(attemptId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      transcript: { call_activity_id: second.callActivityId },
    });
    const { data: wrongScopeRows } = await testClient
      .from("call_transcripts")
      .select("id")
      .eq("call_activity_id", first.callActivityId);
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
    const key = `${attemptId}:transcript`;
    const responses = await Promise.all([
      PUT(
        jsonRequest(
          url(attemptId, first.jitterSessionId),
          "PUT",
          { status: "available", text: "First scope" },
          { "idempotency-key": key },
        ),
        context(attemptId),
      ),
      PUT(
        jsonRequest(
          url(attemptId, second.jitterSessionId),
          "PUT",
          { status: "available", text: "Second scope" },
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

  it("serializes concurrent distinct-key first writes into one transcript", async () => {
    const seeded = await seedCallActivity(testClient);
    const bodies = [
      { status: "available", text: "Concurrent transcript A" },
      { status: "available", text: "Concurrent transcript B" },
    ];
    const keys = ["transcript-concurrent-a", "transcript-concurrent-b"];
    const responses = await Promise.all([
      PUT(
        jsonRequest(
          url(seeded.jitterAttemptId, seeded.jitterSessionId),
          "PUT",
          bodies[0],
          { "idempotency-key": keys[0] },
        ),
        context(seeded.jitterAttemptId),
      ),
      PUT(
        jsonRequest(
          url(seeded.jitterAttemptId, seeded.jitterSessionId),
          "PUT",
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
    const replay = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId, seeded.jitterSessionId),
        "PUT",
        bodies[loserIndex],
        { "idempotency-key": keys[loserIndex] },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(replay.status).toBe(409);
    const { data: rows } = await testClient
      .from("call_transcripts")
      .select("status, text")
      .eq("call_activity_id", seeded.callActivityId);
    expect(rows).toHaveLength(1);
    expect(rows![0].status).toBe("available");
    expect(["Concurrent transcript A", "Concurrent transcript B"]).toContain(
      rows![0].text,
    );
  });

  it("rejects a distinct-key downgrade and preserves an available transcript", async () => {
    const seeded = await seedCallActivity(testClient);
    const routeUrl = url(seeded.jitterAttemptId, seeded.jitterSessionId);
    const available = await PUT(
      jsonRequest(
        routeUrl,
        "PUT",
        {
          status: "available",
          text: "Durable transcript",
          summary: "Durable summary",
          summary_status: "available",
        },
        { "idempotency-key": "transcript-durable" },
      ),
      context(seeded.jitterAttemptId),
    );
    const downgrade = await PUT(
      jsonRequest(
        routeUrl,
        "PUT",
        { status: "failed", error_code: "late_failure" },
        { "idempotency-key": "transcript-late-failure" },
      ),
      context(seeded.jitterAttemptId),
    );
    const eraseSummary = await PUT(
      jsonRequest(
        routeUrl,
        "PUT",
        {
          status: "available",
          text: "Durable transcript",
          summary_status: "none",
        },
        { "idempotency-key": "transcript-erase-summary" },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(available.status).toBe(200);
    expect(downgrade.status).toBe(409);
    expect(eraseSummary.status).toBe(409);
    const { data: row } = await testClient
      .from("call_transcripts")
      .select("status, text, summary_status, summary, error_code")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(row).toMatchObject({
      status: "available",
      text: "Durable transcript",
      summary_status: "available",
      summary: "Durable summary",
      error_code: null,
    });
  });

  it("allows a failed transcript to recover to available", async () => {
    const seeded = await seedCallActivity(testClient);
    const routeUrl = url(seeded.jitterAttemptId, seeded.jitterSessionId);
    const failed = await PUT(
      jsonRequest(
        routeUrl,
        "PUT",
        { status: "failed", error_code: "temporary" },
        { "idempotency-key": "transcript-temporary-failure" },
      ),
      context(seeded.jitterAttemptId),
    );
    const recovered = await PUT(
      jsonRequest(
        routeUrl,
        "PUT",
        { status: "available", text: "Recovered transcript" },
        { "idempotency-key": "transcript-recovered" },
      ),
      context(seeded.jitterAttemptId),
    );
    expect(failed.status).toBe(200);
    expect(recovered.status).toBe(200);
    const { data: row } = await testClient
      .from("call_transcripts")
      .select("status, text")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(row).toMatchObject({
      status: "available",
      text: "Recovered transcript",
    });
  });

  it("preserves a working transcript when summary generation failed", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        {
          status: "available",
          text: "Readable transcript",
          summary_status: "failed",
          summary_error_code: "summary_provider_error",
          summary_error_message: "Summary unavailable",
        },
        { "idempotency-key": "by-attempt-summary-failed" },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      transcript: {
        status: "available",
        text: "Readable transcript",
        summary_status: "failed",
        summary_error_code: "summary_provider_error",
        summary_error_message: "Summary unavailable",
      },
    });
    const { data: transcript } = await testClient
      .from("call_transcripts")
      .select("summary_error_message")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(transcript?.summary_error_message).toBe("Summary unavailable");
  });

  it("returns the cached payload for an identical replay", async () => {
    const seeded = await seedCallActivity(testClient);
    const body = {
      status: "available",
      text: "cached transcript",
      summary_status: "pending",
    };
    const headers = { "idempotency-key": "by-attempt-transcript-cached" };
    const first = await PUT(
      jsonRequest(url(seeded.jitterAttemptId), "PUT", body, headers),
      context(seeded.jitterAttemptId),
    );
    const firstPayload = await first.json();
    const replay = await PUT(
      jsonRequest(url(seeded.jitterAttemptId), "PUT", body, headers),
      context(seeded.jitterAttemptId),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstPayload);
  });

  it("resumes a matching pending idempotency reservation", async () => {
    const seeded = await seedCallActivity(testClient);
    const body = {
      status: "available",
      text: "retried transcript",
      summary_status: "available",
      summary: "retried summary",
    };
    const idempotencyKey = "by-attempt-transcript-retry";
    const requestHash = computeJitterRequestHash({
      route: "call_transcript_writeback",
      resourceId: seeded.callActivityId,
      payload: body,
    });
    const { error } = await testClient.from("webhook_events").insert({
      org_id: seeded.orgId,
      provider: "jitter",
      event_type: "call_transcript_writeback",
      external_id: effectiveKey(seeded.jitterSessionId, idempotencyKey),
      signature_verified: true,
      payload: body,
      request_hash: requestHash,
      processing_status: "pending",
    } as never);
    expect(error).toBeNull();

    const response = await PUT(
      jsonRequest(url(seeded.jitterAttemptId), "PUT", body, {
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
    const headers = { "idempotency-key": "by-attempt-transcript-conflict" };
    const first = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "pending", summary_status: "none" },
        headers,
      ),
      context(seeded.jitterAttemptId),
    );
    const conflict = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "failed", summary_status: "none" },
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
