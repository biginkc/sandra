import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260816120000_sms_inbox_thread_snapshot.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("SMS inbox thread snapshot migration", () => {
  it("keeps the snapshot invoker-scoped and requires active, unexpired access", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toContain("membership.user_id = auth.uid()");
    expect(sql).toContain("membership.org_id = m.org_id");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("membership.deletion_prepared_at is null");
    expect(sql).toContain(
      "membership.access_expires_at > statement_timestamp()",
    );
  });

  it("clamps the caller cutoff and fails closed instead of truncating oversized snapshots", () => {
    expect(sql).toContain("statement_timestamp() - interval '365 days'");
    expect(sql).toContain("meta.thread_count <= 20000");
    expect(sql).toContain("'__error', 'thread_limit_exceeded'");
    expect(sql).not.toMatch(/\blimit\s+1000\b/i);
  });

  it("returns one scalar JSON value so PostgREST cannot apply its row cap", () => {
    expect(sql).toContain("returns jsonb");
    expect(sql).toContain("hydrated as materialized");
    expect(sql).toContain("jsonb_agg(");
  });
});
