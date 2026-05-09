import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";

import {
  authHeaders,
  context,
  jsonRequest,
  resetJitterIntegration,
  seedDialerBatch,
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

  it("updates item.status with valid Idempotency-Key", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await PATCH(
      jsonRequest(
        `https://sandra.test/api/internal/jitter/dialer-batch-items/${seeded.itemId}`,
        "PATCH",
        { status: "skipped" },
        { "idempotency-key": "patch-1" },
      ),
      context(seeded.itemId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      item: { id: seeded.itemId, status: "skipped" },
    });
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
});
