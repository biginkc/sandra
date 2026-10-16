import { describe, expect, it } from "vitest";

import { GuardRefusal, assertCommitLaneAllowed, assertEnvLooksLocal, assertOnlyHarnessLeads, resolveDbUrl } from "./guards";

describe("my-leads stress guards", () => {
  it("refuses to run without an explicit database URL and accepts loopback hosts", () => {
    expect(() => resolveDbUrl({})).toThrow(/DB_URL_UNSET/);
    for (const url of ["postgresql://u:p@127.0.0.1:5432/db", "postgresql://u:p@localhost:5432/db", "postgres://u:p@[::1]:5432/db"])
      expect(resolveDbUrl({ MYLEADS_STRESS_DB_URL: url })).toBe(url);
  });
  it.each([
    "postgresql://postgres:x@db.ncsngxlcyxylaeskiteu.supabase.co:5432/postgres",
    "postgresql://postgres:x@10.0.0.5:5432/postgres",
    "postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.example.com",
    "postgresql://postgres:x@localhost.evil.test:5432/postgres",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => resolveDbUrl({ MYLEADS_STRESS_DB_URL: url })).toThrow(GuardRefusal);
  });
  it("falls back to TEST_SUPABASE_DB_URL only when it is loopback too", () => {
    expect(() => resolveDbUrl({ TEST_SUPABASE_DB_URL: "postgresql://x:y@db.example.com/p" })).toThrow(GuardRefusal);
  });
  it("refuses a hosted reference anywhere in the variables it reads", () => {
    expect(() => assertEnvLooksLocal({ NEXT_PUBLIC_SUPABASE_URL: "https://copflsklaefwzipsrjqz.supabase.co" })).toThrow(GuardRefusal);
    expect(() => assertEnvLooksLocal({ TEST_SUPABASE_URL: "http://127.0.0.1:54331", UNRELATED: "x.supabase.co" })).not.toThrow();
  });
  it("commit lanes need the acknowledgement and an otherwise empty database", () => {
    expect(() => assertCommitLaneAllowed({})).toThrow(GuardRefusal);
    expect(() => assertCommitLaneAllowed({ MYLEADS_STRESS_DISPOSABLE_DB: "1" })).not.toThrow();
    expect(() => assertOnlyHarnessLeads({ properties: 5, foreign: 1 })).toThrow(GuardRefusal);
    expect(() => assertOnlyHarnessLeads({ properties: 5, foreign: 0 })).not.toThrow();
  });
});
