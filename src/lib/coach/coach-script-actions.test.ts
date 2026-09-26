import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn(), select: vi.fn(), from: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from })),
}));

import { loadCoachCallScript } from "./coach-script-actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner-1" } }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.eq.mockReturnValue({ eq: mocks.eq, maybeSingle: mocks.maybeSingle });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.from.mockReturnValue({ select: mocks.select });
});

describe("loadCoachCallScript", () => {
  it("returns null for a null binding instead of substituting any revision", async () => {
    await expect(loadCoachCallScript("call-1")).resolves.toBeNull();
    expect(mocks.eq).toHaveBeenCalledWith("operator_user_id", "owner-1");
  });

  it("does not query a call row without an authenticated owner", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(loadCoachCallScript("call-1")).resolves.toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
