import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260901193023_esign_finish_sync_deadline.sql",
  "utf8",
);

describe("eSign finish synchronization deadline migration", () => {
  it("adds the persistent first-Finish timestamp and provider identity check", () => {
    expect(sql).toContain("add column provider_sync_started_at timestamptz");
    expect(sql).toContain("esign_templates_provider_sync_start_check");
    expect(sql).toMatch(
      /provider_sync_started_at is null\s+or sign_template_id is not null/i,
    );
  });

  it("documents the same 60-minute terminal policy enforced by the orchestrator", () => {
    expect(sql).toContain("temporary for at most 60 minutes");
  });
});
