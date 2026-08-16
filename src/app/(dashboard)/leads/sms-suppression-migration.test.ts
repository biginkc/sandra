import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260816080000_leads_sms_suppression_projection.sql",
  ),
  "utf8",
);

describe("Leads SMS-only suppression projection", () => {
  it("projects the homeowner contact flag and date without filtering SMS-only leads", () => {
    expect(migration).toContain("hc.sms_opted_out as homeowner_sms_opted_out");
    expect(migration).toContain(
      "hc.sms_opted_out_at as homeowner_sms_opted_out_at",
    );
    expect(migration).toMatch(/where p\.is_dnc_locked = false/i);
    expect(migration).not.toMatch(/where[\s\S]*sms_opted_out\s*=\s*false/i);
  });
});
