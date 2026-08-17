import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260816140000_sms_inbox_snapshot_tenant_suppression_hardening.sql",
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

  it("preserves tenant identity through grouping and every hydration join", () => {
    expect(sql).toContain("partition by m.org_id, m.conversation_id");
    expect(sql).toContain("group by e.org_id, e.conversation_id");
    expect(sql).toContain("c.org_id = g.org_id");
    expect(sql).toContain("p.org_id = g.org_id");
    expect(sql).toContain("mt.org_id = g.org_id");
    expect(sql).toContain("consent.org_id = g.org_id");
  });

  it("uses durable org-and-phone suppression and rejects cross-org thread identity collisions", () => {
    expect(sql).toContain("suppression.org_id = g.org_id");
    expect(sql).toContain("suppression.phone_e164 = case");
    expect(sql).toContain("h.is_phone_suppressed");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
    expect(sql).toContain("from public.messages m");
    expect(sql).toContain("select grouped_thread.conversation_id from grouped");
    expect(sql).toContain("regexp_replace(coalesce(");
    expect(sql).toContain("'__error', 'cross_org_conversation_id_ambiguity'");
  });
});
