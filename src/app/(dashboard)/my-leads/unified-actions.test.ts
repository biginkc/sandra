import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  kpis: vi.fn(),
  enabled: vi.fn(),
  page: vi.fn(),
  facts: vi.fn(),
  pin: vi.fn(),
  dismiss: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("@/lib/my-leads/queries", () => ({
  MyLeadsReadError: class MyLeadsReadError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  myLeadsViewer: mocks.viewer,
  getAcquisitionKpis: mocks.kpis,
}));
vi.mock("@/lib/my-leads/unified-queue", () => ({ unifiedQueueEnabled: mocks.enabled }));
vi.mock("@/lib/my-leads/work-queue", () => ({
  getWorkPage: mocks.page,
  getWorkFacts: mocks.facts,
  setPin: mocks.pin,
  dismissBroken: mocks.dismiss,
}));

import { MyLeadsReadError } from "@/lib/my-leads/queries";
import { dismissBroken, loadUnifiedKpis, loadWorkFacts, loadWorkPage, pinLead } from "./unified-actions";

const M = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const QUERY = { tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 } as const;
const OFF = { ok: false, code: "FEATURE_DISABLED", message: expect.any(String) };

const VIEWER = { userId: M, orgId: "org-1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockResolvedValue(VIEWER);
  mocks.enabled.mockResolvedValue(true);
});

describe("flag off", () => {
  it("every action returns FEATURE_DISABLED without touching the data layer", async () => {
    mocks.enabled.mockResolvedValue(false);
    expect(await loadWorkPage({ memberId: M, query: QUERY })).toEqual(OFF);
    expect(await loadWorkFacts({ memberId: M, ids: [P] })).toEqual(OFF);
    expect(await pinLead({ memberId: M, propertyId: P, action: "pin" })).toEqual(OFF);
    expect(await dismissBroken({ memberId: M, propertyId: P, sourceId: S })).toEqual(OFF);
    expect(await loadUnifiedKpis({ memberId: M })).toEqual(OFF);
    for (const m of [mocks.page, mocks.facts, mocks.pin, mocks.dismiss, mocks.kpis]) expect(m).not.toHaveBeenCalled();
    expect(mocks.enabled).toHaveBeenCalledWith("org-1");
  });
});

describe("flag on", () => {
  it("loads a page and facts", async () => {
    mocks.page.mockResolvedValue({ rows: [], ids: [] });
    expect(await loadWorkPage({ memberId: M, query: QUERY })).toEqual({ ok: true, page: { rows: [], ids: [] } });
    expect(mocks.page).toHaveBeenCalledWith({ memberId: M, query: QUERY, viewer: VIEWER });
    mocks.facts.mockResolvedValue({ rows: [], missing: [P], snapshotAt: "t" });
    expect(await loadWorkFacts({ memberId: M, ids: [P] })).toEqual({ ok: true, facts: { rows: [], missing: [P], snapshotAt: "t" } });
    expect(mocks.facts).toHaveBeenCalledWith(M, [P], VIEWER);
  });

  it("pins, clears and dismisses", async () => {
    mocks.pin.mockResolvedValue({ pinnedAt: "2026-10-15T15:00:00Z" });
    expect(await pinLead({ memberId: M, propertyId: P, action: "pin" })).toEqual({ ok: true, pinnedAt: "2026-10-15T15:00:00Z" });
    expect(mocks.pin).toHaveBeenCalledWith(M, P, "pin", VIEWER);
    mocks.dismiss.mockResolvedValue(undefined);
    expect(await dismissBroken({ memberId: M, propertyId: P, sourceId: S })).toEqual({ ok: true });
    expect(mocks.dismiss).toHaveBeenCalledWith(M, P, S, VIEWER);
  });

  it("resolves the viewer once per action", async () => {
    mocks.page.mockResolvedValue({ rows: [], ids: [] });
    mocks.facts.mockResolvedValue({ rows: [], missing: [], snapshotAt: "t" });
    mocks.pin.mockResolvedValue({ pinnedAt: null });
    mocks.dismiss.mockResolvedValue(undefined);
    mocks.kpis.mockResolvedValue({});
    await loadWorkPage({ memberId: M, query: QUERY });
    await loadWorkFacts({ memberId: M, ids: [P] });
    await pinLead({ memberId: M, propertyId: P, action: "clear" });
    await dismissBroken({ memberId: M, propertyId: P, sourceId: S });
    await loadUnifiedKpis({ memberId: M });
    expect(mocks.viewer).toHaveBeenCalledTimes(5);
  });

  it("rejects an unknown pin action before anything runs", async () => {
    const result = await pinLead({ memberId: M, propertyId: P, action: "snooze" as never });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it("loads today's KPIs", async () => {
    mocks.kpis.mockResolvedValue({ attempts: 3 });
    expect(await loadUnifiedKpis({ memberId: M })).toEqual({ ok: true, kpis: { attempts: 3 } });
    expect(mocks.kpis).toHaveBeenCalledWith({ memberId: M, period: "today", viewer: VIEWER });
  });

  it("returns the typed code and message of a read error and reports it", async () => {
    mocks.pin.mockRejectedValue(new MyLeadsReadError("FORBIDDEN", "Open your own queue to change Call today."));
    expect(await pinLead({ memberId: P, propertyId: P, action: "pin" })).toEqual({
      ok: false, code: "FORBIDDEN", message: "Open your own queue to change Call today.",
    });
    expect(mocks.report).toHaveBeenCalledOnce();
  });

  it("hides the message of an unexpected error", async () => {
    mocks.page.mockRejectedValue(new Error("private details"));
    const result = await loadWorkPage({ memberId: M, query: QUERY });
    expect(result).toEqual({ ok: false, code: "READ_FAILED", message: "My Leads could not load. Please retry." });
  });

  it("fails closed when the viewer cannot be resolved", async () => {
    mocks.viewer.mockRejectedValue(new MyLeadsReadError("UNAUTHENTICATED", "Sign in to view My Leads."));
    expect(await loadUnifiedKpis({ memberId: M })).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(mocks.kpis).not.toHaveBeenCalled();
  });
});
