import { describe, expect, it } from "vitest";

import { EMPTY_CONTRACT_DEFAULTS, resolveBuyerEntity, resolveTitleCompany, type ContractDefaults, type TitleCompany } from "./resolve";

const tc = (id: string, isActive = true): TitleCompany => ({
  id, name: `T-${id}`, closingAgentName: "A", closingAgentPhone: null, closingAgentAddress: null, closingAgentEmail: null, isActive,
});
const defaults = (over: Partial<ContractDefaults> = {}): ContractDefaults => ({
  ...EMPTY_CONTRACT_DEFAULTS,
  titleCompanies: [tc("exact"), tc("market"), tc("dflt"), tc("off", false)],
  ...over,
});

describe("resolveTitleCompany", () => {
  it("is null with empty defaults (no invented title company)", () => {
    expect(resolveTitleCompany(EMPTY_CONTRACT_DEFAULTS, { market: "Kansas City", state: "MO" })).toBeNull();
  });
  it("prefers exact (market, state), then (market, null), then the default, else null", () => {
    const d = defaults({
      marketDefaults: [
        { market: "Kansas City", stateCode: "KS", titleCompanyId: "exact" },
        { market: "Kansas City", stateCode: null, titleCompanyId: "market" },
      ],
      defaultTitleCompanyId: "dflt",
    });
    expect(resolveTitleCompany(d, { market: "Kansas City", state: "ks" })?.id).toBe("exact");
    expect(resolveTitleCompany(d, { market: "Kansas City", state: "MO" })?.id).toBe("market");
    expect(resolveTitleCompany(d, { market: "Dayton", state: "OH" })?.id).toBe("dflt");
    expect(resolveTitleCompany({ ...d, defaultTitleCompanyId: null }, { market: "Dayton", state: "OH" })).toBeNull();
  });
  it("excludes inactive companies", () => {
    const d = defaults({ defaultTitleCompanyId: "off" });
    expect(resolveTitleCompany(d, { market: null, state: null })).toBeNull();
  });
});

describe("resolveBuyerEntity", () => {
  it("returns only an active default", () => {
    const b = { id: "b", name: "B", phone: null, email: null, attorneyInFact: null, isActive: true };
    expect(resolveBuyerEntity({ ...EMPTY_CONTRACT_DEFAULTS, buyerEntities: [b], defaultBuyerEntityId: "b" })?.id).toBe("b");
    expect(resolveBuyerEntity({ ...EMPTY_CONTRACT_DEFAULTS, buyerEntities: [{ ...b, isActive: false }], defaultBuyerEntityId: "b" })).toBeNull();
    expect(resolveBuyerEntity(EMPTY_CONTRACT_DEFAULTS)).toBeNull();
  });
});
