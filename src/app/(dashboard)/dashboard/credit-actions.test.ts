import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createAdminClient: vi.fn(() => ({ role: "service" })),
  capture: vi.fn(),
  isAdminEmail: vi.fn(),
  revalidatePath: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/skip-trace/balance", () => ({
  captureSkipTraceBalanceSnapshot: mocks.capture,
}));
vi.mock("@/lib/auth/allowlist", () => ({
  isAdminEmail: mocks.isAdminEmail,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { refreshSkipTraceBalanceAction } from "./credit-actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({
    data: { user: { email: "admin@example.test" } },
  });
  mocks.isAdminEmail.mockReturnValue(true);
});

describe("refreshSkipTraceBalanceAction", () => {
  it("requires authentication", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(refreshSkipTraceBalanceAction()).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("denies a non-admin before creating a service-role client", async () => {
    mocks.isAdminEmail.mockReturnValue(false);
    await expect(refreshSkipTraceBalanceAction()).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("refreshes, stores, and revalidates for an admin", async () => {
    mocks.capture.mockResolvedValue({
      available: true,
      credits: 321,
      tier: "ok",
      capturedAt: "2026-08-10T18:30:00.000Z",
    });
    await expect(refreshSkipTraceBalanceAction()).resolves.toEqual({
      ok: true,
      data: { credits: 321, capturedAt: "2026-08-10T18:30:00.000Z" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("surfaces a safe error and does not revalidate after provider failure", async () => {
    mocks.capture.mockRejectedValue(new Error("secret provider detail"));
    await expect(refreshSkipTraceBalanceAction()).resolves.toEqual({
      ok: false,
      error: {
        code: "BALANCE_REFRESH_FAILED",
        message:
          "Could not refresh provider credits. The last reading is unchanged.",
      },
    });
    expect(mocks.reportError).toHaveBeenCalledOnce();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
