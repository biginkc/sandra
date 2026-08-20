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
import { POST } from "./route";

const testClient = createTestClient();

describe("internal.jitter.dialer-batch complete POST", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key header is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1", claim_generation: 1 },
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
    const raw = JSON.stringify({ status: "completed", jitter_session_id: "session-1", claim_generation: 1 });
    const response = await POST(
      new Request(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "complete-bad",
            }),
          },
          body: raw,
        },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 422 on an invalid status value", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 1 });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "bogus_status", jitter_session_id: "session-1", claim_generation: 1 },
        { "idempotency-key": "complete-bad-status" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "status" });
  });

  it("returns 422 when jitter_session_id is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", claim_generation: 1 },
        { "idempotency-key": "complete-missing-session" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "jitter_session_id" });
  });

  it("returns 422 when claim_generation is missing or invalid", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1" },
        { "idempotency-key": "complete-missing-gen" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "claim_generation" });
  });

  it("completes a batch held by the current claim holder at the current generation", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 3 });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1", claim_generation: 3 },
        { "idempotency-key": "complete-happy" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batch).toMatchObject({
      id: seeded.batchId,
      status: "completed",
      claim_generation: 3,
    });
    expect(json.batch.completed_at).toEqual(expect.any(String));
  });

  it("accepts 'completed_with_pending_outcomes' so the batch can close while writebacks are still retrying", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 1 });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        {
          status: "completed_with_pending_outcomes",
          jitter_session_id: "session-1",
          claim_generation: 1,
        },
        { "idempotency-key": "complete-pending-outcomes" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batch.status).toBe("completed_with_pending_outcomes");
    expect(json.batch.completed_at).toEqual(expect.any(String));
  });

  it("returns 409 stale_claim when claim_generation does not match the current holder", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 2 });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1", claim_generation: 1 },
        { "idempotency-key": "complete-stale-gen" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
  });

  it("returns 409 stale_claim when a different session than the current holder tries to complete", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-holder", claimGeneration: 1 });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-crashed", claim_generation: 1 },
        { "idempotency-key": "complete-wrong-session" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
  });

  it("returns 409 stale_claim when the batch was never claimed", async () => {
    const seeded = await seedDialerBatch(testClient);

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1", claim_generation: 1 },
        { "idempotency-key": "complete-never-claimed" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
  });

  it("retrying with the same idempotency key is idempotent", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 1 });
    const requestUrl = `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`;
    const body = { status: "completed", jitter_session_id: "session-1", claim_generation: 1 };

    const first = await POST(
      jsonRequest(requestUrl, "POST", body, { "idempotency-key": "complete-retry" }),
      context(seeded.batchId),
    );
    const retry = await POST(
      jsonRequest(requestUrl, "POST", body, { "idempotency-key": "complete-retry" }),
      context(seeded.batchId),
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toStrictEqual(await first.json());
  });

  it("returns 404 when the batch belongs to another org", async () => {
    const seeded = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });
    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/complete`,
        "POST",
        { status: "completed", jitter_session_id: "session-1", claim_generation: 1 },
        { "idempotency-key": "complete-cross-org" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(404);
  });
});
