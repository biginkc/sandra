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
} from "../../_lib/test-helpers.integration";
import { PATCH } from "./route";

const testClient = createTestClient();

describe("internal.jitter.dialer-batch-item PATCH", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 400 with error_code='idempotency_key_required' when Idempotency-Key header is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const seeded = await seedDialerBatch(testClient);
    const raw = JSON.stringify({ status: "skipped" });
    const response = await PATCH(
      new Request(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "x-sandra-signature": "sha256=bad",
              "idempotency-key": "patch-bad",
            }),
          },
          body: raw,
        },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 422 on missing required body fields", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        {},
        { "idempotency-key": "patch-missing" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(422);
  });

  it("returns 422 when the claim session is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", claim_generation: 1 },
        { "idempotency-key": "patch-missing-session" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "jitter_session_id" });
  });

  it("returns 422 when the claim generation is missing", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-1" },
        { "idempotency-key": "patch-missing-generation" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ field: "claim_generation" });
  });

  it("updates item.status only with the current claim generation", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 7 });
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-1", claim_generation: 7 },
        { "idempotency-key": "patch-1" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      item: { id: seeded.itemId, status: "skipped" },
    });
  });

  it("rejects a stale claim generation", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-current", claimGeneration: 2 });
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-old", claim_generation: 1 },
        { "idempotency-key": "patch-stale-generation" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
  });

  it("rejects a generation-only stale claim when the session is unchanged", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-same",
      claimGeneration: 1,
    });
    await (testClient as any)
      .from("dialer_batches")
      .update({ claim_generation: 2 })
      .eq("id", seeded.batchId);

    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-same", claim_generation: 1 },
        { "idempotency-key": "patch-generation-only-stale" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
    const { data: item } = await (testClient as any)
      .from("dialer_batch_items")
      .select("status")
      .eq("id", seeded.itemId)
      .single();
    expect(item?.status).toBe("queued");
  });

  it("rejects the old generation after the batch is reclaimed", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-old",
      claimGeneration: 1,
    });
    await (testClient as any)
      .from("dialer_batches")
      .update({
        jitter_session_id: "session-new",
        claim_generation: 2,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", seeded.batchId);

    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-old", claim_generation: 1 },
        { "idempotency-key": "patch-after-reclaim" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "stale_claim" });
    const { data: item } = await (testClient as any)
      .from("dialer_batch_items")
      .select("status")
      .eq("id", seeded.itemId)
      .single();
    expect(item?.status).toBe("queued");
  });

  it("rejects invalid status values", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "claimed" },
        { "idempotency-key": "patch-invalid" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(422);
  });

  it("returns 404 for an item whose batch belongs to another org", async () => {
    const seeded = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });
    await setBatchClaim(testClient, seeded.batchId, { sessionId: "session-1", claimGeneration: 1 });
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped", jitter_session_id: "session-1", claim_generation: 1 },
        { "idempotency-key": "patch-cross-org" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(404);
  });
});
