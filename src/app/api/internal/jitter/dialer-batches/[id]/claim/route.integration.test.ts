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

  it("returns 404 when the batch belongs to a different org (org-scoping)", async () => {
    const seeded = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "session-1" },
        { "idempotency-key": "claim-org-scope" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(404);
  });

  it("double claim with different sessions and different idempotency keys: one wins, one 409", async () => {
    const seeded = await seedDialerBatch(testClient);
    const requestUrl = `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`;

    const winner = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-a" }, { "idempotency-key": "claim-race-a" }),
      context(seeded.batchId),
    );
    const loser = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-b" }, { "idempotency-key": "claim-race-b" }),
      context(seeded.batchId),
    );

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
  });

  it("re-claiming with the SAME session_id (different idempotency key) is CAS-idempotent, not just cached", async () => {
    const seeded = await seedDialerBatch(testClient);
    const requestUrl = `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`;

    const first = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-1" }, { "idempotency-key": "claim-same-a" }),
      context(seeded.batchId),
    );
    // Different idempotency key, so this exercises the RPC's CAS predicate
    // (jitter_session_id = p_session_id), not the idempotency cache.
    const second = await POST(
      jsonRequest(requestUrl, "POST", { jitter_session_id: "session-1" }, { "idempotency-key": "claim-same-b" }),
      context(seeded.batchId),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as any;
    expect(secondJson.batch).toMatchObject({
      id: seeded.batchId,
      status: "claimed",
      jitter_session_id: "session-1",
    });
  });

  it("allows takeover after the 30-minute claim TTL expires", async () => {
    const seeded = await seedDialerBatch(testClient);
    const staleClaimedAt = new Date(Date.now() - 31 * 60 * 1000);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "abandoned-session",
      claimedAt: staleClaimedAt,
    });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "new-session" },
        { "idempotency-key": "claim-ttl-takeover" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batch).toMatchObject({
      status: "claimed",
      jitter_session_id: "new-session",
    });
  });

  it("refuses takeover within the 30-minute claim TTL", async () => {
    const seeded = await seedDialerBatch(testClient);
    const recentClaimedAt = new Date(Date.now() - 5 * 60 * 1000);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "active-session",
      claimedAt: recentClaimedAt,
    });

    const response = await POST(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}/claim`,
        "POST",
        { jitter_session_id: "new-session" },
        { "idempotency-key": "claim-ttl-too-early" },
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(409);
  });
});
