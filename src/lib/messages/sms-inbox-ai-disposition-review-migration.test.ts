import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260827230000_sms_inbox_ai_disposition_review_queue.sql",
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
    expect(sql).not.toContain(
      "when 'dispo' then c.outreach_dispo is not null",
    );
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

  it("admits old pending conversations through a separate narrow branch", () => {
    const pendingBranch = sql.slice(sql.indexOf("union all"), sql.indexOf("ranked as materialized"));

    expect(sql).toContain("pending_reviews as materialized");
    expect(sql).toContain("m.created_at >= (select cutoff from bounds)");
    expect(pendingBranch).toContain("from pending_reviews review");
    expect(pendingBranch).toContain("m.org_id = review.org_id");
    expect(pendingBranch).toContain(
      "m.conversation_id = review.conversation_id",
    );
    expect(pendingBranch).toContain(
      "m.created_at < (select cutoff from bounds)",
    );
    expect(sql).toContain("bool_or(e.is_recent) as has_recent");
    expect(sql).toContain("else c.has_recent");
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
    expect(sql).toContain(
      "else not p_hide_noise or not active.is_noise",
    );
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
