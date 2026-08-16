import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260816030000_leads_tenant_paging_safety.sql"),
  "utf8",
);

describe("Leads tenant, assignment, and paging safety migration", () => {
  it("returns a whole-filter snapshot fingerprint with every page", () => {
    expect(migration).toContain("snapshot_generation text");
    expect(migration).toMatch(/with filtered as materialized/i);
    expect(migration).toMatch(/md5\s*\(\s*coalesce\s*\(\s*string_agg/i);
    expect(migration).toMatch(/order by f\.next_task_due_at asc nulls last, f\.id asc/i);
  });

  it("enforces active, non-expired same-org assignment at database write time", () => {
    expect(migration).toContain("enforce_active_property_assignee_membership");
    expect(migration).toMatch(/membership\.org_id = new\.org_id/i);
    expect(migration).toMatch(/membership\.user_id = new\.assigned_user_id/i);
    expect(migration).toMatch(/membership\.access_status = 'active'/i);
    expect(migration).toMatch(/membership\.access_expires_at is null[\s\S]*membership\.access_expires_at > statement_timestamp\(\)/i);
    expect(migration).toMatch(/before insert or update of assigned_user_id/i);
  });
});
