import { describe, expect, it } from "vitest";

import {
  assertBrowserQaSnapshotUnchanged,
  assertCleanupCandidate,
  assertExistingUserMatchesIdentity,
  assertValidE2EIdentity,
  ciE2EEmail,
  createGitHubRunEnvironment,
  deriveGitHubRunSlug,
  ensureE2ERunEnvironment,
  identityForPrincipal,
  isProtectedBrowserQaUser,
  snapshotProtectedBrowserQaUsers,
  type E2EIdentity,
} from "../supabase/e2e-identity-guard";

const RUN = {
  runSlug: "gha-123456-2",
  email: "e2e-ci+gha-123456-2@bmhgroupkc.com",
  password: "generated-password-with-at-least-32-characters",
};

function validIdentity(): E2EIdentity {
  return identityForPrincipal(RUN);
}

describe("E2E identity policy", () => {
  it("derives the exact run namespace from run ID and attempt", () => {
    expect(deriveGitHubRunSlug("123456", "2")).toBe("gha-123456-2");
    expect(ciE2EEmail("gha-123456-2")).toBe(RUN.email);
    expect(ciE2EEmail("gha-123456-2", "assignee")).toBe(
      "e2e-ci+gha-123456-2-assignee@bmhgroupkc.com",
    );
  });

  it.each([
    [undefined, "1"],
    ["0", "1"],
    ["abc", "1"],
    ["1", undefined],
    ["1", "0"],
    ["1", "again"],
  ])("rejects malformed GitHub run coordinates", (runId, attempt) => {
    expect(() => deriveGitHubRunSlug(runId, attempt)).toThrow();
  });

  it("generates one password shared by both principals in the job", () => {
    const run = createGitHubRunEnvironment({
      NODE_ENV: "test",
      GITHUB_RUN_ID: "88",
      GITHUB_RUN_ATTEMPT: "3",
    });
    const primary = identityForPrincipal(run, "primary");
    const assignee = identityForPrincipal(run, "assignee");

    expect(primary.password).toBe(assignee.password);
    expect(primary.password.length).toBeGreaterThanOrEqual(32);
    expect(primary.email).not.toBe(assignee.email);
    expect(primary.appMetadata.run_slug).toBe(assignee.appMetadata.run_slug);
  });

  it("accepts only exact CI owner, purpose, slug, principal, and namespace", () => {
    expect(() => assertValidE2EIdentity(validIdentity())).not.toThrow();

    for (const invalid of [
      { ...validIdentity(), email: "primary-e2e@bmhgroupkc.com" },
      { ...validIdentity(), runSlug: "reserved-browser-qa" },
      {
        ...validIdentity(),
        appMetadata: { ...validIdentity().appMetadata, owner: "browser-qa" },
      },
      {
        ...validIdentity(),
        appMetadata: { ...validIdentity().appMetadata, purpose: "browser-qa" },
      },
      { ...validIdentity(), password: "shared-default" },
    ]) {
      expect(() => assertValidE2EIdentity(invalid as E2EIdentity)).toThrow();
    }
  });

  it("requires a complete environment and exact GitHub coordinates", () => {
    expect(() =>
      ensureE2ERunEnvironment({
        NODE_ENV: "test",
        CI: "1",
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "2",
      }),
    ).toThrow(/must emit one job-scoped identity/);

    expect(() =>
      ensureE2ERunEnvironment({
        NODE_ENV: "test",
        CI: "1",
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "2",
        E2E_RUN_SLUG: RUN.runSlug,
        E2E_TEST_USER_EMAIL: RUN.email,
      }),
    ).toThrow(/environment is incomplete/);

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      CI: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "2",
      E2E_RUN_SLUG: RUN.runSlug,
      E2E_TEST_USER_EMAIL: RUN.email,
      E2E_TEST_USER_PASSWORD: RUN.password,
    };
    expect(ensureE2ERunEnvironment(env)).toEqual(RUN);
  });

  it("fails closed when an exact email carries foreign metadata", () => {
    const identity = validIdentity();
    expect(() =>
      assertExistingUserMatchesIdentity(
        {
          id: "foreign-user",
          email: identity.email,
          app_metadata: {
            ...identity.appMetadata,
            owner: "browser-qa",
          },
        },
        identity,
      ),
    ).toThrow(/does not match the exact CI E2E namespace/);
  });

  it("allows cleanup only for an exact nonempty ID, email, and metadata", () => {
    const identity = validIdentity();
    expect(() =>
      assertCleanupCandidate(
        {
          id: "ci-user-id",
          email: identity.email,
          app_metadata: identity.appMetadata,
        },
        identity,
      ),
    ).not.toThrow();
    expect(() =>
      assertCleanupCandidate(
        { id: "", email: identity.email, app_metadata: identity.appMetadata },
        identity,
      ),
    ).toThrow(/missing its auth user ID/);
  });

  it("protects browser-QA users by reserved namespace or metadata", () => {
    expect(
      isProtectedBrowserQaUser({
        id: "qa-a",
        email: "e2e-test@bmhgroupkc.com",
      }),
    ).toBe(true);
    expect(
      isProtectedBrowserQaUser({
        id: "qa-b",
        email: "unrelated@example.com",
        app_metadata: { purpose: "browser-qa" },
      }),
    ).toBe(true);
    expect(isProtectedBrowserQaUser({ id: "ci", email: RUN.email })).toBe(
      false,
    );
  });

  it("detects every protected browser-QA snapshot change", () => {
    const beforeUsers = [
      {
        id: "qa-a",
        email: "e2e-test@bmhgroupkc.com",
        updated_at: "2026-08-31T01:00:00Z",
        app_metadata: { owner: "browser-qa" },
      },
    ];
    const before = snapshotProtectedBrowserQaUsers(beforeUsers);
    const unchanged = snapshotProtectedBrowserQaUsers([
      ...beforeUsers,
      {
        id: "ci-user",
        email: RUN.email,
        app_metadata: validIdentity().appMetadata,
      },
    ]);
    expect(() =>
      assertBrowserQaSnapshotUnchanged(before, unchanged),
    ).not.toThrow();

    const changed = snapshotProtectedBrowserQaUsers([
      { ...beforeUsers[0], updated_at: "2026-08-31T02:00:00Z" },
    ]);
    expect(() => assertBrowserQaSnapshotUnchanged(before, changed)).toThrow(
      /browser-QA auth identities changed/,
    );

    const signedIn = snapshotProtectedBrowserQaUsers([
      { ...beforeUsers[0], last_sign_in_at: "2026-08-31T02:00:00Z" },
    ]);
    expect(() => assertBrowserQaSnapshotUnchanged(before, signedIn)).toThrow(
      /browser-QA auth identities changed/,
    );
  });
});
