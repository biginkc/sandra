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
  it("reports a missing index row as pending so the client can await the after() write", async () => {
    await expect(loadCoachCallScript("call-1")).resolves.toEqual({ status: "pending" });
    expect(mocks.eq).toHaveBeenCalledWith("operator_user_id", "owner-1");
  });

  it("reports an existing null binding as unavailable instead of substituting any revision", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { script_slug: null, script_revision: null, script_digest: null, coach_script_revisions: null },
      error: null,
    });
    await expect(loadCoachCallScript("call-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("does not query a call row without an authenticated owner", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(loadCoachCallScript("call-1")).resolves.toEqual({ status: "error" });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
