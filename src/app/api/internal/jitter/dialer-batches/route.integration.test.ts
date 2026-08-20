import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  resetJitterIntegration,
  seedDialerBatch,
  setBatchClaim,
} from "../_lib/test-helpers.integration";
import { GET } from "./route";

const testClient = createTestClient();

function signedGet(url: string) {
  return new Request(url, { method: "GET", headers: authHeaders("") });
}

describe("internal.jitter.dialer-batches list GET", () => {
  beforeEach(async () => {
    await resetJitterIntegration(testClient);
  });

  it("lists a never-claimed 'pending' batch under ?status=pending", async () => {
    const seeded = await seedDialerBatch(testClient);

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=pending"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batches.map((b: any) => b.id)).toContain(seeded.batchId);
  });

  it("excludes a batch claimed well inside the TTL window from ?status=pending", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-fresh",
      claimGeneration: 1,
      claimedAt: new Date(),
    });

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=pending"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batches.map((b: any) => b.id)).not.toContain(seeded.batchId);
  });

  it("re-surfaces a batch under ?status=pending once its claim has gone stale past the 30-minute TTL", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-crashed",
      claimGeneration: 1,
      claimedAt: new Date(Date.now() - 31 * 60 * 1000),
    });

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=pending"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const listed = json.batches.find((b: any) => b.id === seeded.batchId);
    expect(listed).toBeTruthy();
    // Read-only filter: the underlying row is not mutated by listing it.
    expect(listed.status).toBe("claimed");
    expect(listed.claim_generation).toBe(1);
  });

  it("does not re-surface a batch claimed just under the 30-minute TTL", async () => {
    const seeded = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, seeded.batchId, {
      sessionId: "session-recent",
      claimGeneration: 1,
      claimedAt: new Date(Date.now() - 29 * 60 * 1000),
    });

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=pending"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batches.map((b: any) => b.id)).not.toContain(seeded.batchId);
  });

  it("only lists batches for the authenticated org", async () => {
    await seedDialerBatch(testClient);
    const other = await seedDialerBatch(testClient, { org_id: TEST_ORG_B_ID });

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=pending"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.batches.map((b: any) => b.id)).not.toContain(other.batchId);
  });

  it("without a status filter, returns batches regardless of status", async () => {
    const pending = await seedDialerBatch(testClient);
    const claimed = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, claimed.batchId, {
      sessionId: "session-active",
      claimGeneration: 1,
    });

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const ids = json.batches.map((b: any) => b.id);
    expect(ids).toContain(pending.batchId);
    expect(ids).toContain(claimed.batchId);
  });

  it("supports explicit status filters other than 'pending'", async () => {
    const claimed = await seedDialerBatch(testClient);
    await setBatchClaim(testClient, claimed.batchId, {
      sessionId: "session-active",
      claimGeneration: 1,
    });
    const untouched = await seedDialerBatch(testClient);

    const response = await GET(
      signedGet("https://sandra.test/api/internal/jitter/dialer-batches?status=claimed"),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const ids = json.batches.map((b: any) => b.id);
    expect(ids).toContain(claimed.batchId);
    expect(ids).not.toContain(untouched.batchId);
  });

  it("returns 401 without valid auth", async () => {
    const response = await GET(
      new Request("https://sandra.test/api/internal/jitter/dialer-batches?status=pending", {
        method: "GET",
        headers: { authorization: "Bearer bogus", "x-sandra-signature": "sha256=bad" },
      }),
    );

    expect(response.status).toBe(401);
  });
});
