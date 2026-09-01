import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260901181004_record_definitive_esign_template_provider_create_failure.sql",
  "utf8",
);

describe("definitive eSign provider failure migration", () => {
  it("keeps the definitive failure transition fenced to the exact invocation token", () => {
    expect(sql).toContain(
      "template.provider_create_claim_token_hash = v_token_hash;",
    );
    expect(sql).toContain(
      "and template.provider_create_claim_token_hash =\n      v_template.provider_create_claim_token_hash",
    );
  });

  it("separates new-code retry capability from rollback-compatible recovery", () => {
    expect(sql).toContain(
      "create or replace function public.list_retryable_esign_template_provider_creates",
    );
    expect(sql).toContain(
      "template.provider_create_state = 'unknown'",
    );
    expect(sql).toContain(
      "template.provider_create_error_code = 'PROVIDER_REQUEST_REJECTED'",
    );
    expect(sql).toContain(
      "create or replace function public.begin_definitive_esign_template_provider_create_retry",
    );
    expect(sql).toContain(
      "and template.provider_create_claim_token_hash is not null\n    and template.provider_create_last_released_token_hash is null",
    );
  });

  it("keeps both recovery functions service-role only", () => {
    expect(sql.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/g)).toHaveLength(5);
    expect(sql).toContain(
      "revoke all on function public.list_retryable_esign_template_provider_creates",
    );
    expect(sql).toContain(
      "grant execute on function public.list_retryable_esign_template_provider_creates",
    );
    expect(sql).toContain("set provider_create_state = 'invoking'");
    expect(sql).toContain(
      "provider_create_invocation_started_at = v_started_at",
    );
    expect(sql).toContain(
      "revoke all on function public.begin_definitive_esign_template_provider_create_retry",
    );
  });
});
