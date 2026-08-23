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
    const response = await PUT(
      jsonRequest(
        url(seeded.jitterAttemptId),
        "PUT",
        { status: "available", summary: { fabricated: true } },
        { "idempotency-key": idempotencyKey },
      ),
      context(seeded.jitterAttemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "summary" });
    const { data: events } = await testClient
      .from("webhook_events")
      .select("id")
      .eq("external_id", idempotencyKey);
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
      external_id: idempotencyKey,
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
      .eq("external_id", idempotencyKey)
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
        { status: "pending", summary_status: "failed" },
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
