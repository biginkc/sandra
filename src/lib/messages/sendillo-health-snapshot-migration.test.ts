import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260811120000_sendillo_health_snapshot.sql",
  ),
  "utf8",
).toLowerCase();

describe("Sendillo health snapshot migration", () => {
  it("keeps compute and capture functions service-role-only with fixed paths", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain(
      "grant select on table public.dashboard_snapshots to authenticated",
    );
    expect(sql).not.toContain(
      "grant insert on table public.dashboard_snapshots to authenticated",
    );
  });

  it("makes overlapping writes atomic and resets snapshot test state", () => {
    expect(sql).toContain("on conflict (snapshot_key) do update");
    expect(sql).toContain(
      "where excluded.captured_at > public.dashboard_snapshots.captured_at",
    );
    expect(sql).toContain("public.dashboard_snapshots,");
  });

  it("preserves the intentional queued-row asymmetry", () => {
    expect(sql).toContain("status is distinct from 'queued'");
    expect(sql).toContain("'smsrows', (select count(*) from sendillo_rows)");
    expect(sql).toContain(
      "'firstmessageat', (select min(created_at) from sendillo_rows)",
    );
  });
});
