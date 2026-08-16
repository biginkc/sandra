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
    expect(migration).toContain(
      "returns table(property_id uuid, original_outcome text, compliance_locked boolean)",
    );
    expect(migration).toContain("primary key (job_id, source_row_index)");
    expect(migration).toMatch(
      /select p\.is_dnc_locked[\s\S]+for no key update[\s\S]+if v_property_is_locked then[\s\S]+v_property_id := p_existing_property_id/i,
    );
  });

  it("records CSV consent at most once per job and contact", () => {
    expect(migration).toContain(
      "create table if not exists public.csv_import_consent_outcomes",
    );
    expect(migration).toContain("primary key (job_id, contact_id, org_id)");
    expect(migration).toMatch(
      /revoke all on public\.csv_import_consent_outcomes from anon, authenticated/i,
    );
    expect(migration).toContain("reject_csv_import_consent_outcome_mutation");
    expect(migration).toContain("reject_csv_import_consent_event_mutation");
    expect(migration).toMatch(
      /before update or delete on public\.consent_events[\s\S]+csv_import_consent_outcomes/i,
    );
    expect(migration).toContain(
      "create or replace function public.record_csv_import_consents",
    );
    expect(migration).toContain("from public.csv_import_row_outcomes outcome");
    expect(migration).toContain("lock_csv_import_consent_org");
    expect(migration).toContain(
      "aa_serialize_contact_safety_before_csv_consent",
    );
    expect(migration).toContain(
      "zz_serialize_property_safety_before_csv_consent",
    );
    expect(migration).toContain(
      "aa_serialize_consent_safety_before_csv_consent",
    );
    expect(migration).toContain(
      "aa_serialize_phone_suppression_before_csv_consent",
    );
    expect(migration).not.toMatch(/lock table public\./i);
    expect(migration).toContain(
      "insert into public.csv_import_consent_outcomes",
    );
  });

  it("derives terminal failure counts in the database", () => {
    expect(migration).toContain("fail_csv_import_workflow");
    expect(migration).toContain(
      "count(*) filter (where ji.status = 'success')",
    );
    expect(migration).toContain("count(*) filter (where ji.status = 'error')");
  });
});
