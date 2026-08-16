import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const selectAllSource = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const countSource = readFileSync(new URL("./_actions/count.ts", import.meta.url), "utf8");

describe("Prospects permanent DNC display contract", () => {
  it("includes advanced locked rows without promoting channel suppression", () => {
    expect(source).toContain('status, is_dnc_locked, outreach_dispo');
    expect(source).toContain('.or("status.eq.prospect,is_dnc_locked.eq.true")');
    expect(source).toContain('dnc_reason: p.is_dnc_locked');
    expect(source).toContain('homeowner?.sms_opted_out');
    expect(source).not.toContain('from("sms_phone_suppressions")');
    expect(source).not.toContain("evaluateSuppression");
    expect(selectAllSource).toContain('.or("status.eq.prospect,is_dnc_locked.eq.true")');
    expect(countSource).toContain('.or("status.eq.prospect,is_dnc_locked.eq.true")');
  });

  it("scopes the CASS header counts with the same visible filters", () => {
    expect(source.match(/await applyFilters\(/g)).toHaveLength(2);
    expect(source.match(/\.ilike\("address"/g)).toHaveLength(2);
    expect(
      source.match(/rawSearchParams\.imported === "today"/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(source.match(/status\.eq\.prospect,is_dnc_locked\.eq\.true/g)).toHaveLength(2);
  });
});
