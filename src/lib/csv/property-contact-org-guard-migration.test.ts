import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260816170000_property_contact_org_guard.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("property/contact organization guard migration", () => {
  it("adds tenant-agreement foreign keys for homeowner and agent contacts", () => {
    expect(sql).toMatch(
      /foreign key \(homeowner_contact_id, org_id\)\s+references public\.contacts \(id, org_id\)/i,
    );
    expect(sql).toMatch(
      /foreign key \(agent_contact_id, org_id\)\s+references public\.contacts \(id, org_id\)/i,
    );
    expect(sql).toContain("on delete set null (homeowner_contact_id)");
    expect(sql).toContain("on delete set null (agent_contact_id)");
    expect(sql).toMatch(
      /constraint properties_homeowner_contact_id_fkey\s+foreign key \(homeowner_contact_id\)[\s\S]*?on delete set null/i,
    );
    expect(sql).toMatch(
      /constraint properties_agent_contact_id_fkey\s+foreign key \(agent_contact_id\)[\s\S]*?on delete set null/i,
    );
  });

  it("enforces new writes without requiring historical rows to validate during deploy", () => {
    expect(sql.match(/\n  not valid;/gi)).toHaveLength(4);
    expect(sql).toContain(
      "drop constraint if exists properties_homeowner_contact_org_fkey",
    );
    expect(sql).toContain(
      "drop constraint if exists properties_agent_contact_org_fkey",
    );
    expect(sql).toContain(
      "drop constraint if exists properties_homeowner_contact_id_fkey",
    );
    expect(sql).toContain(
      "drop constraint if exists properties_agent_contact_id_fkey",
    );
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/i);
  });
});
