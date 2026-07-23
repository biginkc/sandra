import { afterEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { setPassword } from "./actions";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("setPassword rollback action", () => {
  it("updates a recovery password only while Hugo is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    createClient.mockResolvedValue({ auth: { updateUser } });

    await expect(setPassword("long-enough-password")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(updateUser).toHaveBeenCalledWith({
      password: "long-enough-password",
    });
  });

  it("rejects direct password updates after Hugo is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");

    await expect(setPassword("long-enough-password")).resolves.toMatchObject({
      ok: false,
      error: { code: "PASSWORD_DISABLED" },
    });
    expect(createClient).not.toHaveBeenCalled();
  });
});
