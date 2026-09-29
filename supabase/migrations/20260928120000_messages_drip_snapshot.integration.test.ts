import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";

const oldSql = readFileSync(new URL("./20260909080000_messages_search.sql", import.meta.url), "utf8");
const newSql = readFileSync(new URL("./20260928120000_messages_drip_snapshot.sql", import.meta.url), "utf8");
type Snapshot = { rows: Record<string, unknown>[]; counts: Record<string, number>; total: number };

it("applies twice, preserves old snapshot values, aligns replied counts, and uses the enrollment index", async () => {
  const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(oldSql);
    const query = "select public.sms_inbox_thread_page_snapshot(now() - interval '90 days', 'all', null, null, false, 500, 0, null) as snapshot";
    const before = (await db.query<{ snapshot: Snapshot }>(query)).rows[0]!.snapshot;
    await db.query(newSql);
    await db.query(newSql);
    const after = (await db.query<{ snapshot: Snapshot }>(query)).rows[0]!.snapshot;
    expect(after.rows.map((row) => Object.fromEntries(Object.keys(before.rows[0] ?? {}).map((key) => [key, row[key]])))).toEqual(before.rows);
    for (const [key, count] of Object.entries(before.counts)) expect(after.counts[key]).toBe(count);
    expect(after.total).toBe(before.total);

    const replied = (await db.query<{ snapshot: Snapshot }>(
      "select public.sms_inbox_thread_page_snapshot(now() - interval '90 days', 'drip_replied', null, null, false, 500, 0, null) as snapshot",
    )).rows[0]!.snapshot;
    expect(replied.total).toBe(after.counts.drip_replied);
    expect(replied.rows.every((row) => row.drip_replied === true)).toBe(true);

    await db.query("set local enable_seqscan = off");
    const explain = async () => (await db.query<{ "QUERY PLAN": string }>(
      `explain select drip.id from (values ($1::uuid, $2::uuid)) as thread(property_id, org_id)
       left join lateral (
         select enrollment.id from public.sequence_enrollments enrollment
         where enrollment.property_id = thread.property_id
           and enrollment.org_id = thread.org_id
           and enrollment.status in ('active', 'paused')
         order by enrollment.enrolled_at desc, enrollment.id desc limit 1
       ) drip on true`,
      [randomUUID(), randomUUID()],
    )).rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(await explain()).toMatch(/Index (?:Scan|Only Scan).*idx_enrollments_property[\s\S]*Index Cond: \(property_id =/);
    await db.query("savepoint without_index");
    await db.query("drop index public.idx_enrollments_property");
    expect(await explain()).not.toContain("Index Cond: (property_id =");
    await db.query("rollback to savepoint without_index");
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}, 60_000);
