import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260816060000_workflow_recovery_safety.sql",
  ),
  "utf8",
);

describe("workflow recovery safety migration", () => {
  it("keeps the Telnyx ledger and mutation RPCs service-role-only", () => {
    expect(migration).toMatch(
      /revoke all on public\.csv_import_line_type_outcomes from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.claim_csv_import_line_type_lookup[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.complete_csv_import_line_type_lookup[\s\S]+from public, anon, authenticated/,
    );
  });

  it("reuses terminal results and advances retryable work only after the persisted job retry changes", () => {
    expect(migration).toContain("v_existing.state = 'completed'");
    expect(migration).toContain("select 'reused'::text");
    expect(migration).toMatch(
      /v_existing\.state = 'retryable'[\s\S]+v_job\.retry_count > v_existing\.job_retry_count/,
    );
    expect(migration).toContain("lookup_attempts = ledger.lookup_attempts + 1");
  });

  it("quarantines in-flight and transport-ambiguous lookups instead of paying again", () => {
    expect(migration).toContain(
      "v_existing.state in ('submitting', 'ambiguous')",
    );
    expect(migration).toContain("select 'ambiguous'::text");
    expect(migration).toContain("'transport_unknown'");
  });

  it("does not redefine the DB lane's CSV retry-claim RPC", () => {
    expect(migration).not.toContain(
      "create or replace function public.claim_csv_import_retry",
    );
  });
});
