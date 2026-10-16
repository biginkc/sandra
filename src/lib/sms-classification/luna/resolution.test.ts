import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportErrorMock } = vi.hoisted(() => ({ reportErrorMock: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: reportErrorMock }));

import { recordLunaResolutionForItem } from "./resolution";

function clients(opts: {
  item?: Record<string, string | null> | null;
  suggestion?: Record<string, unknown> | null;
  suggestionError?: { code?: string; message: string };
}) {
  const updates: Array<{ patch: unknown; filters: string[] }> = [];
  const reader = {
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: opts.item === undefined ? { org_id: "org-1", source_inbound_message_id: "msg-1", proposed_outcome: "nurture", disposition: "not_interested" } : opts.item, error: null }),
      };
      return b;
    },
  };
  const admin = {
    from: () => {
      const filters: string[] = [];
      const b = {
        select: () => b,
        eq: () => b,
        is: (c: string) => { filters.push(`${c} is null`); return b; },
        maybeSingle: async () => ({ data: opts.suggestion === undefined ? { id: "s-1", outcome: "nurture", accepted_at: null, rejected_at: null, applied_outcome: null } : opts.suggestion, error: opts.suggestionError ?? null }),
        update: (patch: unknown) => { updates.push({ patch, filters }); return b; },
        then: (res: (v: { error: null }) => void) => res({ error: null }),
      };
      return b;
    },
  };
  return { reader: reader as never, admin: admin as never, updates };
}

const base = { source: "jev_lead_decision" as const, itemId: "d-1", userId: "u-1", now: "2026-10-07T12:00:00Z" };

beforeEach(() => vi.clearAllMocks());

describe("recordLunaResolutionForItem", () => {
  it("records a rejection with the applied outcome when the human chose differently", async () => {
    const { reader, admin, updates } = clients({});
    await recordLunaResolutionForItem(reader, admin, { ...base, appliedOutcome: "not_interested" });
    expect(updates).toEqual([
      { patch: { rejected_at: base.now, rejected_by: "u-1", applied_outcome: "not_interested" }, filters: ["accepted_at is null", "rejected_at is null"] },
    ]);
  });

  it("records only the applied outcome when the human chose the same thing", async () => {
    const { reader, admin, updates } = clients({});
    await recordLunaResolutionForItem(reader, admin, { ...base, appliedOutcome: "nurture" });
    expect(updates[0].patch).toEqual({ applied_outcome: "nurture" });
  });

  it("reads the applied outcome from the item on a confirm", async () => {
    const { reader, admin, updates } = clients({ item: { org_id: "org-1", source_inbound_message_id: "msg-1", proposed_outcome: "new_lead" } });
    await recordLunaResolutionForItem(reader, admin, { ...base, appliedOutcome: null });
    expect(updates[0].patch).toMatchObject({ rejected_at: base.now, applied_outcome: "new_lead" });
  });

  it("does nothing without a suggestion, or once it was already accepted or rejected", async () => {
    for (const suggestion of [null, { id: "s", outcome: "nurture", accepted_at: "x", rejected_at: null }, { id: "s", outcome: "nurture", accepted_at: null, rejected_at: "x" }]) {
      const { reader, admin, updates } = clients({ suggestion });
      await recordLunaResolutionForItem(reader, admin, { ...base, appliedOutcome: "wrong_number" });
      expect(updates).toEqual([]);
    }
  });

  it("never throws; a missing table is silent, other errors are reported", async () => {
    const missing = clients({ suggestionError: { code: "42P01", message: "relation does not exist" } });
    await expect(recordLunaResolutionForItem(missing.reader, missing.admin, { ...base, appliedOutcome: "x" })).resolves.toBeUndefined();
    expect(reportErrorMock).not.toHaveBeenCalled();
    const broken = clients({ suggestionError: { message: "boom" } });
    await expect(recordLunaResolutionForItem(broken.reader, broken.admin, { ...base, appliedOutcome: "x" })).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});
