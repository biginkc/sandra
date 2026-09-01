import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260901193023_esign_finish_sync_deadline.sql",
  "utf8",
);

describe("eSign finish synchronization deadline migration", () => {
  it("idempotently adds the timestamp and named provider identity check", () => {
    expect(sql).toMatch(
      /add column if not exists provider_sync_started_at timestamptz/i,
    );
    expect(sql).toMatch(
      /if not exists\s*\([\s\S]*conrelid = 'public\.esign_templates'::regclass[\s\S]*conname = 'esign_templates_provider_sync_start_check'/i,
    );
    expect(sql).toMatch(
      /provider_sync_started_at is null\s+or sign_template_id is not null/i,
    );
  });

  it("commits the NOT VALID constraint before validating existing rows", () => {
    const addConstraint = sql.search(
      /add constraint esign_templates_provider_sync_start_check/i,
    );
    const notValid = sql.indexOf("not valid", addConstraint);
    const firstCommitAfterAdd = sql.indexOf("commit;", addConstraint);
    const validate = sql.search(
      /validate constraint esign_templates_provider_sync_start_check/i,
    );

    expect(addConstraint).toBeGreaterThan(-1);
    expect(notValid).toBeGreaterThan(addConstraint);
    expect(firstCommitAfterAdd).toBeGreaterThan(notValid);
    expect(validate).toBeGreaterThan(firstCommitAfterAdd);
  });

  it("documents the same 60-minute terminal policy enforced by the orchestrator", () => {
    expect(sql).toContain("temporary for at most 60 minutes");
  });
});
