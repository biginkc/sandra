import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, headersMock, redirectMock } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    createClient: vi.fn(),
    headersMock: vi.fn(),
    // Mirror Next's real behavior: redirect() throws, so code after it
    // never runs.
    redirectMock: vi.fn((url: string): never => {
      throw new RedirectSignal(url);
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import { signIn, signInWithHugo } from "./actions";

/** Run an action and capture the URL it redirected to (or null). */
async function redirectedTo(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT:")) {
      return e.message.slice("NEXT_REDIRECT:".length);
    }
    throw e;
  }
  return null;
}

function ssoFormData(next?: string): FormData {
  const fd = new FormData();
  if (next !== undefined) fd.set("next", next);
  return fd;
}

beforeEach(() => {
  headersMock.mockResolvedValue(
    new Headers({ "x-forwarded-proto": "https", host: "sandra.test" }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("signInWithHugo", () => {
  describe("flag enforcement (fail closed)", () => {
    it("redirects to /login without touching Supabase when the flag is unset", async () => {
      vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData("/leads/5")),
      );
      expect(target).toBe("/login");
      expect(createClient).not.toHaveBeenCalled();
    });

    it('redirects to /login when the flag is any value other than "1"', async () => {
      vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "true");
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData()),
      );
      expect(target).toBe("/login");
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe("with the flag enabled", () => {
    const signInWithOAuth = vi.fn();

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
      signInWithOAuth.mockReset().mockResolvedValue({
        data: { url: "https://idp.bmh.test/authorize?abc" },
        error: null,
      });
      createClient.mockResolvedValue({ auth: { signInWithOAuth } });
    });

    it("wires the custom:hugo provider and callback redirect, then redirects to the IdP", async () => {
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData("/leads/5")),
      );
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "custom:hugo",
        options: {
          redirectTo: "https://sandra.test/auth/callback?next=%2Fleads%2F5",
        },
      });
      expect(target).toBe("https://idp.bmh.test/authorize?abc");
    });

    it("omits next from the callback URL when none is supplied", async () => {
      await redirectedTo(() => signInWithHugo(undefined, ssoFormData()));
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "custom:hugo",
        options: { redirectTo: "https://sandra.test/auth/callback" },
      });
    });

    it.each([
      "/\\evil.example",
      "//evil.com",
      "%2F%5Cevil.example",
      "https://evil.com/x",
      "/leads\r\nSet-Cookie: x=1",
      "/login?error=loop",
    ])("drops malicious or looping next value %j", async (bad) => {
      await redirectedTo(() => signInWithHugo(undefined, ssoFormData(bad)));
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "custom:hugo",
        options: { redirectTo: "https://sandra.test/auth/callback" },
      });
    });

    it("preserves the sanitized next on SSO failure so the password fallback keeps it", async () => {
      signInWithOAuth.mockResolvedValue({
        data: { url: null },
        error: { message: "provider unavailable" },
      });
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData("/leads/5")),
      );
      expect(target).toBe("/login?error=sso&next=%2Fleads%2F5");
    });

    it("falls back to a bare /login?error=sso when there is no next", async () => {
      signInWithOAuth.mockResolvedValue({
        data: { url: null },
        error: { message: "provider unavailable" },
      });
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData()),
      );
      expect(target).toBe("/login?error=sso");
    });

    it("does not carry a malicious next into the failure redirect", async () => {
      signInWithOAuth.mockResolvedValue({
        data: { url: null },
        error: { message: "provider unavailable" },
      });
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData("//evil.com")),
      );
      expect(target).toBe("/login?error=sso");
    });

    it("redirects to /login?error=sso when Supabase throws", async () => {
      createClient.mockRejectedValue(new Error("boom"));
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, ssoFormData()),
      );
      expect(target).toBe("/login?error=sso");
    });
  });
});

describe("signIn next handling", () => {
  const signInWithPassword = vi.fn();

  beforeEach(() => {
    signInWithPassword.mockReset().mockResolvedValue({ error: null });
    createClient.mockResolvedValue({ auth: { signInWithPassword } });
  });

  function loginFormData(next: string): FormData {
    const fd = new FormData();
    fd.set("email", "user@bmhgroupkc.com");
    fd.set("password", "hunter22");
    fd.set("next", next);
    return fd;
  }

  it("honors a safe same-site next", async () => {
    const target = await redirectedTo(() =>
      signIn(null, loginFormData("/leads/5")),
    );
    expect(target).toBe("/leads/5");
  });

  it.each([
    "/\\evil.example",
    "//evil.com",
    "%2F%5Cevil.example",
    "https://evil.com/x",
    "/leads\r\nSet-Cookie: x=1",
    "/login",
  ])("falls back to /dashboard for malicious next value %j", async (bad) => {
    const target = await redirectedTo(() => signIn(null, loginFormData(bad)));
    expect(target).toBe("/dashboard");
  });
});
