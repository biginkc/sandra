import { describe, expect, it } from "vitest";

import {
  AD_HOC_BULK_SMS_SOURCE,
  campaignSourceFromSnapshot,
  filterToProspectIds,
} from "./prospect-only-guard";

function client(rows: Array<{ id: string; status: string; deleted_at?: string | null }>) {
  const seen: string[][] = [];
  return {
    seen,
    from: () => {
      let ids: string[] = [];
      let statusFilter: string | null = null;
      let requireLive = false;
      const q = {
        select: () => q,
        in: (_c: string, v: string[]) => ((ids = v), seen.push(v), q),
        eq: (_c: string, v: string) => ((statusFilter = v), q),
        is: () => ((requireLive = true), q),
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: rows
              .filter((r) => ids.includes(r.id))
              .filter((r) => (statusFilter ? r.status === statusFilter : true))
              .filter((r) => (requireLive ? !r.deleted_at : true))
              .map((r) => ({ id: r.id })),
            error: null,
          }),
      };
      return q;
    },
  } as never;
}

describe("filterToProspectIds", () => {
  it("keeps live prospects in input order and counts everything else as skipped leads", async () => {
    const c = client([
      { id: "p1", status: "prospect" },
      { id: "l1", status: "new_lead" },
      { id: "p2", status: "prospect" },
      { id: "d1", status: "dead" },
      { id: "x1", status: "prospect", deleted_at: "2026-01-01" },
    ]);
    const out = await filterToProspectIds(c, ["p2", "l1", "p1", "d1", "x1", "ghost", "p1"]);
    expect(out.prospectIds).toEqual(["p2", "p1"]);
    expect(out.skippedLeads).toBe(4); // l1, d1, x1, ghost (duplicate p1 not double counted)
  });

  it("chunks lookups so ids never blow the URL limit", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, status: "prospect" }));
    const c = client(rows);
    const out = await filterToProspectIds(c, rows.map((r) => r.id));
    expect(out.prospectIds).toHaveLength(600);
    expect(out.skippedLeads).toBe(0);
    expect((c as unknown as { seen: string[][] }).seen.every((chunk) => chunk.length <= 250)).toBe(true);
  });

  it("empty input makes no query", async () => {
    const c = client([]);
    expect(await filterToProspectIds(c, [])).toEqual({ prospectIds: [], skippedLeads: 0 });
  });

  it("throws on a read error instead of treating everything as eligible", async () => {
    const failing = {
      from: () => {
        const q = {
          select: () => q,
          in: () => q,
          eq: () => q,
          is: () => q,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: "boom" } }),
        };
        return q;
      },
    } as never;
    await expect(filterToProspectIds(failing, ["a"])).rejects.toThrow("Prospect-only guard failed");
  });
});

describe("campaignSourceFromSnapshot", () => {
  it("derives ad-hoc provenance only from the stored snapshot source", () => {
    expect(campaignSourceFromSnapshot({ source: AD_HOC_BULK_SMS_SOURCE })).toBe("ad_hoc_bulk_sms");
    expect(campaignSourceFromSnapshot({ source: "filters" })).toBe("saved_campaign");
    expect(campaignSourceFromSnapshot({ search: "x", blockStack: [] })).toBe("saved_campaign");
    for (const v of [null, undefined, "bulk_sms_modal", 5, []]) {
      expect(campaignSourceFromSnapshot(v)).toBe("saved_campaign");
    }
  });
});
