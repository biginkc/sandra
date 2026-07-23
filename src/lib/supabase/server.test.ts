import { afterEach, describe, expect, it, vi } from "vitest";

const { cookies, createServerClient } = vi.hoisted(() => ({
  cookies: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@supabase/ssr", () => ({ createServerClient }));

import { createClient } from "./server";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createClient cookie overrides", () => {
  it("uses the current flow's PKCE verifier without discarding other cookies", async () => {
    cookies.mockResolvedValue({
      getAll: () => [
        { name: "session", value: "keep-me" },
        { name: "pkce", value: "wrong-tab" },
      ],
      set: vi.fn(),
    });
    createServerClient.mockImplementation((_url, _key, options) =>
      options.cookies.getAll(),
    );

    const result = await createClient({
      cookieOverrides: [{ name: "pkce", value: "current-tab" }],
    });

    expect(result).toEqual([
      { name: "session", value: "keep-me" },
      { name: "pkce", value: "current-tab" },
    ]);
  });
});
