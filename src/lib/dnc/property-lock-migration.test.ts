import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260815190000_true_dnc_property_lock.sql", import.meta.url),
  "utf8",
);

describe("true DNC property-lock migration", () => {
  it("adds and backfills one permanent lock without changing pipeline status", () => {
    expect(migration).toContain("is_dnc_locked boolean not null default false");
    expect(migration).toMatch(/outreach_dispo\s*=\s*'dnc'/);
    expect(migration).toMatch(/do_not_contact\s+is\s+true/i);
    expect(migration).not.toMatch(/set\s+status\s*=\s*'prospect'/i);
  });

  it("ratchets property and linked-contact DNC with fixed search paths", () => {
    expect(migration).toContain("set search_path = public, pg_temp");
    expect(migration).toContain("old.is_dnc_locked and not new.is_dnc_locked");
    expect(migration).toContain("old.do_not_contact and not new.do_not_contact");
    expect(migration).toContain("p.org_id = new.org_id");
  });

  it("keeps locked properties out of both Leads views", () => {
    expect(migration).toMatch(/create\s+view\s+public\.leads_board/i);
    expect(migration).toMatch(/create\s+view\s+public\.leads_unskip_traced/i);
    expect(migration.match(/is_dnc_locked\s*=\s*false/gi)?.length).toBeGreaterThanOrEqual(1);
  });
});
