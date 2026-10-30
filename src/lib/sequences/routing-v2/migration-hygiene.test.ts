import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * R8 self-sweep: structural checks on the routing v2 PR-C migration and its rollback.
 * (d) every new table: RLS on, API roles revoked; (e) every SECURITY DEFINER function pins
 * search_path and revokes public execute; (f) the rollback drops or restores every object.
 */
const MIG = readFileSync(path.join(process.cwd(), "supabase/migrations/20261030140000_routing_v2_versioned_drips.sql"), "utf8");
const RB = readFileSync(path.join(process.cwd(), "supabase/rollbacks/20261030140000_routing_v2_versioned_drips.sql"), "utf8");

const functions = [...new Set([...MIG.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!))];
const tables = [...MIG.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]!);
const indexes = [...MIG.matchAll(/create (?:unique )?index if not exists (\w+)/g)].map((m) => m[1]!);
const triggers = [...MIG.matchAll(/create trigger (\w+)/g)].map((m) => m[1]!);

function header(fn: string): string {
  const i = MIG.lastIndexOf(`create or replace function public.${fn}(`);
  return MIG.slice(i, MIG.indexOf("as $$", i));
}

describe("routing v2 migration hygiene (R8 self-sweep)", () => {
  it("finds the objects it checks", () => {
    expect(functions.length).toBeGreaterThan(20);
    expect(tables).toEqual(["routing_v2_reply_transitions", "routing_v2_outbox", "routing_v2_drip_send_claims"]);
  });

  it("(d) every new table has RLS on and API roles revoked", () => {
    for (const t of tables) {
      expect(MIG, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(MIG, t).toMatch(new RegExp(`revoke all on [^;]*public\\.${t}[^;]*from public, anon, authenticated`));
    }
  });

  it("(e) every function pins search_path and revokes public execute", () => {
    for (const fn of functions) {
      expect(header(fn), fn).toMatch(/set search_path/);
      expect(MIG, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public`));
    }
  });

  it("(f) the rollback drops or restores every new object", () => {
    for (const fn of functions) {
      expect(RB.includes(`function if exists public.${fn}(`) || RB.includes(`function public.${fn}(`), fn).toBe(true);
    }
    for (const t of tables) expect(RB, t).toMatch(new RegExp(`drop table if exists public\\.${t}`));
    for (const t of triggers) expect(RB, t).toMatch(new RegExp(`drop trigger if exists ${t}`));
    // Indexes on the new tables go with the tables; the ones on existing tables are dropped explicitly.
    const onExisting = indexes.filter((ix) => !tables.some((t) => ix.startsWith(t)));
    for (const ix of onExisting) expect(RB, ix).toMatch(new RegExp(`drop index if exists public\\.${ix}`));
  });
});
