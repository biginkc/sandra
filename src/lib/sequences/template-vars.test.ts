import { describe, expect, it } from "vitest";

import { loadTemplateVars, loadTemplateVarsWithMeta } from "./template-vars";

function fakeClient(arv: number | null) {
  const rows: Record<string, unknown> = {
    properties: { address: "1 Main St", city: "KC", state: "MO", zip: "64111", market: "KC", org_id: "org-1", arv },
    contacts: { first_name: "Pat", last_name: "Seller" },
    organizations: { name: "BMH" },
  };
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      return q;
    },
  } as never;
}

const params = { propertyId: "p1", contactId: "c1" };

describe("loadTemplateVarsWithMeta rapid_offer", () => {
  it("arv 185000 -> $139,000 with meta", async () => {
    const out = await loadTemplateVarsWithMeta(fakeClient(185_000), params);
    expect(out.vars.rapid_offer).toBe("$139,000");
    expect(out.rapidOffer).toEqual({ amount: 139_000, sourceValue: 185_000, source: "properties.arv", pct: 0.75 });
  });
  it("arv null -> blank and no meta", async () => {
    const out = await loadTemplateVarsWithMeta(fakeClient(null), params);
    expect(out.vars.rapid_offer).toBe("");
    expect(out.rapidOffer).toBeNull();
  });
  it("arv 0 -> no meta", async () => {
    const out = await loadTemplateVarsWithMeta(fakeClient(0), params);
    expect(out.vars.rapid_offer).toBe("");
    expect(out.rapidOffer).toBeNull();
  });
  it("loadTemplateVars returns the same vars", async () => {
    expect((await loadTemplateVars(fakeClient(185_000), params)).rapid_offer).toBe("$139,000");
  });
});
