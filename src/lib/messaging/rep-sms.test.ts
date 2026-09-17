import { describe, expect, it } from "vitest";

import {
  createRepSmsObligationFence,
  repSmsCatalogOptionIsEligible,
  repSmsCompositionFingerprint,
} from "./rep-sms";
import { composeRepSms } from "./rep-sms-composition";

function sendilloNumber(overrides: Record<string, unknown> = {}) {
  return {
    phoneE164: "+18165550000",
    providerNumberId: "sendillo-number-1",
    status: "active",
    messagingStatus: "ready",
    providerAccountId: "sendillo-account-1",
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
    ["missing provider account identity", { providerAccountId: null }],
  ])("rejects %s", (_label, overrides) => {
    expect(repSmsCatalogOptionIsEligible(sendilloNumber(overrides))).toBe(false);
  });
});

describe("rep SMS obligation fences", () => {
  it("binds the server-created claim to the exact lead, sender, recipient, and composition", () => {
    const composition = composeRepSms({
      introId: "mel-maria-assistant-1",
      introVersion: 1,
      templateId: "no-answer-callback-time",
      templateVersion: 1,
      remainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
    });

    expect(createRepSmsObligationFence({
      obligationId: "obligation-1",
      claimToken: "claim-1",
      claimGeneration: 2,
      actorId: "rep-1",
      propertyId: "property-1",
      assignmentId: "sender-1",
      toNumber: "+1 (816) 555-0123",
      composition,
    })).toEqual({
      obligationId: "obligation-1",
      claimToken: "claim-1",
      claimGeneration: 2,
      actorId: "rep-1",
      propertyId: "property-1",
      assignmentId: "sender-1",
      toNumber: "+18165550123",
      compositionFingerprint: repSmsCompositionFingerprint(composition),
    });
  });
});
