import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260815120000_csv_import_truthfulness.sql", import.meta.url),
  "utf8",
).toLowerCase();

describe("CSV import truthfulness migration structure", () => {
  it("rebuilds every active contact dedup key with org_id", () => {
    expect(migration).toMatch(/contacts_phone_1_key[\s\S]*?on public\.contacts\s*\(org_id, phone_1\)/);
    expect(migration).toMatch(/contacts_email_key[\s\S]*?on public\.contacts\s*\(org_id, lower\(email\)\)/);
    expect(migration).toMatch(/contacts_person_name_key[\s\S]*?\(org_id, lower\(last_name\), lower\(first_name\)\)/);
    expect(migration).toMatch(/contacts_entity_name_key[\s\S]*?\(org_id, lower\(entity_name\)\)/);
  });

  it("rebuilds every property dedup key with org_id and preserves soft-delete predicates", () => {
    for (const index of [
      "properties_fips_apn_key",
      "properties_regrid_key",
      "properties_attom_key",
      "properties_zpid_key",
      "properties_mls_number_key",
      "properties_address_normalized_key",
    ]) {
      const start = migration.indexOf(`create unique index ${index}`);
      expect(start, `${index} is missing`).toBeGreaterThanOrEqual(0);
      const definition = migration.slice(start, migration.indexOf(";", start) + 1);
      expect(definition).toContain("(org_id,");
      expect(definition).toContain("deleted_at is null");
    }
  });

  it("adds a partial tenant/time index for Imported Today", () => {
    expect(migration).toMatch(
      /drop index if exists public\.idx_properties_org_source_imported_at;[\s\S]*?create index idx_properties_org_source_imported_at[\s\S]*?on public\.properties\s*\(org_id, source_imported_at\)[\s\S]*?where source_import_id is not null\s+and source_imported_at is not null\s+and deleted_at is null/,
    );
  });

  it("backfills and structurally pins contact-owned rows to their organization", () => {
    for (const table of ["homeowner_details", "agent_details", "consent_events"]) {
      expect(migration).toMatch(
        new RegExp(
          `update public\\.${table}[\\s\\S]*?set org_id = contacts\\.org_id[\\s\\S]*?where [\\s\\S]*?contact_id = contacts\\.id`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `alter table public\\.${table}[\\s\\S]*?foreign key \\(contact_id, org_id\\)[\\s\\S]*?references public\\.contacts\\(id, org_id\\)`,
        ),
      );
    }
  });
});
