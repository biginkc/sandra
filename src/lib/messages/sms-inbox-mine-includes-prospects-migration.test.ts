import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260910120000_messages_mine_filter_all_statuses.sql",
    import.meta.url,
  ),
  "utf8",
);
const leadsOnlySql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260828053000_messages_assignment_filters_leads_only.sql",
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

  it("re-applies the statement_timeout the hotfix set (CREATE OR REPLACE drops it)", () => {
    expect(sql).toContain("alter function public.sms_inbox_thread_page_snapshot(");
    expect(sql).toContain("set statement_timeout = '15s';");
  });

  it("preserves the optimized query and access boundaries", () => {
    expect(sql).toContain("recent_grouped as materialized");
    expect(sql).toContain("old_review_conversations as materialized");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
  });

  it("rolls back to the exact leads-only function body", () => {
    const functionStart = "create or replace function";
    // The rollback restores the leads-only body verbatim, then re-applies the
    // statement_timeout the hotfix set. Compare the function-definition block
    // (everything before that appended `alter function`) to the leads-only
    // migration's function block.
    const leadsOnlyFn = leadsOnlySql
      .slice(leadsOnlySql.indexOf(functionStart))
      .trimEnd();
    // The rollback embeds the leads-only function body verbatim, then appends
    // the statement_timeout re-assertion.
    expect(rollbackSql).toContain(leadsOnlyFn);
    expect(rollbackSql).toContain("\nalter function");
  });
});
