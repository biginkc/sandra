import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { GET } from "./route";

describe("auth callback route", () => {
  it.each([
    "token_hash=token-123&type=invite",
    "code=old-code&type=recovery",
    "code=old-code&type=signup",
    "code=old-code&type=magiclink",
  ])("rejects historical email auth without creating a session (%s)", async (query) => {
    const response = await GET(
      new NextRequest(`https://sandra.test/auth/callback?${query}`),
    );

    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=password_disabled",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  describe("Hugo code exchange and safe next", () => {
    const session = {
      access_token: "trusted-access-token",
      user: { email: "person@bmhgroupkc.com" },
    };

    function mockAuth(email = session.user.email) {
      const exchangeCodeForSession = vi.fn().mockResolvedValue({
        data: { session: { access_token: session.access_token, user: { email } } },
        error: null,
      });
      const signOut = vi.fn();
      const getClaims = vi.fn().mockResolvedValue({
        data: {
          claims: { amr: [{ method: "oauth", timestamp: 1 }] },
        },
        error: null,
      });
      createClient.mockResolvedValue({
        auth: { exchangeCodeForSession, getClaims, signOut },
      });
      return { exchangeCodeForSession, getClaims, signOut };
    }

    async function codeFlowLocation(next?: string) {
      mockAuth();
      const suffix = next === undefined ? "" : `&next=${encodeURIComponent(next)}`;
      const response = await GET(
        new NextRequest(`https://sandra.test/auth/callback?code=code-123${suffix}`),
      );
      return response.headers.get("location");
    }

    it("exchanges a Hugo code and follows a safe same-site next path", async () => {
      expect(await codeFlowLocation("/leads/123?view=map")).toBe(
        "https://sandra.test/leads/123?view=map",
      );
    });

    it.each([
      "//evil.com",
      "/\\evil.example",
      "https://evil.com/x",
      "/leads\r\nSet-Cookie: x=1",
      "/login?error=loop",
    ])("falls back to dashboard for unsafe next %j", async (next) => {
      expect(await codeFlowLocation(next)).toBe("https://sandra.test/dashboard");
    });

    it("falls back to dashboard when next is missing", async () => {
      expect(await codeFlowLocation()).toBe("https://sandra.test/dashboard");
    });

    it.each(["oauth", "oauth_provider/authorization_code"])(
      "accepts the verified OAuth auth method %s",
      async (method) => {
        const { getClaims, signOut } = mockAuth();
        getClaims.mockResolvedValue({
          data: { claims: { amr: [method] } },
          error: null,
        });
        const response = await GET(
          new NextRequest("https://sandra.test/auth/callback?code=hugo-code"),
        );
        expect(signOut).not.toHaveBeenCalled();
        expect(response.headers.get("location")).toBe(
          "https://sandra.test/dashboard",
        );
      },
    );

    it("signs out an email outside Sandra's allowed domain", async () => {
      const { signOut } = mockAuth("outsider@example.com");
      const response = await GET(
        new NextRequest("https://sandra.test/auth/callback?code=code-123"),
      );
      expect(signOut).toHaveBeenCalledOnce();
      expect(signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(response.headers.get("location")).toBe(
        "https://sandra.test/login?error=domain",
      );
    });

    it.each(["password", "magiclink", "recovery", "invite"])(
      "rejects a type-less code whose verified auth method is %s",
      async (method) => {
        const { getClaims, signOut } = mockAuth();
        getClaims.mockResolvedValue({
          data: { claims: { amr: [{ method, timestamp: 1 }] } },
          error: null,
        });
        const response = await GET(
          new NextRequest("https://sandra.test/auth/callback?code=old-email-code"),
        );
        expect(getClaims).toHaveBeenCalledWith("trusted-access-token");
        expect(signOut).toHaveBeenCalledWith({ scope: "local" });
        expect(response.headers.get("location")).toBe(
          "https://sandra.test/login?error=password_disabled",
        );
      },
    );

    it("reports an SSO error when the code exchange fails", async () => {
      createClient.mockResolvedValue({
        auth: {
          exchangeCodeForSession: vi.fn().mockResolvedValue({
            data: { session: null },
            error: { message: "invalid code" },
          }),
          getClaims: vi.fn(),
          signOut: vi.fn(),
        },
      });
      const response = await GET(
        new NextRequest("https://sandra.test/auth/callback?code=bad"),
      );
      expect(response.headers.get("location")).toBe(
        "https://sandra.test/login?error=sso",
      );
    });
  });
});
