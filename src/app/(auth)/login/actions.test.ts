import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, cookiesMock, cookieGet, cookieSet, headersMock, redirectMock } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    createClient: vi.fn(),
    cookiesMock: vi.fn(),
    cookieGet: vi.fn(),
    cookieSet: vi.fn(),
    headersMock: vi.fn(),
    redirectMock: vi.fn((url: string): never => {
      throw new RedirectSignal(url);
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("next/headers", () => ({ headers: headersMock, cookies: cookiesMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { requestPasswordReset, signIn, signInWithHugo } from "./actions";

async function redirectedTo(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) {
      return error.message.slice("NEXT_REDIRECT:".length);
    }
    throw error;
  }
  return null;
}

function formData(next?: string): FormData {
  const data = new FormData();
  if (next !== undefined) data.set("next", next);
  return data;
}

beforeEach(() => {
  headersMock.mockResolvedValue(
    new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "sandra.test",
    }),
  );
  cookieGet.mockReturnValue(undefined);
  cookiesMock.mockResolvedValue({ get: cookieGet, set: cookieSet });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("signInWithHugo", () => {
  it("fails closed without touching Supabase when the rollout flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    expect(await redirectedTo(() => signInWithHugo(undefined, formData()))).toBe(
      "/login?error=sso_disabled",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  describe("with Hugo enabled", () => {
    const signInWithOAuth = vi.fn();

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
      signInWithOAuth.mockReset().mockResolvedValue({
        data: { url: "https://hugo.test/authorize" },
        error: null,
      });
      createClient.mockImplementation(async (options) => {
        options?.onCookieMutation?.({
          name: "sb-copflsklaefwzipsrjqz-auth-token-code-verifier",
          value: "flow-specific-verifier",
          options: {},
        });
        return { auth: { signInWithOAuth } };
      });
    });

    it("uses custom:hugo and the current Sandra callback", async () => {
      const target = await redirectedTo(() =>
        signInWithHugo(undefined, formData("/leads/5")),
      );
      const request = signInWithOAuth.mock.calls[0][0];
      expect(request.provider).toBe("custom:hugo");
      const redirectTo = new URL(request.options.redirectTo);
      expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(
        "https://sandra.test/auth/callback",
      );
      expect(redirectTo.searchParams.get("next")).toBe("/leads/5");
      expect(redirectTo.searchParams.get("hugo_source")).toBe("hugo");
      const nonce = redirectTo.searchParams.get("hugo_flow");
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookieSet).toHaveBeenCalledWith(
        `sandra_hugo_flow_${nonce}`,
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 600,
        }),
      );
      expect(target).toBe("https://hugo.test/authorize");
    });

    it.each([
      "/\\evil.example",
      "//evil.com",
      "https://evil.com/x",
      "/leads\r\nSet-Cookie: x=1",
      "/login?error=loop",
    ])("drops unsafe next value %j", async (next) => {
      await redirectedTo(() => signInWithHugo(undefined, formData(next)));
      const redirectTo = new URL(
        signInWithOAuth.mock.calls[0][0].options.redirectTo,
      );
      expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(
        "https://sandra.test/auth/callback",
      );
      expect(redirectTo.searchParams.get("next")).toBeNull();
      expect(redirectTo.searchParams.get("hugo_flow")).toBeTruthy();
    });

    it("keeps a sanitized next when Hugo initiation fails", async () => {
      signInWithOAuth.mockResolvedValue({
        data: { url: null },
        error: { message: "provider unavailable" },
      });
      expect(
        await redirectedTo(() =>
          signInWithHugo(undefined, formData("/leads/5")),
        ),
      ).toBe("/login?error=sso&next=%2Fleads%2F5");
    });

    it("keeps concurrent tab PKCE state in separate flow cookies", async () => {
      const [first, second] = await Promise.all([
        redirectedTo(() => signInWithHugo(undefined, formData("/leads/5"))),
        redirectedTo(() => signInWithHugo(undefined, formData("/leads/6"))),
      ]);

      expect(first).toBe("https://hugo.test/authorize");
      expect(second).toBe("https://hugo.test/authorize");
      const names = cookieSet.mock.calls.map(([name]) => name);
      expect(names).toHaveLength(2);
      expect(names[0]).toMatch(/^sandra_hugo_flow_[A-Za-z0-9_-]{43}$/);
      expect(names[1]).toMatch(/^sandra_hugo_flow_[A-Za-z0-9_-]{43}$/);
      expect(names[0]).not.toBe(names[1]);
    });
  });
});

describe("password rollback login", () => {
  it("rejects direct password action calls after Hugo is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
    const data = new FormData();
    data.set("email", "person@bmhgroupkc.com");
    data.set("password", "not-a-real-password");

    const result = await signIn(null, data);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PASSWORD_DISABLED" },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("keeps password recovery available as a flag-off rollback path", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    createClient.mockResolvedValue({ auth: { resetPasswordForEmail } });
    const data = new FormData();
    data.set("email", "person@bmhgroupkc.com");

    await expect(requestPasswordReset(null, data)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      "person@bmhgroupkc.com",
      { redirectTo: "https://sandra.test/auth/callback" },
    );
  });

  it("rejects password recovery calls after Hugo is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
    const data = new FormData();
    data.set("email", "person@bmhgroupkc.com");

    const result = await requestPasswordReset(null, data);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PASSWORD_DISABLED" },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("keeps password login available as a flag-off rollback path", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    const signInWithPassword = vi.fn().mockResolvedValue({ error: null });
    createClient.mockResolvedValue({ auth: { signInWithPassword } });
    const data = new FormData();
    data.set("email", "person@bmhgroupkc.com");
    data.set("password", "rollback-password");
    data.set("next", "/dashboard");

    expect(await redirectedTo(() => signIn(null, data))).toBe("/dashboard");
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "person@bmhgroupkc.com",
      password: "rollback-password",
    });
  });
});
