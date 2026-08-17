import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260816150000_sms_conversation_org_guard.sql", import.meta.url),
  "utf8",
);

describe("Migration 20260816150000 — SMS conversation organization guard", () => {
  it("scans every SMS row and enforces active, unexpired membership", () => {
    expect(sql).toContain("m.conversation_id = p_conversation_id");
    expect(sql).not.toMatch(/\blimit\b/i);
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("membership.deletion_prepared_at is null");
    expect(sql).toContain("membership.access_expires_at > statement_timestamp()");
  });

  it("returns one tenant, returns null for none, and raises rather than guessing on collisions", () => {
    expect(sql).toContain("array_agg(distinct m.org_id order by m.org_id)");
    expect(sql).toContain("return null");
    expect(sql).toContain("SMS_CONVERSATION_ORG_AMBIGUOUS");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("revoke all on function public.resolve_sms_conversation_org(uuid) from anon");
  });
});
