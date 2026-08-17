import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../../supabase/migrations/20260816130000_calendar_contact_dnc_projection.sql", import.meta.url),
  "utf8",
);

describe("Migration 20260816130000 — calendar exact-contact DNC projection", () => {
  it("replaces the existing RPC without changing its public return contract", () => {
    expect(sql).toContain("create or replace function public.fn_calendar_month_appointments");
    expect(sql).toContain("property_is_dnc_locked boolean");
    expect(sql).not.toContain("security definer");
  });

  it("projects the property lock or exact appointment contact DNC and preserves personal null", () => {
    expect(sql).toContain("when g.related_property_id is null and g.contact_id is null then null");
    expect(sql).toContain("coalesce(p.is_dnc_locked, false) or coalesce(c.do_not_contact, false)");
    expect(sql).toContain("left join public.contacts c on c.id = g.contact_id");
  });
});
