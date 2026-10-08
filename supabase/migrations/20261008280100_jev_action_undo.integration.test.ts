import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261008280100: fn_undo_jev_action restores what Jev's auto-applied action
 * overwrote. Local-only; rolled-back transaction per test.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008280100_jev_action_undo.sql"), "utf8"));

const db = new Client({ connectionString: url });
let orgId: string;
let ownerId: string;
let outsiderId: string;
let propertyId: string;
let messageId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(MIGRATION);
  orgId = randomUUID();
  ownerId = randomUUID();
  outsiderId = randomUUID();
  propertyId = randomUUID();
  messageId = randomUUID();
  const conversationId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'undo')", [orgId]);
  await db.query("set local session_replication_role = replica");
  for (const id of [ownerId, outsiderId]) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u-${id}@test.local`]);
  }
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`,
    [orgId, ownerId],
  );
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, follow_up_at)
     values ($1, $2, 'Undo St', 'TX', 'prospect', 'wrong_number', null)`,
    [propertyId, orgId],
  );
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, $4, 'sms', 'inbound', 'wrong number')`,
    [messageId, orgId, propertyId, conversationId],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("release savepoint as_user");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint as_user");
    await db.query("reset role");
    throw e;
  }
}

async function recordUndo(over: { applied?: string; prior?: string | null; followUp?: string | null; enrollments?: string[] } = {}) {
  const id = randomUUID();
  await db.query(
    `insert into public.jev_action_undo
       (id, org_id, property_id, source_inbound_message_id, action, applied_dispo,
        prior_outreach_dispo, prior_follow_up_at, paused_enrollment_ids)
     values ($1, $2, $3, $4, 'wrong_number', $5, $6, $7, $8)`,
    [id, orgId, propertyId, messageId, over.applied ?? "wrong_number", "prior" in over ? over.prior : "nurture", "followUp" in over ? over.followUp : "2026-10-20T00:00:00Z", over.enrollments ?? []],
  );
  return id;
}

const undo = (userId: string, id: string) =>
  as(userId, async () => (await db.query(`select public.fn_undo_jev_action($1) as r`, [id])).rows[0].r);

describe("fn_undo_jev_action", () => {
  it("restores the prior disposition and follow-up date, returns the paused enrollment ids, and writes an audit event", async () => {
    const enrollment = randomUUID();
    const id = await recordUndo({ enrollments: [enrollment] });
    const r = await undo(ownerId, id);
    expect(r).toMatchObject({ status: "undone", enrollmentIds: [enrollment] });
    const p = (await db.query(`select outreach_dispo, follow_up_at from public.properties where id = $1`, [propertyId])).rows[0];
    expect(p.outreach_dispo).toBe("nurture");
    expect(new Date(p.follow_up_at).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    const events = (await db.query(`select event_type from public.lead_events where property_id = $1 and event_type = 'jev_action_undone'`, [propertyId])).rows;
    expect(events).toHaveLength(1);
    const row = (await db.query(`select undone_by from public.jev_action_undo where id = $1`, [id])).rows[0];
    expect(row.undone_by).toBe(ownerId);
  });

  it("is idempotent: a second undo changes nothing and returns no enrollments", async () => {
    const id = await recordUndo({ enrollments: [randomUUID()] });
    await undo(ownerId, id);
    await db.query(`update public.properties set outreach_dispo = 'callback_requested' where id = $1`, [propertyId]);
    const again = await undo(ownerId, id);
    expect(again).toEqual({ status: "already_undone", enrollmentIds: [] });
    const p = (await db.query(`select outreach_dispo from public.properties where id = $1`, [propertyId])).rows[0];
    expect(p.outreach_dispo).toBe("callback_requested");
  });

  it("refuses with STATE_CHANGED when a person changed the disposition since, and changes nothing", async () => {
    const id = await recordUndo();
    await db.query(`update public.properties set outreach_dispo = 'not_interested' where id = $1`, [propertyId]);
    await expect(undo(ownerId, id)).rejects.toThrow(/STATE_CHANGED/);
    const p = (await db.query(`select outreach_dispo from public.properties where id = $1`, [propertyId])).rows[0];
    expect(p.outreach_dispo).toBe("not_interested");
  });

  it("refuses a user with no access to the org", async () => {
    const id = await recordUndo();
    await expect(undo(outsiderId, id)).rejects.toThrow(/FORBIDDEN/);
  });

  it("restores a null prior state (nothing was set before Jev acted)", async () => {
    const id = await recordUndo({ prior: null, followUp: null });
    await undo(ownerId, id);
    const p = (await db.query(`select outreach_dispo, follow_up_at from public.properties where id = $1`, [propertyId])).rows[0];
    expect(p).toEqual({ outreach_dispo: null, follow_up_at: null });
  });
});
