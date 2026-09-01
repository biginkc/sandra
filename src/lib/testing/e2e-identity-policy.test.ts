import { describe, expect, it } from "vitest";
import { assertBrowserQaProtected, assertDedicatedProjectUrl, assertIdentity, assertPairwiseDisjoint, createIdentity, identityFromEnvironment } from "./e2e-identity-policy";

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
  it("keeps primary and assignee distinct within one run", () => {
    const primary = createIdentity("gha-9-1", "p".repeat(32), "primary");
    const assignee = createIdentity("gha-9-1", "p".repeat(32), "assignee");
    expect(primary.email).not.toBe(assignee.email);
    expect(primary.appMetadata).toMatchObject({ owner: "github-actions", purpose: "ci-e2e", run_slug: "gha-9-1", principal: "primary" });
    expect(assignee.appMetadata).toMatchObject({ owner: "github-actions", purpose: "ci-e2e", run_slug: "gha-9-1", principal: "assignee" });
  });
  it("rejects URL component and hostname smuggling", () => {
    const ref = "ci-project";
    expect(() => assertDedicatedProjectUrl("https://ci-project.supabase.co", ref)).not.toThrow();
    expect(() => assertDedicatedProjectUrl(" https://ci-project.supabase.co/ ", ref)).not.toThrow();
    for (const value of ["http://ci-project.supabase.co/", "HTTPS://ci-project.supabase.co/", "https://CI-PROJECT.supabase.co/", "https://ci-project.supabase.co.evil/", "https://evil/ci-project.supabase.co", "https://ci-project.supabase.co/path", "https://ci-project.supabase.co/?x=1", "https://u:p@ci-project.supabase.co/", "https://ci-project.supabase.co:443/", "https://ci-project.supabase.co:443", "https://ci-project.supabase.co//", "https://ci-project.supabase.co/\t"]) expect(() => assertDedicatedProjectUrl(value, ref)).toThrow();
  });
});
