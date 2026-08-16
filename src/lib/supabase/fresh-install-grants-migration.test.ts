import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260816050000_fresh_install_api_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("fresh-install API grants migration", () => {
  it("limits authenticated table grants to relations protected by RLS", () => {
    expect(migration).toContain("class.relrowsecurity");
    expect(migration).toMatch(
      /grant select, insert, update, delete on table %s to authenticated/i,
    );
    expect(migration).not.toMatch(
      /grant all privileges on (all )?tables[^;]*authenticated/i,
    );
  });

  it("restores service-role and sequence privileges for fresh databases", () => {
    expect(migration).toMatch(
      /grant all privileges on table %s to service_role/i,
    );
    expect(migration).toMatch(
      /grant usage, select on all sequences in schema public/i,
    );
    expect(migration).toMatch(
      /alter default privileges for role postgres[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /alter default privileges[\s\S]*to authenticated/i,
    );
  });

  it("prevents a job item from referencing another tenant's property", () => {
    expect(migration).toContain("enforce_job_item_property_org");
    expect(migration).toMatch(
      /from public\.jobs j[\s\S]*for key share[\s\S]*from public\.properties p[\s\S]*for key share/i,
    );
    expect(migration).toContain("JOB_ITEM_PROPERTY_ORG_MISMATCH");
    expect(migration).toMatch(
      /before insert or update of job_id, property_id on public\.job_items/i,
    );
  });
});
