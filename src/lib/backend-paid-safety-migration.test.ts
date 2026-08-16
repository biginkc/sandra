import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260816010000_backend_paid_safety.sql",
  ),
  "utf8",
);

describe("backend paid safety migration", () => {
  it("derives contact-owned tenant identity and exposes only a service-role paid claim", () => {
    expect(migration).toContain("new.org_id := authoritative_org_id");
    expect(migration).toMatch(
      /revoke all on function public\.claim_paid_property_enrichment\(uuid, uuid\)[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_paid_property_enrichment\(uuid, uuid\)[\s\S]+to service_role/,
    );
  });

  it("uses contact then property locking at the paid boundary", () => {
    const contactLock = migration.indexOf("from public.contacts c");
    const propertyLock = migration.indexOf("from public.properties p", contactLock);
    expect(contactLock).toBeGreaterThan(-1);
    expect(propertyLock).toBeGreaterThan(contactLock);
    expect(migration).toContain("for no key update");
  });

  it("guards INSERT UPDATE and DELETE enrollment links and preserves step audit history", () => {
    expect(migration).toContain("before insert or update or delete on public.sequence_enrollments");
    expect(migration).toContain("case when tg_op <> 'INSERT' then old.property_id");
    expect(migration).toContain("case when tg_op <> 'DELETE' then new.property_id");
    expect(migration).toContain("before update or delete on public.sequence_step_runs");
    expect(migration).toContain("new.status = 'opted_out'");
  });
});
