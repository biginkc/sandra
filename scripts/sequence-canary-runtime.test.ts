import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertRuntimeResponse, scheduledSendDeadline } from "./sequence-canary-runtime";
import { CANARY_HOST } from "../src/lib/sequences/canary-runtime-proof";

const key = "approved-key";
const nonce = "a".repeat(64);
const input = {
  approvedKey: key, adminAccessToken: "token",
  deploymentUrl: "https://deployment.vercel.app",
  aliasHost: "sandra.example.test", expectedCommitSha: "b".repeat(40),
  sequenceId: "11111111-1111-4111-8111-111111111111",
  runId: "12345", runMode: "scheduled" as const,
};
function response() {
  return {
    providerIsSendillo: true, senderMatches: true, senderLast4: "6899",
    webhookSecretPresent: true, supabaseHost: CANARY_HOST,
    hmac: createHmac("sha256", key).update(nonce).digest("hex"),
    deploymentId: "dpl_expected", commitSha: input.expectedCommitSha,
  };
}
describe("runner runtime comparison", () => {
  it("creates a signed, short-lived manual proof for a matching live response", () => {
    const signed = assertRuntimeResponse(response(), nonce, { ...input, runMode: "manual" }, "dpl_expected");
    expect(signed).toMatch(/^CANARY_RUNTIME_PROOF_V1:/);
    expect(signed).not.toContain(key);
  });
  it("rejects delayed schedule and accepts only the current weekday window", () => {
    expect(scheduledSendDeadline(Date.UTC(2026, 8, 30, 14, 20))).toBe(Date.UTC(2026, 8, 30, 14, 27));
    expect(() => scheduledSendDeadline(Date.UTC(2026, 8, 30, 14, 28))).toThrow(/window/);
    expect(() => scheduledSendDeadline(Date.UTC(2026, 9, 3, 14, 20))).toThrow(/window/);
  });
  it("fails on a wrong approved key", () => {
    expect(() => assertRuntimeResponse(response(), nonce, { ...input, approvedKey: "wrong" }, "dpl_expected"))
      .toThrow(/key mismatch/);
  });
  it("fails on wrong sender or provider configuration", () => {
    expect(() => assertRuntimeResponse({ ...response(), senderMatches: false }, nonce, input, "dpl_expected"))
      .toThrow(/configuration/);
    expect(() => assertRuntimeResponse({ ...response(), webhookSecretPresent: false }, nonce, input, "dpl_expected"))
      .toThrow(/configuration/);
  });
  it("fails when the inspected deployment is no longer the alias target", () => {
    expect(() => assertRuntimeResponse(response(), nonce, input, "dpl_new"))
      .toThrow(/deployment mismatch/);
  });
});
