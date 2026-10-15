import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { REQUIREMENTS } from "./schema-ready";

const read = (file: string) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8");
const SQL = [
  read("20261015010000_my_leads_work_queue_classifier.sql"),
  read("20261015020000_my_leads_unified_queue_flag.sql"),
  read("20261015020100_my_leads_pin_no_expiry.sql"),
].join("\n");

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

describe("unified_queue readiness requirements match the real migrations", () => {
  it.each(REQUIREMENTS.unified_queue.functions.map((f) => [f]))("%s is declared with exactly this argument list", (fn) => {
    const name = fn.slice("public.".length, fn.indexOf("("));
    expect(declaredSignatures(SQL, name)).toContain(fn);
  });

  it("requires the org switch column", () => {
    expect(REQUIREMENTS.unified_queue.columns).toEqual(["my_leads_feature_flags.unified_queue"]);
    expect(SQL).toMatch(/add column if not exists unified_queue boolean/);
  });
});
