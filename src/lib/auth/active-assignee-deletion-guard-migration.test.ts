import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("active assignee deletion-prepared guard migration", () => {
  it("requires the complete Hugo lifecycle predicate inside the database trigger", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260902230000_active_assignee_deletion_prepared_guard.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("membership.deletion_prepared_at is null");
    expect(sql).toContain("membership.access_expires_at > statement_timestamp()");
    expect(sql).toContain("INVALID_ASSIGNEE");
  });
});
