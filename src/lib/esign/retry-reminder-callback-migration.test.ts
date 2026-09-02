import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260901020000_esign_retry_and_reminder_callback_fences.sql",
  "utf8",
);

describe("retry and reminder callback fence migration", () => {
  it("enforces one direct retry child per failed source", () => {
    expect(sql).toContain(
      "create unique index if not exists esign_requests_one_retry_child_per_source_idx",
    );
    expect(sql).toContain("where retry_of_request_id is not null");
  });

  it("requires the active receipt lease and exact signer/time identity", () => {
    expect(sql).toContain(
      "create or replace function public.reconcile_esign_reminder_callback",
    );
    for (const fence of [
      "receipt.processing_lease_id = p_lease_id",
      "receipt.event_type = 'signature_request_remind'",
      "receipt.related_signature_id = p_provider_signature_id",
      "receipt.provider_event_at = p_provider_event_at",
      "signer.reminder_claim_token = v_claim_token",
      "signer.reminder_claimed_at = v_claimed_at",
    ]) {
      expect(sql).toContain(fence);
    }
  });

  it("keeps older callbacks fenced and retains service-role-only execution", () => {
    expect(sql).toContain("return query select 'stale_ignored'::text");
    expect(sql).toContain("service role required");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
