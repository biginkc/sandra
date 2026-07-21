import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient }));

import { isPublicPath, updateSession } from "./middleware";

function mockProtectedSession({
  memberships = [] as Array<{ user_id: string }>,
  membershipThrows = false,
  signOutResult = { error: null } as { error: unknown },
  signOutThrows = false,
} = {}) {
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user: {
        id: "seeded-auth-user",
        email: "seeded@bmhgroupkc.com",
      },
    },
  });
  const signOut = signOutThrows
    ? vi.fn().mockRejectedValue(new Error("sign-out storage failed"))
    : vi.fn().mockResolvedValue(signOutResult);
  const limit = membershipThrows
    ? vi.fn().mockRejectedValue(new Error("membership unavailable"))
    : vi.fn().mockResolvedValue({ data: memberships, error: null });
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  createServerClient.mockReturnValue({ auth: { getUser, signOut }, from });
  return { getUser, signOut, from, select, eq, limit };
}

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
