import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const oldSql = readFileSync(new URL("../../../supabase/migrations/20260909080000_messages_search.sql", import.meta.url), "utf8");
const sql = readFileSync(new URL("../../../supabase/migrations/20260928120000_messages_drip_snapshot.sql", import.meta.url), "utf8");

function projectedKeys(source: string): string[] {
  const projection = source.split("document as (")[1]?.split("from page_rows row")[0] ?? "";
  return [...projection.matchAll(/'([a-z_]+)', row\./g)].map((match) => match[1]!);
}

describe("drip inbox snapshot migration", () => {
  it("preserves every existing projected field and adds four drip fields", () => {
    expect(projectedKeys(sql)).toEqual([
      ...projectedKeys(oldSql).slice(0, 9),
      "drip_name", "drip_step", "drip_steps_total", "drip_replied",
      ...projectedKeys(oldSql).slice(9),
    ]);
  });

  it("uses one enrollment lateral join, an indexed property lookup, and invoker security", () => {
    expect(sql).toContain("STABLE SECURITY INVOKER");
    expect(sql).toContain("SET search_path TO ''");
    expect(sql).toContain("where enrollment.property_id = g.property_id");
    expect(sql).toContain("enrollment.org_id = g.org_id");
    expect(sql.match(/from public\.sequence_enrollments enrollment/g)).toHaveLength(1);
    expect(sql).toContain("enrollment.pause_reason in ('inbound_reply', 'rep_sms_human_takeover')");
  });

  it("keeps count and list predicates aligned for the new filter", () => {
    expect(sql).toContain("'needs_outcome', 'drip_replied')");
    expect(sql).toContain("as drip_replied_count");
    expect(sql).toContain("when 'drip_replied' then c.has_recent and c.drip_replied");
    expect(sql).toContain("'drip_replied', counts.drip_replied_count");
  });
});
