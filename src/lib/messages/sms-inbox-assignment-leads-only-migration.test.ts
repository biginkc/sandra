import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260828053000_messages_assignment_filters_leads_only.sql",
    import.meta.url,
  ),
  "utf8",
);
const previousSql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260828022800_sms_inbox_ai_disposition_review_queue_timeout_recovery.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollbackSql = readFileSync(
  new URL(
    "../../../supabase/rollbacks/20260828053000_messages_assignment_filters_leads_only.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Messages assignment filters use the canonical lead boundary", () => {
  it("keeps Mine count and rows limited to actual leads", () => {
    expect(sql).toContain(
      "c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id",
    );
    expect(sql.match(/c\.assigned_user_id = p_assignee_id/g)).toHaveLength(2);
  });

  it("keeps No owner count and rows limited to actual leads", () => {
    expect(sql).toContain(
      "c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null",
    );
    expect(sql.match(/c\.assigned_user_id is null/g)).toHaveLength(2);
  });

  it("preserves the optimized query and access boundaries", () => {
    expect(sql).toContain("recent_grouped as materialized");
    expect(sql).toContain("old_review_conversations as materialized");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
  });

  it("rolls back to the exact previously deployed function", () => {
    const functionStart = "create or replace function";
    expect(rollbackSql.slice(rollbackSql.indexOf(functionStart))).toBe(
      previousSql.slice(previousSql.indexOf(functionStart)),
    );
  });
});
