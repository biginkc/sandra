import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260815233000_leads_urgency_paging.sql"),
  "utf8",
);
const softphoneMigration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260821100000_softphone_phase1.sql"),
  "utf8",
);

describe("Leads urgency migration contract", () => {
  it("projects exactly one deterministic earliest open task", () => {
    expect(migration).toMatch(/status\s*=\s*'open'/i);
    expect(migration).toMatch(/order by\s+t\.due_at\s+asc,\s*t\.id\s+asc/i);
    expect(migration).toMatch(/limit\s+1/i);
  });

  it("provides a property-locked idempotent current-user next-action RPC", () => {
    expect(migration).toContain("lead_next_action_idempotency_key");
    expect(migration).toMatch(/for no key update/i);
    expect(migration).toMatch(/auth\.uid\(\)/i);
    expect(migration).toMatch(/status\s*=\s*'open'/i);
    expect(migration).toMatch(/task_row\.due_at\s+is distinct from\s+p_due_at/i);
    expect(migration.indexOf("where t.org_id = lead_row.org_id")).toBeLessThan(
      migration.indexOf("if lead_row.is_dnc_locked then"),
    );
  });

  it("returns each page and its exact pre-cursor count from one materialized snapshot", () => {
    expect(migration).toContain("get_leads_board_page");
    expect(migration).toMatch(/with filtered as materialized/i);
    expect(migration).toMatch(/select b\.id, b\.next_task_due_at/i);
    expect(migration).toMatch(/join public\.leads_board card on card\.id = page_key\.id/i);
    expect(migration).toMatch(/coalesce\(p_limit, 1\)/i);
    expect(migration).toMatch(/\(select count\(\*\) from filtered\)/i);
    expect(migration).toContain("get_leads_board_urgency_counts");
    expect(migration).toContain("get_leads_board_stage_counts");
    expect(migration).toMatch(/count\(\*\) filter \(where b\.next_task_due_at is null\)/i);
  });

  it("keeps true DNC out of both board views", () => {
    expect(migration.match(/is_dnc_locked\s*=\s*false/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps SMS-only opt-outs visible in every board page and count query", () => {
    expect(migration).not.toMatch(
      /outreach_dispo::text not in \([^)]*'opted_out'[^)]*\)/i,
    );
  });

  it("leaves the applied urgency migration historical and moves the rich homeowner view forward", () => {
    expect(migration).not.toContain("'phone_1', hc.phone_1");
    expect(softphoneMigration).toMatch(/create or replace view public\.leads_board/i);
    for (const field of ["id", "phone_1", "phone_2", "phone_3", "do_not_contact", "sms_opted_out"]) {
      expect(softphoneMigration).toContain(`'${field}'`);
    }
  });
});
