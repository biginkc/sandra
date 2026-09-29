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
    // Keep every row inside this transaction and isolate the snapshot from
    // fixtures left by other integration files via a unique contact name.
    const orgId = randomUUID();
    const sequenceId = randomUUID();
    const marker = `snapshot${randomUUID().replaceAll("-", "")}`;
    const cases = [
      { kind: "replied", status: "paused", pauseReason: "inbound_reply", stepIndex: 1 },
      { kind: "active", status: "active", pauseReason: null, stepIndex: 1 },
      { kind: "completed", status: "completed", pauseReason: null, stepIndex: 3 },
      { kind: "no-phone", status: "paused", pauseReason: "no_phone", stepIndex: 1 },
    ] as const;
    const threadIds = new Map<string, string>();
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, marker]);
    await db.query("insert into public.sequences (id, org_id, name) values ($1, $2, $3)", [sequenceId, orgId, "Snapshot drip"]);
    for (const stepIndex of [0, 1, 2]) {
      await db.query(
        "insert into public.sequence_steps (sequence_id, step_index, action_type, template_body) values ($1, $2, 'send_sms', 'Hello')",
        [sequenceId, stepIndex],
      );
    }
    for (const entry of cases) {
      const contactId = randomUUID();
      const propertyId = randomUUID();
      const threadId = randomUUID();
      threadIds.set(entry.kind, threadId);
      await db.query(
        "insert into public.contacts (id, org_id, first_name, last_name) values ($1, $2, $3, $4)",
        [contactId, orgId, marker, entry.kind],
      );
      await db.query(
        "insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, $3, 'MO', 'new_lead', $4)",
        [propertyId, orgId, `${entry.kind} Snapshot Lane`, contactId],
      );
      await db.query(
        `insert into public.sequence_enrollments
         (org_id, sequence_id, property_id, contact_id, status, pause_reason, current_step_index)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, sequenceId, propertyId, contactId, entry.status, entry.pauseReason, entry.stepIndex],
      );
      await db.query(
        `insert into public.messages
         (org_id, contact_id, property_id, conversation_id, channel, direction, status, body, from_address, to_address)
         values ($1, $2, $3, $4, 'sms', 'inbound', 'received', $5, '+18165550100', '+18165550200')`,
        [orgId, contactId, propertyId, threadId, `Snapshot ${entry.kind}`],
      );
    }
    await db.query(oldSql);
    const snapshot = async (filter: string) => (await db.query<{ snapshot: Snapshot }>(
      "select public.sms_inbox_thread_page_snapshot(now() - interval '90 days', $1, null, null, false, 500, 0, $2) as snapshot",
      [filter, marker],
    )).rows[0]!.snapshot;
    const before = await snapshot("all");
    expect(before.rows).toHaveLength(cases.length);
    expect(new Set(before.rows.map((row) => row.thread_id))).toEqual(new Set(threadIds.values()));
    await db.query(newSql);
    await db.query(newSql);
    const after = await snapshot("all");
    expect(after.rows.map((row) => Object.fromEntries(Object.keys(before.rows[0] ?? {}).map((key) => [key, row[key]])))).toEqual(before.rows);
    for (const [key, count] of Object.entries(before.counts)) expect(after.counts[key]).toBe(count);
    expect(after.total).toBe(before.total);
    expect(after.total).toBe(cases.length);

    const byThread = new Map(after.rows.map((row) => [row.thread_id, row]));
    expect(byThread.get(threadIds.get("replied"))).toMatchObject({
      drip_name: "Snapshot drip", drip_step: 2, drip_steps_total: 3, drip_replied: true,
    });
    expect(byThread.get(threadIds.get("active"))).toMatchObject({
      drip_name: "Snapshot drip", drip_step: 2, drip_steps_total: 3, drip_replied: false,
    });
    expect(byThread.get(threadIds.get("completed"))).toMatchObject({
      drip_name: null, drip_step: null, drip_steps_total: null, drip_replied: false,
    });
    expect(byThread.get(threadIds.get("no-phone"))).toMatchObject({
      drip_name: "Snapshot drip", drip_step: 2, drip_steps_total: 3, drip_replied: false,
    });

    const replied = await snapshot("drip_replied");
    expect(after.counts.drip_replied).toBe(1);
    expect(replied.total).toBe(1);
    expect(replied.rows).toHaveLength(1);
    expect(replied.rows[0]).toMatchObject({ thread_id: threadIds.get("replied"), drip_replied: true });

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
    expect(await explain()).toMatch(/Index (?:Scan|Only Scan) using idx_enrollments_(?:property|unique_active)[\s\S]*Index Cond: \(property_id =/);
    await db.query("savepoint without_index");
    await db.query("drop index public.idx_enrollments_property");
    await db.query("drop index public.idx_enrollments_unique_active");
    expect(await explain()).not.toContain("Index Cond: (property_id =");
    await db.query("rollback to savepoint without_index");
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}, 60_000);
