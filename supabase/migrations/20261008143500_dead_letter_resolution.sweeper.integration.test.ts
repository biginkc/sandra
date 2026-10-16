import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orphanPropertiesQuery, orphanSliceBounds, ORPHAN_PLACEHOLDER_BODY } from "@/lib/ai-responder/dispatch";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

/**
 * Orphaned-timeout sweeper (dispatch.ts repairOrphanedTimeouts). Local-only.
 *  1. The real orphan properties query runs through a real PostgREST against
 *     committed local rows: the `.or(...)` reason filter ANDs with the
 *     `needs_human_attention`, window, and id-slice filters.
 *  2. The synthetic dead-letter insert satisfies the table's constraints
 *     (rolled-back transaction, chain replayed like the resolution test).
 */
const dir = __dirname;
const CHAIN = readdirSync(dir)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008143500_zz")
  .sort()
  .map((f) => readFileSync(path.join(dir, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""));

const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const orgId = randomUUID();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const windowIso = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
const A = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const inbound = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function seedProperty(id: string, over: { flag?: boolean; reason?: string | null; at?: string | null }) {
  await db.query(
    `insert into public.properties (id, org_id, address, state, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at)
     values ($1, $2, '1 Test St', 'MO', $3, $4, $5)`,
    [id, orgId, over.flag ?? true, over.reason ?? null, over.at ?? null],
  );
}

describe("orphaned-timeout sweeper", () => {
  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await db.connect();
  });
  afterAll(async () => {
    await db.query("delete from public.properties where org_id = $1", [orgId]).catch(() => undefined);
    await db.query("delete from public.organizations where id = $1", [orgId]).catch(() => undefined);
    await db.end();
  });

  it("the orphan properties query ANDs flag, reason (OR of a like AND NOT like backed, and a like), window and id slice under real PostgREST", async () => {
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Sweeper ${orgId}`]);
    // Slice "a": only 1, 2 and 6 match every filter.
    await seedProperty(A(1), { reason: `send_timeout:${inbound(1)}`, at: hourAgo });
    await seedProperty(A(2), { reason: `dead_letter_failed:send_timeout:${inbound(2)}`, at: hourAgo });
    await seedProperty(A(3), { reason: `send_timeout_then_sent`, at: hourAgo }); // terminal flag spelling
    await seedProperty(A(4), { flag: false, reason: `send_timeout:${inbound(4)}`, at: hourAgo }); // flag cleared
    await seedProperty(A(5), { reason: `send_timeout:${inbound(5)}`, at: eightDaysAgo }); // out of window
    await seedProperty(A(7), { reason: `send_timeout:${inbound(7)}`, at: null }); // legacy null stamp
    await seedProperty(A(8), { reason: `other:${inbound(8)}`, at: hourAgo }); // unrelated reason
    await seedProperty(A(6), { reason: `send_timeout:${inbound(6)}`, at: hourAgo });
    // Slice "b": matches every filter except the slice.
    await seedProperty(B(1), { reason: `send_timeout:${inbound(9)}`, at: hourAgo });
    // Backed flags (dead-letter row exists) are excluded server-side, in both slices.
    await seedProperty(A(9), { reason: `send_timeout:${inbound(10)}:backed`, at: hourAgo });
    await seedProperty(A(10), { reason: `dead_letter_failed:send_timeout:${inbound(12)}:backed`, at: hourAgo });
    await seedProperty(B(2), { reason: `send_timeout:${inbound(11)}:backed`, at: hourAgo });

    const supabase = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Other local rows may exist; narrow to this org only for the assertion.
    const sliceA = orphanSliceBounds(10);
    const sliceB = orphanSliceBounds(11);
    const run = async (slice: { lower: string; upper: string | null }, after: string | null) => {
      const { data, error } = await orphanPropertiesQuery(supabase as never, { windowIso, ...slice, after });
      expect(error).toBeNull();
      return ((data ?? []) as Array<{ id: string; org_id: string }>).filter((r) => r.org_id === orgId).map((r) => r.id);
    };
    expect(await run(sliceA, null)).toEqual([A(1), A(2), A(6)]);
    expect(await run(sliceA, A(1))).toEqual([A(2), A(6)]); // keyset continuation
    expect(await run(sliceB, null)).toEqual([B(1)]);
  });

  it("the synthetic recovery row satisfies the table constraints", async () => {
    const org = randomUUID();
    const propertyId = randomUUID();
    const messageId = randomUUID();
    const conversationId = randomUUID();
    await db.query("begin");
    try {
      for (const sql of CHAIN) await db.query(sql);
      await db.query("insert into public.organizations (id, name) values ($1, $2)", [org, `Synth ${org}`]);
      await db.query(
        `insert into public.properties (id, org_id, address, state, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at)
         values ($1, $2, '2 Test St', 'MO', true, $3, $4)`,
        [propertyId, org, `send_timeout:${messageId}`, hourAgo],
      );
      await db.query(
        `insert into public.messages (id, org_id, conversation_id, channel, direction, body)
         values ($1, $2, $3, 'sms', 'inbound', 'hi')`,
        [messageId, org, conversationId],
      );
      // Same column set as repairOrphanedTimeouts, as the service role.
      await db.query("set local role service_role");
      await db.query(
        `insert into public.ai_reply_dead_letters (org_id, conversation_id, property_id, inbound_message_id, body, reason, created_at)
         values ($1, $2, $3, $4, $5, 'send_timeout', $6)`,
        [org, conversationId, propertyId, messageId, ORPHAN_PLACEHOLDER_BODY, hourAgo],
      );
      // And with no resolvable inbound conversation (conversation_id null).
      await db.query(
        `insert into public.ai_reply_dead_letters (org_id, conversation_id, property_id, inbound_message_id, body, reason, created_at)
         values ($1, null, $2, $3, $4, 'send_timeout', $5)`,
        [org, propertyId, messageId, ORPHAN_PLACEHOLDER_BODY, hourAgo],
      );
      await db.query("reset role");
      const { rows } = await db.query(
        "select count(*)::int as n from public.ai_reply_dead_letters where property_id = $1 and resolved_at is null",
        [propertyId],
      );
      expect(rows[0].n).toBe(2);
    } finally {
      await db.query("rollback");
    }
  });
});
