import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

import { GET } from "./route";

describe("auth callback route", () => {
  it("verifies token_hash invite callbacks and sends invited users to set password", async () => {
    const verifyOtp = vi.fn().mockResolvedValue({
      data: {
        session: { user: { email: "newperson@bmhgroupkc.com" } },
      },
      error: null,
    });
    const signOut = vi.fn();
    createClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: vi.fn(),
        verifyOtp,
        signOut,
      },
    });

    const response = await GET(
      new NextRequest(
        "https://sandra.test/auth/callback?token_hash=token-123&type=invite",
      ),
    );

    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "token-123",
      type: "invite",
    });
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/auth/set-password",
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  describe("next param open-redirect hardening", () => {
    const session = { user: { email: "person@bmhgroupkc.com" } };

    function mockAuth() {
      createClient.mockResolvedValue({
        auth: {
          exchangeCodeForSession: vi
            .fn()
            .mockResolvedValue({ data: { session }, error: null }),
          verifyOtp: vi
            .fn()
            .mockResolvedValue({ data: { session }, error: null }),
          signOut: vi.fn(),
        },
      });
    }

    async function codeFlowLocation(next: string) {
      mockAuth();
      const response = await GET(
        new NextRequest(
          `https://sandra.test/auth/callback?code=code-123&next=${encodeURIComponent(next)}`,
        ),
      );
      return response.headers.get("location");
    }

    async function otpFlowLocation(next: string) {
      mockAuth();
      const response = await GET(
        new NextRequest(
          `https://sandra.test/auth/callback?token_hash=token-123&type=magiclink&next=${encodeURIComponent(next)}`,
        ),
      );
      return response.headers.get("location");
    }

    it("follows a safe same-site next path", async () => {
      expect(await codeFlowLocation("/leads/123?view=map")).toBe(
        "https://sandra.test/leads/123?view=map",
      );
      expect(await otpFlowLocation("/properties")).toBe(
        "https://sandra.test/properties",
      );
    });

    it("rejects scheme-relative next (//evil.com)", async () => {
      expect(await codeFlowLocation("//evil.com")).toBe(
        "https://sandra.test/dashboard",
      );
      expect(await otpFlowLocation("//evil.com/path")).toBe(
        "https://sandra.test/dashboard",
      );
    });

    it("rejects backslash next (/\\evil.example)", async () => {
      expect(await codeFlowLocation("/\\evil.example")).toBe(
        "https://sandra.test/dashboard",
      );
      expect(await otpFlowLocation("/\\/evil.example")).toBe(
        "https://sandra.test/dashboard",
      );
    });

    it("rejects absolute URLs and control characters", async () => {
      expect(await codeFlowLocation("https://evil.com/x")).toBe(
        "https://sandra.test/dashboard",
      );
      expect(await codeFlowLocation("/leads\r\nSet-Cookie: x=1")).toBe(
        "https://sandra.test/dashboard",
      );
    });

    it("falls back to /dashboard when next is missing", async () => {
      mockAuth();
      const response = await GET(
        new NextRequest("https://sandra.test/auth/callback?code=code-123"),
      );
      expect(response.headers.get("location")).toBe(
        "https://sandra.test/dashboard",
      );
    });
  });
});
