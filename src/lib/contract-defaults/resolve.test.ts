import { describe, expect, it } from "vitest";

import { EMPTY_CONTRACT_DEFAULTS } from "./resolve";

describe("EMPTY_CONTRACT_DEFAULTS", () => {
  it("has no title company, buyer entity or text default, and no default or earnest fields exist", () => {
    expect(EMPTY_CONTRACT_DEFAULTS).toEqual({ templateFieldDefaults: {}, titleCompanies: [], buyerEntities: [] });
    for (const k of ["earnestMoneyCents", "defaultTitleCompanyId", "defaultBuyerEntityId", "marketDefaults"]) {
      expect(EMPTY_CONTRACT_DEFAULTS).not.toHaveProperty(k);
    }
  });
});
