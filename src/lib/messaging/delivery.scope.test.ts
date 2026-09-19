import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMessagingProvider = vi.hoisted(() => vi.fn());
vi.mock("./registry", () => ({ getMessagingProvider }));

import {
  getSenderInventoryState,
  loadDeliveryCatalog,
  resolveDeliverySelection,
  syncProviderCatalog,
} from "./delivery";

const provider = {
  providerId: "sendillo",
  listPurchasedNumbers: vi.fn(),
};

function client() {
  return { from: vi.fn() } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  getMessagingProvider.mockReturnValue(provider);
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("SENDILLO_ORG_ID", "org-1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Delivery Sendillo organization scope", () => {
  it.each([
    ["catalog sync", () => syncProviderCatalog(client(), "org-2")],
    ["catalog read", () => loadDeliveryCatalog(client(), "org-2")],
    ["inventory lookup", () => getSenderInventoryState(client(), "org-2", "sendillo", "+18165550123")],
  ])("blocks a cross-tenant %s before reading the provider or database", async (_label, operation) => {
    await expect(operation()).rejects.toThrow("Sendillo texting is not available for this organization.");
    expect(provider.listPurchasedNumbers).not.toHaveBeenCalled();
  });

  it("returns a fail-closed selection error when the Sendillo tenant scope is missing", async () => {
    vi.stubEnv("SENDILLO_ORG_ID", "");
    const database = client() as { from: ReturnType<typeof vi.fn> };

    const result = await resolveDeliverySelection(
      database as never,
      "org-1",
      "+18165550123",
      null,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DELIVERY_LOOKUP_FAILED",
        message: "Sendillo texting organization scope is not configured. Set SENDILLO_ORG_ID before assigning numbers.",
      },
    });
    expect(database.from).not.toHaveBeenCalled();
  });
});
