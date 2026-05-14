import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace, createBrowserClient } = vi.hoisted(() => ({
  replace: vi.fn(),
  createBrowserClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { AcceptInviteClient } from "./accept-invite-client";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  window.history.replaceState(null, "", "/auth/accept-invite");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("AcceptInviteClient", () => {
  it("sets the Supabase cookie session from invite URL fragments", async () => {
    const setSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          user: { email: "newperson@bmhgroupkc.com" },
        },
      },
      error: null,
    });
    const signOut = vi.fn();
    createBrowserClient.mockReturnValue({
      auth: {
        setSession,
        signOut,
      },
    });
    window.history.replaceState(
      null,
      "",
      "/auth/accept-invite#access_token=access-token&refresh_token=refresh-token&type=invite",
    );

    render(<AcceptInviteClient />);

    expect(
      screen.getByText("Accepting your Sandra invite..."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(setSession).toHaveBeenCalledWith({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
      expect(replace).toHaveBeenCalledWith("/auth/set-password");
    });
    expect(window.location.hash).toBe("");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects invite callbacks without session tokens", async () => {
    createBrowserClient.mockReturnValue({
      auth: {
        setSession: vi.fn(),
        signOut: vi.fn(),
      },
    });
    window.history.replaceState(null, "", "/auth/accept-invite#type=invite");

    render(<AcceptInviteClient />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login?error=invite_failed");
    });
  });
});
