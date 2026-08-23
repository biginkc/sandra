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
import { PUT } from "./route";

const testClient = createTestClient();

async function parent(callActivityId: string) {
  const { data, error } = await (testClient as any)
    .from("call_activities")
    .select("transcript_status, updated_at")
    .eq("id", callActivityId)
    .single();
  if (error || !data) throw error ?? new Error("missing parent call activity");
  return data as { transcript_status: string; updated_at: string };
}

describe("internal.jitter.call-activities transcript PUT", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await PUT(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        {
          method: "PUT",
          headers: { "idempotency-key": "transcript-no-auth" },
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
    const response = await PUT(
      new Request(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "transcript-bad-hmac",
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
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        "PUT",
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
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        "PUT",
        {},
        { "idempotency-key": "transcript-missing-status" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "status" });
  });

  it("returns 422 if call_activity_id is not found", async () => {
    const id = crypto.randomUUID();
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${id}/transcript`,
        "PUT",
        { status: "pending" },
        { "idempotency-key": "transcript-missing-parent" },
      ),
      context(id),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      field: "call_activity_id",
    });
  });

  it("denies an org-A token from reading or mutating an org-B activity", async () => {
    const seeded = await seedCallActivity(testClient, { org_id: TEST_ORG_B_ID });
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        "PUT",
        { status: "available", text: "foreign" },
        { "idempotency-key": "transcript-cross-org" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "call_activity_id" });
    const { data: transcripts } = await testClient
      .from("call_transcripts")
      .select("id")
      .eq("call_activity_id", seeded.callActivityId);
    expect(transcripts).toHaveLength(0);
  });

  it("refuses a reused idempotency key with a different transcript body", async () => {
    const seeded = await seedCallActivity(testClient);
    const url = `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`;
    const first = await PUT(
      jsonRequest(url, "PUT", { status: "pending" }, { "idempotency-key": "transcript-conflict" }),
      context(seeded.callActivityId),
    );
    const second = await PUT(
      jsonRequest(url, "PUT", { status: "failed" }, { "idempotency-key": "transcript-conflict" }),
      context(seeded.callActivityId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error_code: "idempotency_key_reused" });
    const { data: transcript } = await testClient
      .from("call_transcripts")
      .select("status")
      .eq("call_activity_id", seeded.callActivityId)
      .single();
    expect(transcript?.status).toBe("pending");
  });

  it("inserts a call_transcripts row for an existing call_activity", async () => {
    const seeded = await seedCallActivity(testClient);
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        "PUT",
        {
          status: "available",
          text: "Hello from Jitter.",
          language: "en",
          summary: "Seller requested a follow-up.",
          summary_status: "available",
        },
        { "idempotency-key": "transcript-insert" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      transcript: {
        call_activity_id: seeded.callActivityId,
        status: "available",
        text: "Hello from Jitter.",
        summary: "Seller requested a follow-up.",
        summary_status: "available",
      },
    });
  });

  it("trigger fan-out advances parent updated_at and sets transcript_status on insert and update", async () => {
    const seeded = await seedCallActivity(testClient);
    const url = `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`;
    const before = await parent(seeded.callActivityId);

    await sleep(20);
    const pending = await PUT(
      jsonRequest(url, "PUT", { status: "pending" }, {
        "idempotency-key": "transcript-trigger-pending",
      }),
      context(seeded.callActivityId),
    );
    expect(pending.status).toBe(200);
    const afterPending = await parent(seeded.callActivityId);
    expect(afterPending.transcript_status).toBe("pending");
    expect(new Date(afterPending.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );

    await sleep(20);
    const available = await PUT(
      jsonRequest(url, "PUT", { status: "available", text: "Done." }, {
        "idempotency-key": "transcript-trigger-available",
      }),
      context(seeded.callActivityId),
    );
    expect(available.status).toBe(200);
    const afterAvailable = await parent(seeded.callActivityId);
    expect(afterAvailable.transcript_status).toBe("available");
    expect(new Date(afterAvailable.updated_at).getTime()).toBeGreaterThan(
      new Date(afterPending.updated_at).getTime(),
    );
  });

  it("accepts failed status and trigger fan-out sets parent transcript_status to failed", async () => {
    const seeded = await seedCallActivity(testClient);
    await sleep(20);
    const response = await PUT(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/call-activities/${seeded.callActivityId}/transcript`,
        "PUT",
        {
          status: "failed",
          error_code: "provider_error",
          error_message: "Transcript unavailable",
        },
        { "idempotency-key": "transcript-trigger-failed" },
      ),
      context(seeded.callActivityId),
    );

    expect(response.status).toBe(200);
    const after = await parent(seeded.callActivityId);
    expect(after.transcript_status).toBe("failed");
  });
});
