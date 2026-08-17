import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260817100000_sms_inbox_thread_pagination.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("SMS inbox thread pagination migration", () => {
  it("returns authoritative counts with a bounded server-filtered page", () => {
    expect(sql).toContain("sms_inbox_thread_page_snapshot");
    expect(sql).toContain("least(greatest(coalesce(p_limit, 200), 1), 500)");
    expect(sql).toContain("active_filtered as materialized");
    expect(sql).toContain("'counts', jsonb_build_object(");
    expect(sql).toContain("'total', meta.total_count");
    expect(sql).not.toContain("thread_limit_exceeded");
  });

  it("preserves access, tenant, suppression, and ambiguity safeguards", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("partition by m.org_id, m.conversation_id");
    expect(sql).toContain("suppression.org_id = g.org_id");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
    expect(sql).toContain("'cross_org_conversation_id_ambiguity'");
  });

  it("computes all seven thread-filter counts before page limiting", () => {
    for (const count of [
      "all_count",
      "mine_count",
      "unassigned_count",
      "unread_count",
      "escalated_count",
      "dispo_count",
      "needs_outcome_count",
    ]) {
      expect(sql).toContain(count);
    }
    expect(sql.indexOf("counts as (")).toBeLessThan(
      sql.indexOf("page_rows as ("),
    );
  });
});
