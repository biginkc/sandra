import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260910120000_messages_mine_filter_all_statuses.sql",
    import.meta.url,
  ),
  "utf8",
);
const searchSql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260909080000_messages_search.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollbackSql = readFileSync(
  new URL(
    "../../../supabase/rollbacks/20260910120000_messages_mine_filter_all_statuses.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Messages Mine filter includes every assigned status", () => {
  it("drops the leads-only gate from the Mine count and rows", () => {
    // Mine is now status-agnostic: just the assignee match, no prospect gate.
    expect(sql).toContain(
      "(not p_hide_noise or not c.is_noise) and p_assignee_id is not null and c.assigned_user_id = p_assignee_id)::integer as mine_count,",
    );
    expect(sql).toContain(
      "when 'mine' then c.has_recent and p_assignee_id is not null and c.assigned_user_id = p_assignee_id",
    );
    // The prospect gate must no longer sit in front of a Mine predicate.
    expect(sql).not.toContain(
      "c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id",
    );
  });

  it("keeps No owner limited to actual leads (unchanged scope)", () => {
    expect(sql).toContain(
      "c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null",
    );
    expect(sql.match(/c\.assigned_user_id is null/g)).toHaveLength(2);
  });

  it("preserves the current search signature and function timeout", () => {
    expect(sql).toContain("p_search text DEFAULT NULL::text");
    expect(sql).toContain("SET statement_timeout TO '15s'");
    expect(sql).toContain(
      "alter function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text)",
    );
    expect(sql).toContain("set statement_timeout = '15s';");
  });

  it("preserves the optimized query and access boundaries", () => {
    expect(sql).toContain("recent_grouped as materialized");
    expect(sql).toContain("old_review_conversations as materialized");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
  });

  it("changes only the two Mine predicates in the current search definition", () => {
    const functionStart = "CREATE OR REPLACE FUNCTION";
    const currentDefinition = searchSql.slice(searchSql.indexOf(functionStart));
    const oldMinePredicate =
      "c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id";
    expect(currentDefinition.split(oldMinePredicate)).toHaveLength(3);
    expect(sql.slice(sql.indexOf(functionStart))).toBe(
      currentDefinition.replaceAll(
        oldMinePredicate,
        "p_assignee_id is not null and c.assigned_user_id = p_assignee_id",
      ),
    );
    // Rollback must preserve search, optimizations, tenant access, and grants.
    expect(rollbackSql.slice(rollbackSql.indexOf(functionStart))).toBe(
      currentDefinition,
    );
  });
});
