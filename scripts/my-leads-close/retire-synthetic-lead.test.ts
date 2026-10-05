import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const SQL_PATH = path.resolve(__dirname, "rollback/retire-synthetic-lead.sql");
const SQL = readFileSync(SQL_PATH, "utf8");
const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const GOOD_TAG = "PROD-CANARY abc12345";

describe("retire-synthetic-lead.sql (static guards)", () => {
  it("validates the tag shape, org and count before the transaction opens and before any write", () => {
    expect(SQL).toContain("^PROD-CANARY [A-Za-z0-9-]{6,}$");
    const begin = SQL.search(/^begin;/m);
    expect(begin).toBeGreaterThan(0);
    for (const guard of ["ABORT: -v run_tag is required", "ABORT: -v org_id is required", "ABORT: run_tag must match", "ABORT: org_id must be a uuid"]) {
      const at = SQL.indexOf(guard);
      expect(at, guard).toBeGreaterThan(0);
      expect(at, guard).toBeLessThan(begin);
    }
    const firstWrite = SQL.search(/^\s*(update|insert|delete)\s/im);
    const countGuard = SQL.indexOf("candidate count is outside 1..max_expected");
    expect(countGuard).toBeGreaterThan(begin);
    expect(countGuard).toBeLessThan(firstWrite);
    expect(SQL.indexOf("select public.fn_cancel_appointment")).toBeGreaterThan(countGuard);
  });

  it("scopes by org, escapes LIKE, requires the contact first_name and only commits on commit=yes", () => {
    expect(SQL).toMatch(/p\.org_id = :'org_id'::uuid/);
    expect(SQL).toMatch(/escape '\\'/);
    expect(SQL).toMatch(/c\.first_name = :'run_tag'/);
    expect(SQL).toMatch(/\(:'commit' = 'yes'\) as do_commit/);
    expect(SQL).not.toMatch(/\\if :commit\b/);
  });

  it("the tag pattern accepts a canary tag and rejects empty, short, wildcard and unprefixed tags", () => {
    const pattern = new RegExp("^PROD-CANARY [A-Za-z0-9-]{6,}$");
    expect(pattern.test(GOOD_TAG)).toBe(true);
    for (const bad of ["", "PROD-CANARY ", "PROD-CANARY abc", "PROD-CANARY a%cdef12", "PROD-CANARY a_cdef12", "E2E-CLOSE abc12345", "PROD-CANARY abc12345\n"]) {
      expect(pattern.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// Runs the real script under psql against a loopback database. The guards fire before any table is
// read, so any empty local database works; set MY_LEADS_CLOSE_PSQL_URL=postgresql://postgres@127.0.0.1:<port>/postgres.
const psqlUrl = process.env.MY_LEADS_CLOSE_PSQL_URL;
const runPsql = (vars: Record<string, string | undefined>) => {
  const args = [requireLoopbackPostgresUrl(psqlUrl!), "-X", "-q", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) args.push("-v", `${k}=${v}`);
  args.push("-f", SQL_PATH);
  return spawnSync("psql", args, { encoding: "utf8" });
};

describe.skipIf(!psqlUrl)("retire-synthetic-lead.sql (psql, loopback only)", () => {
  const base = { run_tag: GOOD_TAG, org_id: ORG, owner_uid: OWNER, commit: "no" };
  const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["empty tag", { ...base, run_tag: "" }, /run_tag must match/],
    ["short tag", { ...base, run_tag: "PROD-CANARY ab" }, /run_tag must match/],
    ["wildcard tag", { ...base, run_tag: "PROD-CANARY ab%%cdef" }, /run_tag must match/],
    ["underscore tag", { ...base, run_tag: "PROD-CANARY ab_cdef12" }, /run_tag must match/],
    ["missing tag", { ...base, run_tag: undefined }, /run_tag is required/],
    ["missing org", { ...base, org_id: undefined }, /org_id is required/],
    ["bad org", { ...base, org_id: "not-a-uuid" }, /org_id must be a uuid/],
  ];
  it.each(cases)("aborts before any write: %s", (_name, vars, message) => {
    const result = runPsql(vars);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(message);
    expect(`${result.stdout}`).not.toMatch(/committing|candidates to retire/);
  });
});
