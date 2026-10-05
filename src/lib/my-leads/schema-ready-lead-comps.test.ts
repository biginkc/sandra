import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { REQUIREMENTS } from "./schema-ready";

const MIGRATION = join(process.cwd(), "supabase/migrations/20261007100000_lead_comps_foundation.sql");

// Argument types, in order, of every `create [or replace] function public.<name>(...)` in the SQL.
function declaredSignatures(sql: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(([^)]*)\\)`, "gi");
  for (const m of sql.matchAll(re)) {
    const types = m[1]
      .split(",")
      .map((a) => a.trim().replace(/\s+default\s+.*$/i, ""))
      .filter(Boolean)
      .map((a) => a.split(/\s+/).slice(1).join(" ").toLowerCase().replace(/timestamp with time zone/, "timestamptz"));
    out.push(`public.${name}(${types.join(",")})`);
  }
  return out;
}

describe("lead_comps readiness requirements match the real migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it.each(REQUIREMENTS.lead_comps.functions.map((f) => [f]))(
    "%s is declared with exactly this argument list (to_regprocedure needs an exact match)",
    (fn) => {
      const name = fn.slice("public.".length, fn.indexOf("("));
      expect(declaredSignatures(sql, name)).toContain(fn);
    },
  );
});
