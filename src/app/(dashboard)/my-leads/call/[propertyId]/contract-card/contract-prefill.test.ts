import { describe, expect, it } from "vitest";

import { buildContractPrefill, parseDollarsToCents, type PrefillBase } from "./contract-prefill";
import { BUYER, FULL_DEFAULTS, NOW, novationBase, residentialBase, TEST_ONLY_EARNEST_MONEY_CENTS, TITLE } from "./fixtures";

const build = (base: PrefillBase, rep: Partial<{ priceCents: number; closingDate: string; overrides: Record<string, string> }> = {}) =>
  buildContractPrefill({
    ...base, titleCompany: TITLE, buyerEntity: BUYER, todayCentral: "2026-10-04", now: NOW,
    rep: { priceCents: 21000000, closingDate: "2026-11-01", overrides: {}, ...rep },
  } as never);

describe("buildContractPrefill", () => {
  it("fills a complete novation contract and is not blocked", () => {
    const r = build(novationBase());
    expect(r.blocked).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.values.offer_price).toBe("$210,000.00");
    expect(r.values.cash_balance).toBeUndefined();
    expect(r.values.earnest_money).toBe("$123.45");
    expect(r.values.earnest_money_holder).toBe("Test Title Co");
    expect(r.values.buyer_name).toBe("Test Buyer LLC");
    expect(r.values.agreement_date).toBe("2026-10-04");
    expect(r.sources.legal_description).toBe("public_record");
    expect(r.sources.offer_price).toBe("rep");
    expect(r.economics).toEqual({ priceCents: 21000000, closingDate: "2026-11-01", earnestMoneyCents: TEST_ONLY_EARNEST_MONEY_CENTS });
  });

  it("uses street plus city/state/zip for residential-v1 and sets cash_balance", () => {
    const r = build(residentialBase());
    expect(r.values.property_address).toBe("9 Test Rd");
    expect(r.values.property_city).toBe("Testville");
    expect(r.values.cash_balance).toBe("$210,000.00");
    expect(r.blocked).toBe(false);
  });

  it.each([
    ["low confidence", { confidence: "low" as const }],
    ["incomplete", { legalComplete: false }],
    ["fixture provider", { provider: "fixture" as const }],
    ["older than 90 days", { fetchedAt: "2026-06-01T00:00:00Z" }],
  ])("blocks and never prefills legal description when comp is %s", (_n, patch) => {
    const base = novationBase();
    const r = build({ ...base, comp: { ...base.comp!, ...patch } });
    expect(r.values.legal_description).toBe("");
    expect(r.sources.legal_description).toBe("unsourced");
    expect(r.review.legalDescription).toBeNull();
    expect(r.missing).toContain("legal_description");
    expect(r.blocked).toBe(true);
  });

  it("blocks when there is no comp at all", () => {
    expect(build(novationBase({ comp: null })).blocked).toBe(true);
  });

  it("blocks on an unsourced field but never on additional_terms", () => {
    const r = build(novationBase({ settings: { earnestMoneyCents: TEST_ONLY_EARNEST_MONEY_CENTS, templateFieldDefaults: { ...FULL_DEFAULTS, due_diligence_days: "" } } }));
    expect(r.missing).toEqual(["due_diligence_days"]);
    expect(r.missing).not.toContain("additional_terms");
    expect(r.blocked).toBe(true);
  });

  it("blocks with no title company or buyer entity (empty by default)", () => {
    const r = buildContractPrefill({
      ...novationBase(), titleCompany: null, buyerEntity: null, todayCentral: "2026-10-04", now: NOW,
      rep: { priceCents: 100, closingDate: "2026-11-01", overrides: {} },
    });
    expect(r.blocked).toBe(true);
    expect(r.missing).toEqual(expect.arrayContaining(["earnest_money_holder", "closing_agent_name", "buyer_name"]));
  });

  it("warns (does not block) when the owner of record shares no surname with the seller", () => {
    const base = novationBase();
    const r = build({ ...base, comp: { ...base.comp!, ownerOfRecord: "ACME HOLDINGS" } });
    expect(r.review.ownerOfRecordWarning).toContain("ACME HOLDINGS");
    expect(r.blocked).toBe(false);
    expect(build(novationBase()).review.ownerOfRecordWarning).toBeNull();
  });

  it("honours allow-listed overrides tagged rep and rejects economic and unknown overrides", () => {
    const ok = build(novationBase(), { overrides: { additional_terms: "typed by rep" } });
    expect(ok.values.additional_terms).toBe("typed by rep");
    expect(ok.sources.additional_terms).toBe("rep");
    for (const key of ["offer_price", "cash_balance", "closing_date", "earnest_money", "seller_name"]) {
      const r = build(novationBase(), { overrides: { [key]: "x" } });
      expect(r.rejectedOverrides).toEqual([key]);
      expect(r.blocked).toBe(true);
      expect(r.values.offer_price).toBe("$210,000.00");
    }
  });

  it("derives economics from the canonical merged values", () => {
    const r = build(novationBase(), { priceCents: 123456 });
    expect(r.economics.priceCents).toBe(123456);
    expect(parseDollarsToCents(r.values.offer_price!)).toBe(123456);
  });

  it("an unset org earnest money leaves earnest_money empty, unsourced and blocking", () => {
    const base = novationBase();
    const r = build({ ...base, settings: { ...base.settings, earnestMoneyCents: null } });
    expect(r.values.earnest_money).toBe("");
    expect(r.sources.earnest_money).toBe("unsourced");
    expect(r.missing).toContain("earnest_money");
    expect(r.blocked).toBe(true);
  });

  it("is blocked without a price or closing date", () => {
    expect(build(novationBase(), { priceCents: 0 }).missing).toContain("offer_price");
    expect(build(novationBase(), { closingDate: "" }).missing).toContain("closing_date");
  });
});

describe("parseDollarsToCents", () => {
  it("parses dollar text and rejects junk", () => {
    expect(parseDollarsToCents("$1,234.5")).toBe(123450);
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("")).toBeNull();
  });
});
