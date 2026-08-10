import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260810163000_skip_trace_credit_snapshot.sql",
  ),
  "utf8",
).toLowerCase();

describe("skip-trace credit snapshot migration contract", () => {
  it("makes overlapping refreshes atomic and newer-wins", () => {
    expect(sql).toContain("on conflict (metric_key, captured_on) do update");
    expect(sql).toContain(
      "where excluded.captured_at > metric_snapshots.captured_at",
    );
  });

  it("keeps the definer function on a fixed path and service-role only", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
