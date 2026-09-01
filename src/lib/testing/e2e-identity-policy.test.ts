import { describe, expect, it } from "vitest";
import { assertBrowserQaProtected, assertIdentity, assertPairwiseDisjoint, createIdentity, identityFromEnvironment } from "./e2e-identity-policy";

describe("E2E identity policy", () => {
  it("creates deterministic run-scoped principals", () => {
    const identity = createIdentity("gha-123-2", "x".repeat(32));
    expect(identity.email).toBe("e2e-ci+gha-123-2@bmhgroupkc.com");
    expect(identity.appMetadata).toMatchObject({ owner: "github-actions", purpose: "ci-e2e", run_slug: "gha-123-2" });
  });
  it("rejects malformed namespace and short passwords", () => {
    expect(() => createIdentity("shared", "x".repeat(32))).toThrow();
    expect(() => createIdentity("gha-1-1", "short")).toThrow();
  });
  it("fails closed on metadata mismatch and protects browser-QA identities", () => {
    const identity = createIdentity("gha-1-1", "x".repeat(32));
    expect(() => assertIdentity({ email: identity.email, app_metadata: identity.appMetadata }, identity)).not.toThrow();
    expect(() => assertIdentity({ email: identity.email, app_metadata: { ...identity.appMetadata, purpose: "browser-qa" } }, identity)).toThrow();
    expect(() => assertBrowserQaProtected({ email: "a@example.com", app_metadata: { owner: "browser-qa" } })).toThrow();
  });
  it("normalizes and rejects missing or colliding identities", () => {
    expect(() => assertPairwiseDisjoint([" A@x.test ", "a@x.test"])).toThrow();
    expect(() => assertPairwiseDisjoint(["a@x.test", "b@x.test"])).not.toThrow();
    expect(() => identityFromEnvironment({ ...process.env, CI: "1", NODE_ENV: "test" })).toThrow();
  });
});
