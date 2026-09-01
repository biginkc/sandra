import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260901010000_esign_provider_mutation_reconciliation_fence.sql",
  "utf8",
);

describe("provider mutation reconciliation fence migration", () => {
  it("replaces both claim RPCs with stale reconciliation outcomes", () => {
    expect(sql).toContain(
      "create or replace function public.claim_esign_signer_reminder",
    );
    expect(sql).toContain(
      "create or replace function public.claim_esign_request_void",
    );
    expect(sql.match(/'reconciliation_required'::text/g)).toHaveLength(4);
  });

  it("does not auto-clear reminder or void claims", () => {
    expect(sql).not.toMatch(/set\s+reminder_claim_token\s*=\s*null/i);
    expect(sql).not.toMatch(/set\s+void_claim_token\s*=\s*null/i);
  });

  it("retains service-role-only execution", () => {
    expect(sql.match(/service role required/g)).toHaveLength(2);
    expect(sql.match(/from public, anon, authenticated/g)).toHaveLength(2);
    expect(sql.match(/to service_role/g)).toHaveLength(2);
  });
});
