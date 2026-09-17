import { describe, expect, it } from "vitest";

import { repSmsCatalogOptionIsEligible } from "./rep-sms";

function sendilloNumber(overrides: Record<string, unknown> = {}) {
  return {
    phoneE164: "+18165550000",
    providerNumberId: "sendillo-number-1",
    status: "active",
    messagingStatus: "ready",
    raw: {},
    ...overrides,
  } as Parameters<typeof repSmsCatalogOptionIsEligible>[0];
}

describe("rep SMS sender catalog eligibility", () => {
  it("requires active number and messaging evidence plus a provider identity", () => {
    expect(repSmsCatalogOptionIsEligible(sendilloNumber({ messagingStatus: "active" }))).toBe(true);
  });

  it.each([
    ["missing number status", { status: null }],
    ["unknown number status", { status: "unknown" }],
    ["pending number status", { status: "pending" }],
    ["missing messaging status", { messagingStatus: null }],
    ["ready but not active messaging status", { messagingStatus: "ready" }],
    ["unknown messaging status", { messagingStatus: "unknown" }],
    ["pending messaging status", { messagingStatus: "pending" }],
    ["unregistered number", { providerNumberId: null }],
  ])("rejects %s", (_label, overrides) => {
    expect(repSmsCatalogOptionIsEligible(sendilloNumber(overrides))).toBe(false);
  });
});
