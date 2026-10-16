import { describe, expect, it } from "vitest";

import { GuardRefusal, foreignLeadCheckRequired, resolveIntegrationApiUrl, resolveIntegrationDbUrl, assertCommitLaneAllowed, assertEnvLooksLocal, assertOnlyHarnessLeads, resolveDbUrl } from "./guards";

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
  it("keeps the foreign-lead check on for local runs even when E2E_DISPOSABLE_DATABASE=1 is set by hand", () => {
    // The exact local combination: an operator points at another app's persistent stack (e.g. :54322) and sets both acks.
    const local = { MYLEADS_STRESS_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", MYLEADS_STRESS_DISPOSABLE_DB: "1", E2E_DISPOSABLE_DATABASE: "1" };
    expect(foreignLeadCheckRequired(local)).toBe(true);
    expect(foreignLeadCheckRequired({ ...local, GITHUB_ACTIONS: "true" })).toBe(true);
    expect(foreignLeadCheckRequired({ ...local, CI: "true" })).toBe(true);
    expect(foreignLeadCheckRequired({ ...local, CI: "1", GITHUB_ACTIONS: "true", RUNNER_TEMP: "/tmp/r" })).toBe(true);
    expect(foreignLeadCheckRequired({ ...local, GITHUB_ACTIONS: "1", RUNNER_TEMP: "/tmp/r", GITHUB_ENV: "/tmp/e" })).toBe(true);
    expect(() => assertOnlyHarnessLeads({ properties: 5, foreign: 5 })).toThrow(/NON_HARNESS_DATA/);
  });
  it("skips the foreign-lead check only on the CI provisioner's database on a GitHub Actions runner", () => {
    // e2e.yml's own step env: CI=1 (not "true"), plus the runner's GITHUB_ACTIONS / RUNNER_TEMP / GITHUB_ENV.
    const ci = { E2E_DISPOSABLE_DATABASE: "1", CI: "1", GITHUB_ACTIONS: "true", RUNNER_TEMP: "/home/runner/work/_temp", GITHUB_ENV: "/home/runner/work/_temp/_runner_file_commands/set_env" };
    expect(foreignLeadCheckRequired(ci)).toBe(false);
    expect(foreignLeadCheckRequired({ ...ci, CI: "true" })).toBe(false);
    expect(foreignLeadCheckRequired({ ...ci, E2E_DISPOSABLE_DATABASE: undefined })).toBe(true);
    expect(foreignLeadCheckRequired({})).toBe(true);
  });
  it("refuses the shared local stack even when it is selected explicitly", () => {
    for (const shared of ["postgresql://postgres:postgres@127.0.0.1:54329/postgres", "postgresql://postgres:postgres@localhost:54329/postgres"]) {
      expect(() => resolveDbUrl({ MYLEADS_STRESS_DB_URL: shared })).toThrow(/DB_SHARED_STACK/);
      expect(() => resolveIntegrationDbUrl({ MYLEADS_STRESS_DB_URL: shared })).toThrow(/DB_SHARED_STACK/);
      expect(() => resolveDbUrl({ TEST_SUPABASE_DB_URL: shared })).toThrow(/DB_SHARED_STACK/);
    }
    expect(() => resolveIntegrationApiUrl({ LOCAL_SUPABASE_URL: "http://127.0.0.1:54331" })).toThrow(/API_SHARED_STACK/);
    expect(() => resolveDbUrl({ MYLEADS_STRESS_DB_URL: "postgresql://postgres:postgres@127.0.0.1/postgres" })).toThrow(/DB_PORT_UNSET/);
    expect(() => resolveIntegrationApiUrl({ LOCAL_SUPABASE_URL: "not a url" })).toThrow(/API_URL_INVALID/);
  });
  it("integration lanes ignore a config-injected TEST_SUPABASE_DB_URL and need MYLEADS_STRESS_DB_URL", () => {
    const shared = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
    expect(() => resolveIntegrationDbUrl({ TEST_SUPABASE_DB_URL: shared })).toThrow(/DB_URL_UNSET/);
    expect(resolveIntegrationDbUrl({ MYLEADS_STRESS_DB_URL: "postgresql://u:p@127.0.0.1:55722/postgres", TEST_SUPABASE_DB_URL: shared })).toBe("postgresql://u:p@127.0.0.1:55722/postgres");
    expect(() => resolveIntegrationApiUrl({})).toThrow(/API_URL_UNSET/);
    expect(resolveIntegrationApiUrl({ LOCAL_SUPABASE_URL: "http://127.0.0.1:55721" })).toBe("http://127.0.0.1:55721");
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
