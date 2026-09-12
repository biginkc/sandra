import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { remainingSignatureRequests } from "./quota-policy";

const now = Date.parse("2026-09-12T20:00:00Z");
const policy = {
  basis: "shared_signature_requests", plan: "Essentials 50", allowance: 50,
  verifiedAt: "2026-09-12T19:00:00Z", validUntil: "2026-10-01T00:00:00Z",
};
const configured = (overrides = {}) => JSON.stringify({ verified: { ...policy, ...overrides } });
const account = { accountId: "verified", quotas: { apiSignatureRequestsLeft: 0, documentsLeft: 47 } };

describe("verified account quota policy", () => {
  it("uses shared quota only for the explicitly verified account", () => {
    expect(remainingSignatureRequests(account, "verified", configured(), now)).toBe(47);
    expect(remainingSignatureRequests(account, "verified", undefined, now)).toBe(0);
    expect(remainingSignatureRequests({ ...account, accountId: "other" }, "other", configured(), now)).toBe(0);
    expect(remainingSignatureRequests(account, "other", configured(), now)).toBeNull();
  });
  it("supports raw provider response names and returns low balances without inflating them", () => {
    expect(remainingSignatureRequests({ account_id: "verified", quotas: { documents_left: 10 } }, "verified", configured(), now)).toBe(10);
    expect(remainingSignatureRequests({ account_id: "other", quotas: { api_signature_requests_left: 17 } }, "other", configured(), now)).toBe(17);
  });
  it.each([undefined, null, "47", -1, 0.5, NaN, Infinity, 51])("rejects invalid shared balances: %s", (value) => {
    expect(remainingSignatureRequests({ ...account, quotas: { documentsLeft: value } }, "verified", configured(), now)).toBeNull();
  });
  it.each(["broken", "[]", "null", '{"verified":null}'])("fails closed for malformed configuration: %s", (json) => {
    expect(remainingSignatureRequests(account, "verified", json, now)).toBeNull();
  });
  it.each([
    { validUntil: "2026-09-12T20:00:00Z" },
    { verifiedAt: "2026-09-13T00:00:00Z" },
    { validUntil: "2027-01-01T00:00:00Z" },
    { verifiedAt: "invalid" }, { allowance: "50" }, { allowance: -1 },
    { basis: "automatic" }, { plan: "" },
  ])("rejects stale or invalid billing attestations: %j", (override) => {
    expect(remainingSignatureRequests(account, "verified", configured(override), now)).toBeNull();
  });
  it("requires account identity and a valid API balance for default accounts", () => {
    expect(remainingSignatureRequests({ quotas: { apiSignatureRequestsLeft: 47 } }, "other", undefined, now)).toBeNull();
    for (const value of [-1, 1.5, "47", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(remainingSignatureRequests({ accountId: "other", quotas: { apiSignatureRequestsLeft: value } }, "other", undefined, now)).toBeNull();
    }
  });
});
