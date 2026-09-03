import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient }));

import { isPublicPath, updateSession } from "./middleware";

function mockProtectedSession({
  memberships = [] as Array<{ user_id: string }>,
  membershipThrows = false,
  membershipError = null as { code?: string; message?: string } | null,
  legacyMemberships = [] as Array<{ user_id: string }>,
  signOutResult = { error: null } as { error: unknown },
  signOutThrows = false,
  authMethod = "oauth",
  identityProvider = "custom:hugo",
} = {}) {
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user: {
        id: "seeded-auth-user",
        email: "seeded@bmhgroupkc.com",
        identities: [
          {
            provider: identityProvider,
            last_sign_in_at: "2026-07-21T06:54:00.000Z",
          },
        ],
      },
    },
  });
  const getClaims = vi.fn().mockResolvedValue({
    data: {
      claims: { amr: [{ method: authMethod, timestamp: 1784616840 }] },
    },
    error: null,
  });
  const signOut = signOutThrows
    ? vi.fn().mockRejectedValue(new Error("sign-out storage failed"))
    : vi.fn().mockResolvedValue(signOutResult);
  let membershipQueryCount = 0;
  const limit = membershipThrows
    ? vi.fn().mockRejectedValue(new Error("membership unavailable"))
    : vi.fn().mockImplementation(async () => {
        membershipQueryCount += 1;
        if (membershipQueryCount === 1 && membershipError) {
          return { data: [], error: membershipError };
        }
        return {
          data:
            membershipQueryCount === 1
              ? memberships
              : legacyMemberships.length > 0
                ? legacyMemberships
                : memberships,
          error: null,
        };
      });
  const orgEq = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ eq: orgEq }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  createServerClient.mockReturnValue({
    auth: { getUser, getClaims, signOut },
    from,
  });
  return { getUser, getClaims, signOut, from, select, eq, orgEq, limit };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    "https://copflsklaefwzipsrjqz.supabase.co",
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("isPublicPath", () => {
  it("keeps browser-session OAuth routes behind Sandra membership", () => {
    expect(isPublicPath("/api/oauth/google/start")).toBe(false);
    expect(isPublicPath("/api/oauth/google/callback")).toBe(false);
    expect(isPublicPath("/api/oauth/slack/start")).toBe(false);
    expect(isPublicPath("/api/oauth/slack/callback")).toBe(false);
  });

  it("preserves independently authenticated webhook and cron exemptions", () => {
    expect(isPublicPath("/api/webhooks/slack/actions")).toBe(true);
    expect(isPublicPath("/api/cron/sequence-tick")).toBe(true);
  });

  it("allows signed Jitter internal API routes to handle their own auth", () => {
    expect(
      isPublicPath(
        "/api/internal/jitter/call-activities/by-jitter-attempt/attempt-1",
      ),
    ).toBe(true);
    expect(
      isPublicPath(
        "/api/internal/jitter/call-activities/call-activity-1/transcript",
      ),
    ).toBe(true);
  });

  it("allows signed Closer internal API routes to handle their own auth", () => {
    expect(
      isPublicPath(
        "/api/internal/closer/practice-outcomes/by-closer-attempt/attempt-1",
      ),
    ).toBe(true);
    expect(isPublicPath("/api/internal/closer/admin/debug")).toBe(false);
  });

  it("allows signed BMH Institute internal API routes to handle their own auth", () => {
    expect(
      isPublicPath(
        "/api/internal/bmh-institute/course-outcomes/by-course-completion/user-1%3Acourse-1",
      ),
    ).toBe(true);
    expect(isPublicPath("/api/internal/bmh-institute/admin/debug")).toBe(false);
  });

  it("keeps dashboard routes protected", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/leads/property-1")).toBe(false);
  });
});

describe("updateSession membership authorization", () => {
  it("allows a protected request only when the signed-in UID has a membership", async () => {
    const { signOut, eq } = mockProtectedSession({
      memberships: [{ user_id: "seeded-auth-user" }],
    });

    const response = await updateSession(
      new NextRequest("https://sandra.test/dashboard"),
    );

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("user_id", "seeded-auth-user");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("uses the legacy membership shape only for the local E2E bypass", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "1");
    const { signOut, limit } = mockProtectedSession({
      membershipError: {
        code: "PGRST204",
        message:
          "Could not find the 'access_status' column of 'memberships' in the schema cache",
      },
      memberships: [],
      legacyMemberships: [{ user_id: "seeded-auth-user" }],
    });

    const response = await updateSession(
      new NextRequest("https://sandra.test/dashboard"),
    );

    expect(response.status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("fails closed on a Hugo-column schema error outside the local E2E bypass", async () => {
    const { signOut, limit } = mockProtectedSession({
      membershipError: {
        code: "PGRST204",
        message:
          "Could not find the 'access_status' column of 'memberships' in the schema cache",
      },
      memberships: [],
    });

    const response = await updateSession(
      new NextRequest("https://sandra.test/dashboard"),
    );

    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=access",
    );
    expect(limit).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("rejects a password-authenticated member and explicitly expires the session", async () => {
    const { from, signOut } = mockProtectedSession({
      memberships: [{ user_id: "seeded-auth-user" }],
      authMethod: "password",
    });
    const request = new NextRequest("https://sandra.test/dashboard", {
      headers: {
        cookie:
          "sb-copflsklaefwzipsrjqz-auth-token.0=password-session-chunk",
      },
    });

    const response = await updateSession(request);

    expect(from).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=password_disabled",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "sb-copflsklaefwzipsrjqz-auth-token.0=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps the password rollback path working while Hugo is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    vi.stubEnv("NODE_ENV", "production");
    const { signOut, select, limit } = mockProtectedSession({
      memberships: [{ user_id: "seeded-auth-user" }],
      authMethod: "password",
    });

    const response = await updateSession(
      new NextRequest("https://sandra.test/dashboard"),
    );

    expect(response.status).toBe(200);
    expect(signOut).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith("user_id");
    expect(limit).toHaveBeenCalledOnce();
  });

  it("denies a seeded auth cookie when sign-out returns an error", async () => {
    const { signOut } = mockProtectedSession({
      signOutResult: { error: { message: "remote sign-out failed" } },
    });
    const request = new NextRequest("https://sandra.test/dashboard", {
      headers: {
        cookie:
          "sb-copflsklaefwzipsrjqz-auth-token.0=seeded-session-chunk",
      },
    });

    const response = await updateSession(request);

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=access",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "sb-copflsklaefwzipsrjqz-auth-token.0=",
    );
  });

  it("denies a seeded auth cookie when sign-out throws", async () => {
    const { signOut } = mockProtectedSession({ signOutThrows: true });
    const request = new NextRequest("https://sandra.test/leads", {
      headers: {
        cookie:
          "sb-copflsklaefwzipsrjqz-auth-token-code-verifier=seeded-verifier; sb-copflsklaefwzipsrjqz-auth-token=seeded-session",
      },
    });

    const response = await updateSession(request);

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=access",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "sb-copflsklaefwzipsrjqz-auth-token-code-verifier=",
    );
  });

  it("never redirects a Server Action POST — the action must return its own typed error", async () => {
    mockProtectedSession(); // no memberships: would otherwise deny+redirect
    const request = new NextRequest("https://sandra.test/settings/integrations", {
      method: "POST",
      headers: { "next-action": "abc123" },
    });

    const response = await updateSession(request);

    expect(response.headers.get("location")).toBeNull();
    expect(response.status).not.toBe(307);
  });

  it("never redirects an unauthenticated Server Action POST", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: null } });
    createServerClient.mockReturnValue({ auth: { getUser }, from: vi.fn() });
    const request = new NextRequest("https://sandra.test/settings/integrations", {
      method: "POST",
      headers: { "next-action": "abc123" },
    });

    const response = await updateSession(request);

    expect(response.headers.get("location")).toBeNull();
  });

  it("fails closed when the membership SDK throws", async () => {
    mockProtectedSession({ membershipThrows: true });

    const response = await updateSession(
      new NextRequest("https://sandra.test/import"),
    );

    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=access",
    );
  });

  it.each([
    "/api/oauth/google/start",
    "/api/oauth/google/callback?code=seeded&state=seeded",
    "/api/oauth/slack/start",
    "/api/oauth/slack/callback?code=seeded&state=seeded",
  ])("denies stale no-membership sessions before browser OAuth route %s", async (path) => {
    const { from, signOut } = mockProtectedSession();
    const response = await updateSession(
      new NextRequest(`https://sandra.test${path}`, {
        headers: {
          cookie:
            "sb-copflsklaefwzipsrjqz-auth-token.0=stale-session-chunk",
        },
      }),
    );

    expect(from).toHaveBeenCalledWith("memberships");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=access",
    );
  });

  it.each([
    "/api/oauth/google/start",
    "/api/oauth/google/callback?code=member&state=member",
    "/api/oauth/slack/start",
    "/api/oauth/slack/callback?code=member&state=member",
  ])("lets provisioned Hugo users reach browser OAuth route %s", async (path) => {
    const { signOut } = mockProtectedSession({
      memberships: [{ user_id: "seeded-auth-user" }],
    });

    const response = await updateSession(
      new NextRequest(`https://sandra.test${path}`),
    );

    expect(response.status).toBe(200);
    expect(signOut).not.toHaveBeenCalled();
  });

  it.each(["/login", "/auth/hugo", "/auth/callback?code=hugo"]) (
    "keeps the public login flow loop-free at %s",
    async (path) => {
      const { from, signOut } = mockProtectedSession();

      const response = await updateSession(
        new NextRequest(`https://sandra.test${path}`),
      );

      expect(response.status).toBe(200);
      expect(from).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
    },
  );
});
