import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  context,
  resetJitterIntegration,
  seedDialerBatch,
  signedGet,
} from "../../_lib/test-helpers.integration";
import { GET } from "./route";

const testClient = createTestClient();

describe("internal.jitter.dialer-batch GET", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await GET(
      new Request(`https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}`),
      context(seeded.batchId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await GET(
      new Request(`https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}`, {
        headers: authHeaders("", { "x-sandra-signature": "sha256=bad" }),
      }),
      context(seeded.batchId),
    );

    expect(response.status).toBe(401);
  });

  it("returns batch header for caller with valid auth", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await GET(
      signedGet(`https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}`),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      batch: { id: seeded.batchId, status: "pending", claim_generation: 0 },
    });
  });

  it("returns 404 when batch_id is not found", async () => {
    const id = crypto.randomUUID();
    const response = await GET(
      signedGet(`https://sandra.test/api/internal/jitter/dialer-batches/${id}`),
      context(id),
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 when the batch belongs to another org", async () => {
    const seeded = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });
    const response = await GET(
      signedGet(`https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}`),
      context(seeded.batchId),
    );

    expect(response.status).toBe(404);
  });

  it("with include=items returns items array with fresh eligibility", async () => {
    const seeded = await seedDialerBatch(testClient);
    await testClient
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", seeded.contactId);

    const response = await GET(
      signedGet(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}?include=items`,
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.items).toHaveLength(1);
    expect(json.items[0].eligibility).toEqual({
      status: "blocked",
      reason: "do_not_contact",
    });
  });

  it("with eligibility=fresh returns each item with computed eligibility flag", async () => {
    const seeded = await seedDialerBatch(testClient);
    const response = await GET(
      signedGet(
        `https://sandra.test/api/internal/jitter/dialer-batches/${seeded.batchId}?eligibility=fresh`,
      ),
      context(seeded.batchId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.items[0].eligibility.status).toBe("callable");
  });
});
