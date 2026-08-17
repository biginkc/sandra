import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260817100000_sms_inbox_thread_pagination.sql",
    import.meta.url,
  ),
  "utf8",
);

const narrowWorksetSql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260817110000_sms_inbox_thread_page_narrow_workset.sql",
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

  it("moves wide row hydration behind the bounded page in a forward migration", () => {
    const pageBoundary = narrowWorksetSql.indexOf("page_core as materialized");
    const beforePage = narrowWorksetSql.slice(0, pageBoundary);
    const eligibleStart = narrowWorksetSql.indexOf("eligible as materialized");
    const eligibleEnd = narrowWorksetSql.indexOf("grouped as materialized");
    const eligibleCte = narrowWorksetSql.slice(eligibleStart, eligibleEnd);

    expect(narrowWorksetSql).toContain("eligible as materialized");
    expect(eligibleCte).not.toMatch(/\bm\.body\b/);
    expect(narrowWorksetSql).toContain("page_core as materialized");
    expect(narrowWorksetSql).toContain("last_message.body as last_message_body");
    expect(pageBoundary).toBeLessThan(
      narrowWorksetSql.indexOf("last_message.body as last_message_body"),
    );
    for (const pageOnlyField of [
      "ai_responder_reason",
      "ai_responder_status_at",
      "ai_last_delivery_status",
      "ai_last_delivery_error",
    ]) {
      expect(beforePage).not.toContain(pageOnlyField);
      expect(narrowWorksetSql.slice(pageBoundary)).toContain(pageOnlyField);
    }
    expect(narrowWorksetSql).toContain(
      "and (select count(*) from visible_orgs) <= 1",
    );
    expect(narrowWorksetSql).toContain("security invoker");
  });

  it("keeps the complete response, filter, and safety contract in the forward definition", () => {
    for (const count of [
      "all_count",
      "mine_count",
      "unassigned_count",
      "unread_count",
      "escalated_count",
      "dispo_count",
      "needs_outcome_count",
    ]) {
      expect(narrowWorksetSql).toContain(count);
    }
    for (const filter of [
      "when 'mine'",
      "when 'unassigned'",
      "when 'unread'",
      "when 'escalated'",
      "when 'dispo'",
      "when 'needs_outcome'",
    ]) {
      expect(narrowWorksetSql).toContain(filter);
    }
    for (const responseKey of [
      "'thread_id'",
      "'contact_id'",
      "'contact_name'",
      "'thread_customer_phone'",
      "'thread_business_phone'",
      "'property_id'",
      "'property_address'",
      "'property_status'",
      "'outreach_dispo'",
      "'is_dnc_locked'",
      "'assignee_id'",
      "'last_message_body'",
      "'last_message_direction'",
      "'last_message_at'",
      "'unread_count'",
      "'has_inbound'",
      "'needs_human_attention'",
      "'escalation_reason'",
      "'is_opted_out'",
      "'is_test_traffic'",
      "'needs_outcome'",
      "'ai_responder_status'",
      "'ai_responder_reason'",
      "'ai_responder_status_at'",
      "'ai_last_delivery_status'",
      "'ai_last_delivery_error'",
    ]) {
      expect(narrowWorksetSql).toContain(responseKey);
    }
    expect(narrowWorksetSql).toContain("membership.access_status = 'active'");
    expect(narrowWorksetSql).toContain(
      "partition by m.org_id, m.conversation_id",
    );
    expect(narrowWorksetSql).toContain("suppression.org_id = g.org_id");
    expect(narrowWorksetSql).toContain("having count(distinct m.org_id) > 1");
    expect(narrowWorksetSql).toContain(
      "'cross_org_conversation_id_ambiguity'",
    );
    expect(narrowWorksetSql).toContain("'rows', document.rows");
    expect(narrowWorksetSql).toContain("'total', meta.total_count");
    expect(narrowWorksetSql).toContain("'hidden_count', meta.hidden_count");
    expect(narrowWorksetSql).toContain("'limit', page.page_limit");
    expect(narrowWorksetSql).toContain("'offset', page.page_offset");
  });
});
