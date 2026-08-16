import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

const mocks = vi.hoisted(() => ({
  lookupCassCache: vi.fn(),
  writeCassCache: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("./cass-cache", () => ({
  lookupCassCache: mocks.lookupCassCache,
  writeCassCache: mocks.writeCassCache,
}));
vi.mock("./registry", () => ({
  getAddressVerifier: () => ({ providerId: "test", verify: mocks.verify }),
}));

import { verifyPropertyAddress } from "./verify-property";

function makeClient(options?: {
  locked?: boolean;
  claim?: boolean;
  updateError?: string;
  orgId?: string;
}) {
  const property = {
    id: "property-1",
    org_id: options?.orgId ?? "org-1",
    address: "1 Main St",
    city: "Kansas City",
    state: "MO",
    zip: "64101",
    is_dnc_locked: options?.locked ?? false,
  };
  return {
    rpc: vi.fn().mockResolvedValue({
      data: options?.claim ?? true,
      error: null,
    }),
    from: vi.fn((table: string) => {
      expect(table).toBe("properties");
      const fetch = {
        select: vi.fn(() => fetch),
        eq: vi.fn(() => fetch),
        maybeSingle: vi.fn().mockResolvedValue({ data: property, error: null }),
      };
      const update = {
        eq: vi.fn(() => update),
        select: vi.fn().mockResolvedValue({
          data: options?.updateError ? null : [{ id: property.id }],
          error: options?.updateError
            ? { message: options.updateError }
            : null,
        }),
      };
      return {
        ...fetch,
        update: vi.fn(() => update),
      };
    }),
  };
}

describe("verifyPropertyAddress paid boundary", () => {
  beforeEach(() => {
    mocks.lookupCassCache.mockReset().mockResolvedValue(null);
    mocks.writeCassCache.mockReset().mockResolvedValue(undefined);
    mocks.verify.mockReset().mockResolvedValue({
      standardized: "1 Main St, Kansas City, MO 64101",
      cassStatus: "verified",
      components: {},
      raw: {},
    });
  });

  it("never calls the paid provider when the property is already DNC", async () => {
    const client = makeClient({ locked: true });
    await expect(
      verifyPropertyAddress(client as never, "property-1", "org-1"),
    ).resolves.toEqual({ status: "dnc_skipped", propertyId: "property-1" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("never calls the paid provider when DNC wins the atomic boundary claim", async () => {
    const client = makeClient({ claim: false });
    await expect(
      verifyPropertyAddress(client as never, "property-1", "org-1"),
    ).resolves.toEqual({ status: "dnc_skipped", propertyId: "property-1" });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("marks response loss as non-retryable submission_unknown", async () => {
    mocks.verify.mockRejectedValueOnce(
      new ProviderError("connection closed after submit", "test"),
    );
    const outcome = await verifyPropertyAddress(
      makeClient() as never,
      "property-1",
      "org-1",
    );
    expect(outcome).toMatchObject({ status: "submission_unknown" });
  });

  it("keeps a definite pre-provider cache failure retryable", async () => {
    mocks.lookupCassCache.mockRejectedValueOnce(new Error("cache unavailable"));
    const outcome = await verifyPropertyAddress(
      makeClient() as never,
      "property-1",
      "org-1",
    );
    expect(outcome).toMatchObject({ status: "failed" });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("marks a post-provider database failure for manual reconciliation", async () => {
    const outcome = await verifyPropertyAddress(
      makeClient({ updateError: "database unavailable" }) as never,
      "property-1",
      "org-1",
    );
    expect(outcome).toMatchObject({ status: "provider_persist_failed" });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it("never calls the paid provider for a property outside the expected organization", async () => {
    const client = makeClient({ orgId: "org-b" });

    await expect(
      verifyPropertyAddress(client as never, "property-1", "org-a"),
    ).resolves.toEqual({ status: "not_found", propertyId: "property-1" });

    expect(client.rpc).not.toHaveBeenCalled();
    expect(mocks.lookupCassCache).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
