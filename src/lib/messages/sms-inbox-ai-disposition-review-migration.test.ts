import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260828022800_sms_inbox_ai_disposition_review_queue_timeout_recovery.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Sandra Dispo pending AI review migration", () => {
  it("defines Sandra Dispo from an exact pending org/conversation/property review", () => {
    expect(sql).toContain("from public.ai_disposition_reviews review");
    expect(sql).toContain("review.status = 'pending'");
    expect(sql).toContain("review.org_id = g.org_id");
    expect(sql).toContain("review.conversation_id = g.conversation_id");
    expect(sql).toContain("review.property_id = g.property_id");
    expect(sql).toContain(
      "when 'dispo' then c.ai_disposition_review_id is not null",
    );
    expect(sql).not.toContain("when 'dispo' then c.outreach_dispo is not null");
  });

  it("keeps list and count on the same pending-review predicate", () => {
    expect(sql).toContain(
      "count(*) filter (where c.ai_disposition_review_id is not null and not c.is_test_traffic)::integer as dispo_count",
    );
    expect(sql).toContain(
      "when 'dispo' then c.ai_disposition_review_id is not null",
    );
    expect(sql).toContain("when 'dispo' then not active.is_test_traffic");
  });

  it("admits old-only pending conversations without re-ranking or rescanning recent conversations", () => {
    expect(sql).toContain("pending_reviews as materialized");
    expect(sql).toContain("recent_eligible as materialized");
    expect(sql).toContain("recent_grouped as materialized");
    expect(sql).toContain("old_review_conversations as materialized");
    expect(sql).toContain("old_review_eligible as materialized");
    expect(sql).toContain("old_review_grouped as materialized");
    expect(sql).toContain("from old_review_conversations review");
    expect(sql).toContain("m.org_id = review.org_id");
    expect(sql).toContain("m.conversation_id = review.conversation_id");
    expect(sql).toContain("recent.conversation_id = review.conversation_id");
    expect(sql).toContain("select review.property_id");
    expect(sql).toContain("review.conversation_id = e.conversation_id");
    expect(sql).toContain("false as has_recent");
    expect(sql).toContain("select recent.*");
    expect(sql).toContain("select review.*");
    expect(sql).toContain("from old_review_grouped review");
    expect(sql).toContain("else c.has_recent");
    expect(sql).not.toContain("ranked as materialized");
    expect(sql).not.toContain(
      "from pending_reviews review\n    join public.messages",
    );
    expect(sql).not.toMatch(
      /m\.created_at\s*>=\s*\(select cutoff from bounds\)\s+or/i,
    );
  });

  it("returns the complete pending-review identity and decision metadata", () => {
    for (const key of [
      "ai_disposition_review_id",
      "ai_disposition_review_status",
      "ai_disposition_review_disposition",
      "ai_disposition_review_reason",
      "ai_disposition_review_created_at",
      "ai_disposition_review_source_inbound_message_id",
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
  });

  it("shows compliance reviews only in Sandra Dispo and always hides test traffic there", () => {
    expect(sql).toContain(
      "coalesce(r.is_dnc_locked, false) or r.is_opted_out or r.is_test_traffic as is_noise",
    );
    expect(sql).toContain("when 'dispo' then not active.is_test_traffic");
    expect(sql).toContain("else not p_hide_noise or not active.is_noise");
    expect(sql).toContain(
      "count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise))::integer as all_count",
    );
  });

  it("preserves the access and response safety contract", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toContain("membership.access_status = 'active'");
    expect(sql).toContain("having count(distinct m.org_id) > 1");
    expect(sql).toContain("'cross_org_conversation_id_ambiguity'");
    expect(sql).toContain("grant execute on function");
  });
});
