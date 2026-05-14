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
});
