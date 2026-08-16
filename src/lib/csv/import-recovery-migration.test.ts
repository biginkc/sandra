import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260816020000_csv_import_recovery_safety.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("CSV recovery safety migration", () => {
  it("stores immutable authoritative retry provenance", () => {
    expect(migration).toContain(
      "create table if not exists public.csv_import_job_provenance",
    );
    expect(migration).toContain("revoke insert, update, delete");
    expect(migration).toContain("claim_csv_import_retry");
    expect(migration).toContain("v_job.type <> 'csv_import'");
  });

  it("atomically records the original inserted versus duplicate row outcome", () => {
    expect(migration).toContain(
      "create table if not exists public.csv_import_row_outcomes",
    );
    expect(migration).toContain("checkpoint_csv_import_property_outcome");
    expect(migration).toContain("insert into public.properties");
    expect(migration).toContain("insert into public.csv_import_row_outcomes");
    expect(migration).toContain("primary key (job_id, source_row_index)");
  });

  it("derives terminal failure counts in the database", () => {
    expect(migration).toContain("fail_csv_import_workflow");
    expect(migration).toContain(
      "count(*) filter (where ji.status = 'success')",
    );
    expect(migration).toContain("count(*) filter (where ji.status = 'error')");
  });
});
