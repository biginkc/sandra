import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  context,
  jsonRequest,
  resetJitterIntegration,
  seedDialerBatch,
  setBatchClaim,
} from "../../../_lib/test-helpers.integration";
import { computeJitterRequestHash } from "../../../_lib/auth";
import { POST } from "./route";

const testClient = createTestClient();

describe("internal.jitter.dialer-batch claim POST", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key header is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-1" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const seeded = await seedDialerBatch(testClient);
    const raw = JSON.stringify({ jitter_session_id: "session-1" });
    const response = await POST(
      new Request(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "claim-bad",
            }),
          },
          body: raw,
        },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 422 on missing required body fields", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        {},
        { "idempotency-key": "claim-missing" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(422);
  });

  it("sets jitter_session_id, claimed_at, and status on first claim", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-1" },
        { "idempotency-key": "claim-1" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batch).toMatchObject({
      id: seeded.batchId,
      status: "claimed",
      jitter_session_id: "session-1",
      claim_generation: 1,
    });
    expect(json.batch.claimed_at).toEqual(expect.any(String));
  });

  it("returning the same jitter_session_id on retry is idempotent", async () => {
    const seeded = await seedDialerBatch(testClient);
    const requestUrl = `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`;

    const first = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-1" }, { "idempotency-key": "claim-retry" }),
      context(seeded.batchId),
    );
    const retry = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-1" }, { "idempotency-key": "claim-retry" }),
      context(seeded.batchId),
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toStrictEqual(await first.json());
  });

  it("recovers a committed claim when the response record was not written", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-crashed",
      claimGeneration: 1,
    });
    const idempotencyKey = "claim-crash-replay";
    const { error } = await testClient.from("webhook_events").insert({
      org_id: seeded.orgId,
      provider: "jitter",
      event_type: "dialer_batch_claim",
      external_id: idempotencyKey,
      signature_verified: true,
      processing_status: "pending",
      payload: { jitter_session_id: "session-crashed" },
      request_hash: computeJitterRequestHash({
        route: "dialer_batch_claim",
        resourceId: seeded.batchId,
        payload: { jitter_session_id: "session-crashed" },
      }),
    });
    if (error) throw error;

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-crashed" },
        { "idempotency-key": idempotencyKey },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      batch: { id: seeded.batchId, claim_generation: 1 },
    });
    const { data: event } = await testClient
      .from("webhook_events")
      .select("processing_status")
      .eq("org_id", seeded.orgId)
      .eq("provider", "jitter")
      .eq("event_type", "dialer_batch_claim")
      .eq("external_id", idempotencyKey)
      .single();
    expect(event?.processing_status).toBe("processed");
  });

  it("returns 409 when batch is already claimed by a different jitter_session_id", async () => {
    const seeded = await seedDialerBatch(testClient);
    await (testClient as any)
      .from("dialer_batches")
      .update({ status: "claimed", jitter_session_id: "other-session" })
      .eq("id", seeded.batchId);

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-1" },
        { "idempotency-key": "claim-conflict" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(409);
  });

  it("returns 404 when the batch belongs to another org", async () => {
    const seeded = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-1" },
        { "idempotency-key": "claim-cross-org" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(404);
  });

  it("has exactly one winner when two sessions claim concurrently", async () => {
    const seeded = await seedDialerBatch(testClient);
    const requestUrl = `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`;

    const responses = await Promise.all([
      POST(
        jsonRequest(requestUrl, "POST", { jitter_session_id: "session-a" }, { "idempotency-key": "claim-race-a" }),
        context(seeded.batchId),
      ),
      POST(
        jsonRequest(requestUrl, "POST", { jitter_session_id: "session-b" }, { "idempotency-key": "claim-race-b" }),
        context(seeded.batchId),
      ),
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);

    const { data: batch } = await (testClient as any)
      .from("dialer_batches")
      .select("status, jitter_session_id, claim_generation")
      .eq("id", seeded.batchId)
      .single();
    expect(batch).toMatchObject({ status: "claimed", claim_generation: 1 });
    expect(["session-a", "session-b"]).toContain(batch.jitter_session_id);
  });
});
