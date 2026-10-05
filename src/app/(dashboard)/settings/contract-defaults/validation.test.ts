import { describe, expect, it } from "vitest";

import { centsToDollars, dollarsToCents, parseTemplateFieldDefaults } from "./validation";

describe("parseTemplateFieldDefaults", () => {
  it("accepts known non-economic keys and ignores blank lines", () => {
    const r = parseTemplateFieldDefaults("closing_agent_name=X\n\nbuyer_phone = 555");
    expect(r).toEqual({ ok: true, value: { closing_agent_name: "X", buyer_phone: "555" } });
  });
  it.each(["offer_price", "cash_balance", "closing_date", "earnest_money"])("rejects economic key %s", (k) => {
    const r = parseTemplateFieldDefaults(`${k}=1`);
    expect(r.ok).toBe(false);
  });
  it("rejects unknown keys, missing values, duplicates, and bad lines", () => {
    const r = parseTemplateFieldDefaults("nope=1\nbuyer_phone=\nbuyer_email=a\nbuyer_email=b\njunk");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });
});

describe("money helpers", () => {
  it("parses dollars to cents and refuses blank/invalid", () => {
    expect(dollarsToCents("12.5")).toBe(1250);
    expect(dollarsToCents("$1,000")).toBe(100000);
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(centsToDollars(1250)).toBe("12.50");
    expect(centsToDollars(null)).toBe("");
  });
});
