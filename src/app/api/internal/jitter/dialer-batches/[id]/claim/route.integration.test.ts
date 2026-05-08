import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";

import {
  authHeaders,
  context,
  jsonRequest,
  resetJitterIntegration,
  seedDialerBatch,
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
});
