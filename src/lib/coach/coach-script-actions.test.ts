import { beforeEach, describe, expect, it, vi } from "vitest";
import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";

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

  it("returns a binding only when the cached bundle recomputes to the index-bound digest", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        script_slug: closrOutbound123Ref.slug,
        script_revision: closrOutbound123Ref.revision,
        script_digest: closrOutbound123Ref.digest,
        coach_script_revisions: { bundle: closrOutbound123Bundle },
      },
      error: null,
    });

    await expect(loadCoachCallScript("call-1")).resolves.toEqual({
      status: "bound",
      binding: { ref: closrOutbound123Ref, bundle: closrOutbound123Bundle },
    });
  });

  it("rejects a structurally valid cached bundle whose JSON was tampered after the call index bound its digest", async () => {
    const tampered = structuredClone(closrOutbound123Bundle);
    // Unknown integer fields are valid forward-compatible bundle content, so
    // this proves the rejection comes from recomputing the canonical digest,
    // not merely from schema validation failing first.
    (tampered.sections as Record<string, unknown>).optional_future_field = 1;
    mocks.maybeSingle.mockResolvedValue({
      data: {
        script_slug: closrOutbound123Ref.slug,
        script_revision: closrOutbound123Ref.revision,
        script_digest: closrOutbound123Ref.digest,
        coach_script_revisions: { bundle: tampered },
      },
      error: null,
    });

    await expect(loadCoachCallScript("call-1")).resolves.toEqual({ status: "unavailable" });
  });
});
