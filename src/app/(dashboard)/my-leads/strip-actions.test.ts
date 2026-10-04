import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallNext: vi.fn(),
  getTriage: vi.fn(),
  setCallNextOverride: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("@/lib/my-leads/call-next", () => ({
  getCallNext: mocks.getCallNext,
  getTriage: mocks.getTriage,
  setCallNextOverride: mocks.setCallNextOverride,
  STRIP_OVERRIDE_ACTIONS: ["call_today", "not_today", "clear"],
}));
vi.mock("@/lib/my-leads/queries", () => ({
  MyLeadsReadError: class MyLeadsReadError extends Error {},
}));

import { loadCallNext, loadTriage, setStripOverride } from "./strip-actions";

beforeEach(() => vi.resetAllMocks());

describe("strip actions", () => {
  it("rejects an unknown action before touching the RPC layer", async () => {
    expect(await setStripOverride({ memberId: "m", propertyId: "p", action: "snooze" as never })).toEqual({
      ok: false,
      message: "That action is not available.",
    });
    expect(mocks.setCallNextOverride).not.toHaveBeenCalled();
  });

  it("returns the database-computed expiry on success", async () => {
    mocks.setCallNextOverride.mockResolvedValue({ until: "2026-10-06T05:00:00Z" });
    expect(await setStripOverride({ memberId: "m", propertyId: "p", action: "call_today" })).toEqual({
      ok: true,
      until: "2026-10-06T05:00:00Z",
    });
  });

  it("reports a failure and returns a generic message for an unexpected error", async () => {
    mocks.setCallNextOverride.mockRejectedValue(new Error("private details"));
    const result = await setStripOverride({ memberId: "m", propertyId: "p", action: "not_today" });
    expect(result).toEqual({ ok: false, message: "The change could not be saved. Please retry." });
    expect(mocks.report).toHaveBeenCalledOnce();
  });

  it("loads the strip and the triage list, null meaning off", async () => {
    mocks.getCallNext.mockResolvedValue(null);
    expect(await loadCallNext("m")).toEqual({ ok: true, strip: null });
    mocks.getTriage.mockResolvedValue({ rows: [], totalCount: 0, cursor: null });
    expect(await loadTriage("m", null)).toEqual({ ok: true, triage: { rows: [], totalCount: 0, cursor: null } });
    mocks.getTriage.mockRejectedValue(new Error("x"));
    expect(await loadTriage("m")).toMatchObject({ ok: false });
  });
});
