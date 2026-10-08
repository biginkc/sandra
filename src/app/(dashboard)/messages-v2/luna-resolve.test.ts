import { describe, expect, it, vi } from "vitest";

import { err, ok } from "@/lib/errors/result";

import { applyLunaSuggestion, rejectLunaSuggestion, type LunaResolveDeps } from "./luna-resolve";

type Table = "luna_suggestions" | "jev_lead_decisions" | "ai_disposition_reviews";

function fakeAdmin(rows: {
  suggestion?: Record<string, unknown> | null;
  decision?: Record<string, unknown> | null;
  review?: Record<string, unknown> | null;
  updateRows?: unknown[];
  updateError?: { message: string } | null;
}) {
  const updates: Array<{ patch: unknown; filters: string[] }> = [];
  const admin = {
    from: (table: Table) => {
      const filters: string[] = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push(`${c}=${String(v)}`); return b; },
        is: (c: string) => { filters.push(`${c} is null`); return b; },
        maybeSingle: async () => ({
          data: table === "luna_suggestions" ? rows.suggestion ?? null : table === "jev_lead_decisions" ? rows.decision ?? null : rows.review ?? null,
          error: null,
        }),
        update: (patch: unknown) => { updates.push({ patch, filters }); return b; },
        then: (res: (v: { data: unknown; error: unknown }) => void) => res({ data: rows.updateRows ?? [{ id: "s-1" }], error: rows.updateError ?? null }),
      };
      return b;
    },
  };
  return { admin: admin as never, updates };
}

const suggestion = (outcome: string, extra: Record<string, unknown> = {}) => ({
  id: "s-1", org_id: "org-1", inbound_message_id: "msg-1", outcome, accepted_at: null, rejected_at: null, ...extra,
});

function deps(admin: never, over: Partial<LunaResolveDeps> = {}): LunaResolveDeps {
  return {
    admin,
    orgId: "org-1",
    userId: "u-1",
    confirm: vi.fn(async () => ok({ status: "confirmed" })),
    correct: vi.fn(async (_s, _i, outcome) => ok({ status: "corrected", resolvedOutcome: outcome })),
    reportError: vi.fn(),
    now: () => "2026-10-07T12:00:00Z",
    ...over,
  };
}

describe("applyLunaSuggestion", () => {
  it("corrects the pending decision to Luna's outcome through the existing path, then records acceptance", async () => {
    const { admin, updates } = fakeAdmin({ suggestion: suggestion("new_lead"), decision: { id: "d-1", proposed_outcome: "nurture" } });
    const d = deps(admin);
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r).toEqual(ok({ status: "corrected", resolvedOutcome: "new_lead" }));
    expect(d.correct).toHaveBeenCalledWith("jev_lead_decision", "d-1", "new_lead", "Applied Luna suggestion");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(updates).toEqual([
      { patch: { accepted_at: "2026-10-07T12:00:00Z", accepted_by: "u-1", applied_outcome: "new_lead" }, filters: ["id=s-1", "accepted_at is null", "rejected_at is null"] },
    ]);
  });

  it("confirms (not corrects) when Luna agrees with what Jev proposed", async () => {
    const { admin } = fakeAdmin({ suggestion: suggestion("not_interested"), review: { id: "r-1", disposition: "not_interested" } });
    const d = deps(admin);
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r).toEqual(ok({ status: "confirmed", resolvedOutcome: "not_interested" }));
    expect(d.confirm).toHaveBeenCalledWith("ai_disposition_review", "r-1");
    expect(d.correct).not.toHaveBeenCalled();
  });

  it("uses the disposition review when that is what is pending", async () => {
    const { admin } = fakeAdmin({ suggestion: suggestion("wrong_number"), review: { id: "r-1", disposition: "not_interested" } });
    const d = deps(admin);
    await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(d.correct).toHaveBeenCalledWith("ai_disposition_review", "r-1", "wrong_number", "Applied Luna suggestion");
  });

  it.each(["opted_out", "dnc"])("refuses %s: that needs the human confirm flow, and nothing is called", async (outcome) => {
    const { admin, updates } = fakeAdmin({ suggestion: suggestion(outcome), review: { id: "r-1", disposition: outcome } });
    const d = deps(admin);
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "LUNA_HUMAN_CONFIRM_REQUIRED" } });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.correct).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it.each(["unclear", "bad_number"])("refuses non-actionable %s", async (outcome) => {
    const { admin } = fakeAdmin({ suggestion: suggestion(outcome) });
    const r = await applyLunaSuggestion(deps(admin), { suggestionId: "s-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "LUNA_NOT_ACTIONABLE" } });
  });

  it("refuses when nothing is pending, and applies nothing", async () => {
    const { admin, updates } = fakeAdmin({ suggestion: suggestion("nurture") });
    const d = deps(admin);
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "LUNA_NO_PENDING_ITEM" } });
    expect(d.correct).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("refuses an already handled suggestion and another org's suggestion", async () => {
    const handled = fakeAdmin({ suggestion: suggestion("nurture", { accepted_at: "x" }) });
    expect(await applyLunaSuggestion(deps(handled.admin), { suggestionId: "s-1" })).toMatchObject({ ok: false, error: { code: "LUNA_ALREADY_RESOLVED" } });
    const other = fakeAdmin({ suggestion: suggestion("nurture", { org_id: "org-2" }) });
    expect(await applyLunaSuggestion(deps(other.admin), { suggestionId: "s-1" })).toMatchObject({ ok: false, error: { code: "LUNA_NOT_FOUND" } });
  });

  it("passes the existing path's refusal through untouched and records no acceptance", async () => {
    const { admin, updates } = fakeAdmin({ suggestion: suggestion("new_lead"), decision: { id: "d-1", proposed_outcome: "nurture" } });
    const d = deps(admin, { correct: vi.fn(async () => err({ code: "JEV_CORRECTION_FAILED", message: "This property is permanently locked and cannot be promoted." })) });
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "JEV_CORRECTION_FAILED" } });
    expect(updates).toEqual([]);
  });

  it("still reports success when only the acceptance bookkeeping fails", async () => {
    const { admin } = fakeAdmin({ suggestion: suggestion("new_lead"), decision: { id: "d-1", proposed_outcome: "nurture" }, updateError: { message: "db" } });
    const d = deps(admin);
    const r = await applyLunaSuggestion(d, { suggestionId: "s-1" });
    expect(r.ok).toBe(true);
    expect(d.reportError).toHaveBeenCalled();
  });
});

describe("rejectLunaSuggestion", () => {
  it("records who said 'not this' and applies nothing", async () => {
    const { admin, updates } = fakeAdmin({ suggestion: suggestion("nurture") });
    const d = deps(admin);
    expect(await rejectLunaSuggestion(d, { suggestionId: "s-1" })).toEqual(ok(null));
    expect(updates).toEqual([
      { patch: { rejected_at: "2026-10-07T12:00:00Z", rejected_by: "u-1" }, filters: ["id=s-1", "accepted_at is null", "rejected_at is null"] },
    ]);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.correct).not.toHaveBeenCalled();
  });

  it("reports already-handled when the guarded update matched nothing", async () => {
    const { admin } = fakeAdmin({ suggestion: suggestion("nurture"), updateRows: [] });
    expect(await rejectLunaSuggestion(deps(admin), { suggestionId: "s-1" })).toMatchObject({ ok: false, error: { code: "LUNA_ALREADY_RESOLVED" } });
  });
});
