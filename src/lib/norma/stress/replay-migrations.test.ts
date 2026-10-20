import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NORMA_STRESS_REPLAY_PATTERNS, matchesReplayPattern, replayMigrations } from "./replay-migrations";

const ROOT = process.cwd();
const MIGRATIONS = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

/** SQL-language function bodies in a migration (Postgres validates these at creation, so a missing column or function fails). */
function sqlLanguageBodies(sql: string): string[] {
  const out: string[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\b([\s\S]*?)\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2([^;]*);/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    if (/\blanguage\s+(?:sql\b|'sql')/i.test(`${m[1]} ${m[4]}`)) out.push(m[3]!);
  }
  return out;
}

/** What only the Norma migrations create, matched case-insensitively (SQL identifiers are case-folded). */
const NORMA_ONLY = /\bsource_key\b|\bnorma_call_requests\b|\bfn_norma_/i;

/** Migrations NOT replayed by the gate whose SQL-language function bodies read what only the Norma migrations create. */
function unreplayedNormaReaders(patterns: readonly string[]): string[] {
  return MIGRATIONS.filter((f) => !matchesReplayPattern(f, patterns))
    .filter((f) => sqlLanguageBodies(readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"))
      .some((body) => NORMA_ONLY.test(body)));
}

describe("Norma stress gate migration replay", () => {
  it("the workflow excludes exactly the shared replay patterns", () => {
    const yml = readFileSync(path.join(ROOT, ".github/workflows/norma-stress.yml"), "utf8");
    const args = [...yml.matchAll(/--exclude-migrations\s+'([^']+)'/g)].map((m) => m[1]);
    expect(args).toEqual([...NORMA_STRESS_REPLAY_PATTERNS]);
  });

  it("no migration outside the replay list has a SQL-language function reading source_key, norma_call_requests or fn_norma_", () => {
    expect(unreplayedNormaReaders(NORMA_STRESS_REPLAY_PATTERNS)).toEqual([]);
  });

  it("has teeth: without *_my_leads_approved_* the approved-rules migration is reported by name", () => {
    expect(unreplayedNormaReaders(NORMA_STRESS_REPLAY_PATTERNS.filter((p) => p !== "*_my_leads_approved_*")))
      .toContain("20261015040000_my_leads_approved_snooze_multi_house.sql");
  });

  it("finds SQL-language bodies only (a plpgsql body reading source_key is not one)", () => {
    expect(sqlLanguageBodies("create function a() returns int language plpgsql as $$ begin return 1; end $$;")).toEqual([]);
    expect(sqlLanguageBodies("create or replace function b() returns int language sql as $$ select 1 $$;")).toEqual([" select 1 "]);
    expect(sqlLanguageBodies("create function c() returns int as $f$ select 2 $f$ language sql stable;")).toEqual([" select 2 "]);
    // quoted language name and upper case, as some migrations write it
    expect(sqlLanguageBodies("CREATE OR REPLACE FUNCTION d() RETURNS int LANGUAGE 'sql' AS $$ SELECT 3 $$;")).toEqual([" SELECT 3 "]);
    expect(sqlLanguageBodies("create function e() returns int as $$ select 4 $$ language 'plpgsql';")).toEqual([]);
  });

  it("matches Norma-only references in any case", () => {
    const body = sqlLanguageBodies("CREATE FUNCTION f() RETURNS text LANGUAGE 'sql' AS $$ SELECT T.SOURCE_KEY FROM PUBLIC.TASKS T $$;");
    expect(body.some((b) => NORMA_ONLY.test(b))).toBe(true);
    expect(["select * from Norma_Call_Requests", "select public.FN_NORMA_claim()"].every((b) => NORMA_ONLY.test(b))).toBe(true);
    expect(NORMA_ONLY.test("select resource_keys from x")).toBe(false);
  });

  it("replays every Norma file first, then the classifier files, each in version order", () => {
    const r = replayMigrations(MIGRATIONS);
    const firstOther = r.findIndex((f) => !f.includes("_norma_"));
    expect(r.slice(firstOther).every((f) => !f.includes("_norma_"))).toBe(true);
    expect(r).toContain("20261015040000_my_leads_approved_snooze_multi_house.sql");
    expect(r.at(-1)).toBe("20261020130000_my_leads_work_new_lead_in_drip.sql");
    expect(replayMigrations(["20261015040000_my_leads_approved_x.sql", "20260101000000_norma_a.sql", "20250101000000_my_leads_work_b.sql"]))
      .toEqual(["20260101000000_norma_a.sql", "20250101000000_my_leads_work_b.sql", "20261015040000_my_leads_approved_x.sql"]);
  });
});
