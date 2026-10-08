import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Codex round 14: the confirm RPC records a durable phone-suppression
 * obligation in the SAME transaction (20261008190000). Local-only. Replays the
 * 20261008140000..20261008190000 chain inside a rolled-back transaction and runs
 * the real TypeScript helpers against it through a pg-backed client shim.
 * Phone-level opt-out itself is stubbed with an idempotency-keyed recorder.
 */
const h = vi.hoisted(() => ({
  shim: null as unknown,
  suppressed: new Map<string, number>(),
  invocations: new Map<string, number>(),
  failOptOut: { on: false },
  als: null as unknown as import("node:async_hooks").AsyncLocalStorage<unknown>,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.als.getStore() ?? h.shim }));
vi.mock("@/lib/errors/report", () => ({ reportError: () => undefined }));
vi.mock("@/lib/events", () => ({ LEAD_EVENT_TYPES: { OPTED_OUT: "opted_out" }, recordLeadEvent: async () => undefined }));
vi.mock("@/lib/messaging/opt-out-phone", () => ({
  applyPhoneLevelOptOut: async (_c: unknown, input: { idempotencyKey: string }) => {
    if (h.failOptOut.on) throw new Error("phone suppression down");
    // Models the real idempotent write (consent event / suppression upsert unique on the key):
    // a replay is a no-op, so the effective count per key is 1. Invocations are tracked apart.
    h.invocations.set(input.idempotencyKey, (h.invocations.get(input.idempotencyKey) ?? 0) + 1);
    h.suppressed.set(input.idempotencyKey, 1);
  },
}));

import {
  applySuppressionForConfirmedReview,
  listOutstandingSuppressionReviews,
  recordSuppressionRetriedOk,
  retryOutstandingSuppressionObligations,
} from "@/lib/ai-responder/confirm-suppression";

h.als = new AsyncLocalStorage();
const dir = __dirname;
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const CHAIN = readdirSync(dir)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008190000_zz")
  .sort()
  .map((f) => strip(readFileSync(path.join(dir, f), "utf8")));
const ROLLBACK = strip(
  readFileSync(path.join(dir, "../rollbacks/20261008190000_messages_v2_confirm_records_pending_suppression.sql"), "utf8"),
);

const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

/** Minimal PostgREST-like client over the single transaction connection. */
function makeShim(conn: Client = db, inTx = true) {
  let queue: Promise<unknown> = Promise.resolve();
  let n = 0;
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const guarded = async <T,>(fn: () => Promise<T>) => {
    const sp = `sp_${(n += 1)}`;
    if (!inTx) return fn();
    await conn.query(`savepoint ${sp}`);
    try {
      const r = await fn();
      await conn.query(`release savepoint ${sp}`);
      return r;
    } catch (e) {
      await conn.query(`rollback to savepoint ${sp}`);
      throw e;
    }
  };
  const builder = (table: string) => {
    const where: Array<[string, unknown, boolean]> = [];
    const selectRows = (limit: string) =>
      serial(async () => {
        try {
          const clause = where.map(([c, , many], i) => `"${c}" ${many ? "= any(" : "= "}$${i + 1}${many ? ")" : ""}`).join(" and ");
          const r = await conn.query(
            `select * from public."${table}" ${clause ? `where ${clause}` : ""} ${limit}`,
            where.map(([, v]) => v),
          );
          return { data: r.rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      });
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (where.push([c, v, false]), b),
      in: (c: string, v: unknown[]) => (where.push([c, v, true]), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => selectRows("").then(res, rej),
      maybeSingle: () =>
        serial(async () => {
          try {
            const clause = where.map(([c, , many], i) => `"${c}" ${many ? "= any(" : "= "}$${i + 1}${many ? ")" : ""}`).join(" and ");
            const r = await conn.query(
              `select * from public."${table}" ${clause ? `where ${clause}` : ""} limit 1`,
              where.map(([, v]) => v),
            );
            return { data: r.rows[0] ?? null, error: null };
          } catch (e) {
            return { data: null, error: { message: (e as Error).message } };
          }
        }),
      insert: (values: Record<string, unknown>) =>
        serial(async () => {
          const cols = Object.keys(values);
          try {
            await guarded(() =>
              conn.query(
                `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(",")}) values (${cols
                  .map((_, i) => `$${i + 1}`)
                  .join(",")})`,
                cols.map((c) => (values[c] !== null && typeof values[c] === "object" ? JSON.stringify(values[c]) : values[c])),
              ),
            );
            return { error: null };
          } catch (e) {
            return { error: { code: (e as { code?: string }).code, message: (e as Error).message } };
          }
        }),
    };
    return b;
  };
  return {
    from: builder,
    rpc: (name: string, args: Record<string, unknown> = {}) =>
      serial(async () => {
        const keys = Object.keys(args);
        try {
          const r = await guarded(() =>
            conn.query(
              `select * from public."${name}"(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")})`,
              keys.map((k) => args[k]),
            ),
          );
          return { data: r.rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      }),
  };
}

let orgId: string;
let userId: string;
let propertyId: string;
let reviewId: string;

async function seed(disposition = "opted_out") {
  orgId = randomUUID();
  userId = randomUUID();
  propertyId = randomUUID();
  reviewId = randomUUID();
  const contactId = randomUUID();
  const messageId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Durable ${orgId}`]);
  await db.query("insert into public.memberships (user_id, org_id, role, access_status) values ($1, $2, 'member', 'active')", [userId, orgId]);
  await db.query("insert into public.contacts (id, org_id, first_name, phone_1) values ($1, $2, 'Pat', '+18165550177')", [contactId, orgId]);
  await db.query(
    "insert into public.properties (id, org_id, address, state, homeowner_contact_id, needs_human_attention, last_ai_escalation_reason) values ($1, $2, '1 Test St', 'MO', $3, true, 'low_confidence')",
    [propertyId, orgId, contactId],
  );
  await db.query(
    "insert into public.messages (id, org_id, channel, direction, property_id, contact_id, from_address, body) values ($1, $2, 'sms', 'inbound', $3, $4, '+18165550177', 'stop')",
    [messageId, orgId, propertyId, contactId],
  );
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
     values ($1, $2, $3, $4, $5, $6, 'said stop', 'pending', false,
       (select decision_context_revision from public.properties where id = $3))`,
    [reviewId, orgId, propertyId, randomUUID(), messageId, disposition],
  );
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
}

const confirm = async () =>
  (await db.query("select public.fn_confirm_ai_disposition_review($1) as r", [reviewId])).rows[0].r as { status: string };
const ledgerRows = async (type: string) =>
  (
    await db.query("select * from public.lead_events where property_id = $1 and event_type = $2 and source_id = $3", [
      propertyId,
      type,
      reviewId,
    ])
  ).rows;
const prop = async () =>
  (await db.query("select needs_human_attention n, last_ai_escalation_reason r from public.properties where id = $1", [propertyId])).rows[0];
const ageLedger = () =>
  db.query("update public.lead_events set created_at = now() - interval '5 minutes' where property_id = $1 and event_type = 'suppression_incomplete'", [propertyId]);

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  h.suppressed.clear();
  h.invocations.clear();
  h.failOptOut.on = false;
  h.shim = makeShim();
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  await db.query("set local session_replication_role = replica");
});
afterEach(async () => {
  await db.query("rollback");
});

describe("confirm records a durable suppression obligation", () => {
  it("process dies after the confirm RPC: ledger row, pointer/flag and banner data are all present", async () => {
    await seed();
    expect((await confirm()).status).toBe("confirmed");
    // TS suppression is deliberately NOT called (simulated crash).
    expect(h.suppressed.size).toBe(0);
    const rows = await ledgerRows("suppression_incomplete");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_type: "ai_disposition_reviews", actor_type: "system", payload: { reviewId } });
    expect(await prop()).toEqual({ n: true, r: `suppression_incomplete:${reviewId}` });
    const banner = await listOutstandingSuppressionReviews(h.shim as never, propertyId);
    expect(banner.reviewIds).toEqual([reviewId]);
  });

  it("sweeper: ignores a fresh obligation, then suppresses the phone, records retried_ok and clears the hold", async () => {
    await seed();
    await confirm();
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toEqual({ attempted: 0, succeeded: 0, failed: 0, holdsCleared: 0 });
    await ageLedger();
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toEqual({ attempted: 1, succeeded: 1, failed: 0, holdsCleared: 0 });
    expect(h.suppressed.size).toBe(1);
    const okRows = await ledgerRows("suppression_retried_ok");
    expect(okRows).toHaveLength(1);
    // Sweeper writes as the system actor, not the reviewer who confirmed.
    expect(okRows[0]).toMatchObject({ actor_type: "system", actor_id: null });
    expect(await prop()).toEqual({ n: false, r: null });
    expect((await listOutstandingSuppressionReviews(h.shim as never, propertyId)).reviewIds).toEqual([]);
    // Discharged: nothing left to do.
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toEqual({ attempted: 0, succeeded: 0, failed: 0, holdsCleared: 0 });
  });

  it("sweeper failure leaves the obligation outstanding; a later run discharges it", async () => {
    await seed();
    await confirm();
    await ageLedger();
    h.failOptOut.on = true;
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 1, failed: 1 });
    expect(await ledgerRows("suppression_retried_ok")).toHaveLength(0);
    expect((await prop()).n).toBe(true);
    h.failOptOut.on = false;
    // Past the 2m backoff the retry goes through.
    await db.query("update public.suppression_obligation_attempts set last_attempt_at = now() - interval '3 minutes' where review_id = $1", [reviewId]);
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ succeeded: 1 });
    expect(await prop()).toEqual({ n: false, r: null });
  });

  it("first-attempt success (confirm then suppress with discharge) clears the hold at once", async () => {
    await seed();
    await confirm();
    const r = await applySuppressionForConfirmedReview(h.shim as never, reviewId, userId, { discharge: true });
    expect(r.ok).toBe(true);
    expect(await ledgerRows("suppression_retried_ok")).toHaveLength(1);
    expect(await prop()).toEqual({ n: false, r: null });
  });

  it("first-attempt failure reuses the confirm's ledger row (no second row) and the hold stays", async () => {
    await seed();
    await confirm();
    h.failOptOut.on = true;
    const r = await applySuppressionForConfirmedReview(h.shim as never, reviewId, userId, { discharge: true });
    expect(r.ok).toBe(false);
    expect(await ledgerRows("suppression_incomplete")).toHaveLength(1);
    expect(await prop()).toEqual({ n: true, r: `suppression_incomplete:${reviewId}` });
  });

  it("not_interested confirmation records no obligation and leaves no hold", async () => {
    await seed("not_interested");
    await confirm();
    expect(await ledgerRows("suppression_incomplete")).toHaveLength(0);
    expect(((await prop()).r ?? "")).not.toMatch(/^suppression_incomplete/);
  });

  it("not_interested confirm still clears an unrelated attention flag and reason", async () => {
    await seed("not_interested");
    await db.query("update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'hot_lead' where id = $1", [propertyId]);
    await confirm();
    expect(await prop()).toEqual({ n: false, r: null });
  });

  it("confirm keeps another review's pre-existing suppression pointer id (and the flag)", async () => {
    await seed();
    const other = randomUUID();
    await db.query("update public.properties set needs_human_attention = true, last_ai_escalation_reason = $2 where id = $1", [
      propertyId,
      `suppression_incomplete:${other}`,
    ]);
    await confirm();
    const p = await prop();
    expect(p.n).toBe(true);
    // `other` has no ledger row, so the pointer is its only record and must survive.
    // reviewId is ledger-backed (the confirm wrote its row) and needs no pointer slot.
    expect(p.r).toBe(`suppression_incomplete:${other}`);
    expect((await ledgerRows("suppression_incomplete"))).toHaveLength(1);
  });

  it("a non-suppression confirm also keeps a pre-existing suppression pointer", async () => {
    await seed("not_interested");
    const other = randomUUID();
    await db.query("update public.properties set needs_human_attention = true, last_ai_escalation_reason = $2 where id = $1", [
      propertyId,
      `suppression_incomplete:${other}`,
    ]);
    await confirm();
    expect(await prop()).toEqual({ n: true, r: `suppression_incomplete:${other}` });
  });

  it("sweeper clears a hold whose ids are all resolved (clear failed after the ok write), and ignores a still-failing one", async () => {
    await seed();
    await confirm();
    await ageLedger();
    // Still failing: hold is not resolvable and is not touched.
    h.failOptOut.on = true;
    await retryOutstandingSuppressionObligations(h.shim as never);
    expect((await prop()).n).toBe(true);
    const listed = await db.query("select * from public.fn_list_resolvable_suppression_holds(100)");
    expect(listed.rows.some((r) => r.property_id === propertyId)).toBe(false);
    // Simulate: ok written, clear never ran.
    await recordSuppressionRetriedOk({ propertyId, reviewId, actorId: null });
    expect(await prop()).toEqual({ n: true, r: `suppression_incomplete:${reviewId}` });
    h.failOptOut.on = false;
    const out = await retryOutstandingSuppressionObligations(h.shim as never);
    expect(out).toMatchObject({ attempted: 0, holdsCleared: 1 });
    expect(await prop()).toEqual({ n: false, r: null });
  });

  it("sweeper never auto-clears a bare legacy hold (no ids, no ledger rows)", async () => {
    await seed();
    await db.query(
      "update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'suppression_incomplete' where id = $1",
      [propertyId],
    );
    const listed = await db.query("select * from public.fn_list_resolvable_suppression_holds(100)");
    expect(listed.rows.some((r) => r.property_id === propertyId)).toBe(false);
    const out = await retryOutstandingSuppressionObligations(h.shim as never);
    expect(out).toMatchObject({ holdsCleared: 0 });
    expect(await prop()).toEqual({ n: true, r: "suppression_incomplete" });
  });

  it("sweeper never auto-clears a two-id pointer where one id is resolved and the other is an unbacked outstanding id", async () => {
    await seed();
    await confirm();
    await recordSuppressionRetriedOk({ propertyId, reviewId, actorId: null });
    const other = randomUUID(); // no ledger row: only the pointer records it
    const pointer = `suppression_incomplete:${reviewId},${other}`;
    await db.query(
      "update public.properties set needs_human_attention = true, last_ai_escalation_reason = $2 where id = $1",
      [propertyId, pointer],
    );
    const listed = await db.query("select * from public.fn_list_resolvable_suppression_holds(100)");
    expect(listed.rows.some((r) => r.property_id === propertyId)).toBe(false);
    const out = await retryOutstandingSuppressionObligations(h.shim as never);
    expect(out).toMatchObject({ holdsCleared: 0 });
    expect(await prop()).toEqual({ n: true, r: pointer });
  });

  it("sweeper never auto-clears a hold whose pointer ids are all malformed", async () => {
    await seed();
    await db.query(
      "update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'suppression_incomplete:not-a-uuid,also-bad' where id = $1",
      [propertyId],
    );
    const listed = await db.query("select * from public.fn_list_resolvable_suppression_holds(100)");
    expect(listed.rows.some((r) => r.property_id === propertyId)).toBe(false);
    const out = await retryOutstandingSuppressionObligations(h.shim as never);
    expect(out).toMatchObject({ holdsCleared: 0 });
    expect(await prop()).toEqual({ n: true, r: "suppression_incomplete:not-a-uuid,also-bad" });
  });

  it("permanent failure: DB-side attempt count, exponential backoff, one report per day after 3 attempts", async () => {
    await seed();
    await confirm();
    await ageLedger();
    h.failOptOut.on = true;
    const attempts = async () =>
      (await db.query("select attempt_count, last_reported_at from public.suppression_obligation_attempts where review_id = $1", [reviewId])).rows[0];
    const rewind = (interval: string) =>
      db.query(`update public.suppression_obligation_attempts set last_attempt_at = now() - interval '${interval}' where review_id = $1`, [reviewId]);

    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 1, failed: 1 });
    expect((await attempts()).attempt_count).toBe(1);
    // Backed off: not listed again immediately, nor after 1 minute (needs 2m).
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 0 });
    await rewind("1 minute");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 0 });
    // 2nd attempt after 2m; next needs 10m.
    await rewind("3 minutes");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 1 });
    expect((await attempts()).attempt_count).toBe(2);
    await rewind("9 minutes");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 0 });
    await rewind("11 minutes");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 1 });
    expect((await attempts()).attempt_count).toBe(3);
    // 3rd attempt is the first report; the next needs 1h.
    expect((await attempts()).last_reported_at).not.toBeNull();
    await rewind("59 minutes");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 0 });
    await rewind("61 minutes");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ attempted: 1 });
    // The hold stays visible throughout.
    expect(await prop()).toEqual({ n: true, r: `suppression_incomplete:${reviewId}` });
    // Success finally discharges it.
    h.failOptOut.on = false;
    await rewind("7 hours");
    expect(await retryOutstandingSuppressionObligations(h.shim as never)).toMatchObject({ succeeded: 1 });
    expect(await prop()).toEqual({ n: false, r: null });
  });

  it("report throttle: false for attempts 1-2, true at 3, false again until a day has passed", async () => {
    await seed();
    await confirm();
    const rec = async () =>
      (await db.query("select * from public.fn_record_suppression_attempt_failure($1, $2, $3)", [reviewId, propertyId, orgId])).rows[0];
    expect(await rec()).toEqual({ attempt_count: 1, should_report: false });
    expect(await rec()).toEqual({ attempt_count: 2, should_report: false });
    expect(await rec()).toEqual({ attempt_count: 3, should_report: true });
    expect(await rec()).toEqual({ attempt_count: 4, should_report: false });
    await db.query("update public.suppression_obligation_attempts set last_reported_at = now() - interval '25 hours' where review_id = $1", [reviewId]);
    expect(await rec()).toEqual({ attempt_count: 5, should_report: true });
  });

  it("backoff schedule is 2m, 10m, 1h, 6h, then daily", async () => {
    const r = await db.query(
      "select n, public.fn_suppression_retry_backoff(n)::text b from generate_series(1, 7) n order by n",
    );
    expect(r.rows.map((x) => x.b)).toEqual(["00:02:00", "00:10:00", "01:00:00", "06:00:00", "1 day", "1 day", "1 day"]);
  });

  it("the obligation lister is service-role only", async () => {
    const r = await db.query(
      "select has_function_privilege('authenticated', 'public.fn_list_outstanding_suppression_obligations(integer, integer)', 'execute') a, has_function_privilege('service_role', 'public.fn_list_outstanding_suppression_obligations(integer, integer)', 'execute') s",
    );
    expect(r.rows[0]).toEqual({ a: false, s: true });
  });

  it("rollback restores the prior confirm body (no ledger row) and drops the lister", async () => {
    await db.query(ROLLBACK);
    await seed();
    await confirm();
    expect(await ledgerRows("suppression_incomplete")).toHaveLength(0);
    const g = await db.query(
      "select (select count(*) from pg_proc where proname in ('fn_list_outstanding_suppression_obligations','fn_record_suppression_attempt_failure','fn_list_resolvable_suppression_holds','fn_suppression_retry_backoff'))::int f, to_regclass('public.suppression_obligation_attempts') t",
    );
    expect(g.rows[0]).toEqual({ f: 0, t: null });
  });
});

describe("truly parallel sweeper and human retry (two connections, committed data)", () => {
  const base = new URL(process.env.TEST_SUPABASE_DB_URL!);
  const scratch = `durable_par_${process.pid}_${Date.now().toString(36)}`;
  const withDb = (name: string) => {
    const u = new URL(base.toString());
    u.pathname = `/${name}`;
    return u.toString();
  };
  let admin: Client;
  let a: Client;
  let b: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: base.toString() });
    await admin.connect();
    await admin.query(`create database ${scratch}`);
    const dump = spawnSync("pg_dump", ["-s", "--no-owner", base.toString()], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (dump.status !== 0) throw new Error(dump.stderr);
    // The schema-only clone has benign restore warnings (extensions, publications).
    spawnSync("psql", [withDb(scratch), "-X", "-q"], { input: dump.stdout, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    a = new Client({ connectionString: withDb(scratch) });
    b = new Client({ connectionString: withDb(scratch) });
    await a.connect();
    await b.connect();
    for (const sql of CHAIN) await a.query(sql);
  }, 120_000);
  afterAll(async () => {
    await a?.end().catch(() => undefined);
    await b?.end().catch(() => undefined);
    await admin?.query(`drop database if exists ${scratch} with (force)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("sweeper and human retry race on separate connections: one suppression, one retried_ok, hold cleared", async () => {
    h.suppressed.clear();
    h.failOptOut.on = false;
    const org = randomUUID();
    const user = randomUUID();
    const prop_ = randomUUID();
    const review = randomUUID();
    const contact = randomUUID();
    const msg = randomUUID();
    await a.query("set session_replication_role = replica");
    await a.query("insert into public.organizations (id, name) values ($1, $2)", [org, `Par ${org}`]);
    await a.query("insert into public.memberships (user_id, org_id, role, access_status) values ($1, $2, 'member', 'active')", [user, org]);
    await a.query("insert into public.contacts (id, org_id, first_name, phone_1) values ($1, $2, 'Pat', '+18165550178')", [contact, org]);
    await a.query(
      "insert into public.properties (id, org_id, address, state, homeowner_contact_id) values ($1, $2, '1 Test St', 'MO', $3)",
      [prop_, org, contact],
    );
    await a.query(
      "insert into public.messages (id, org_id, channel, direction, property_id, contact_id, from_address, body) values ($1, $2, 'sms', 'inbound', $3, $4, '+18165550178', 'stop')",
      [msg, org, prop_, contact],
    );
    await a.query(
      `insert into public.ai_disposition_reviews
         (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
       values ($1, $2, $3, $4, $5, 'opted_out', 'said stop', 'pending', false,
         (select decision_context_revision from public.properties where id = $3))`,
      [review, org, prop_, randomUUID(), msg],
    );
    await a.query("reset session_replication_role");
    await a.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    await a.query("select public.fn_confirm_ai_disposition_review($1)", [review]);
    await a.query(
      "update public.lead_events set created_at = now() - interval '5 minutes' where property_id = $1 and event_type = 'suppression_incomplete'",
      [prop_],
    );

    const shimA = makeShim(a, false);
    const shimB = makeShim(b, false);
    const human = async () => {
      const r = await applySuppressionForConfirmedReview(shimB as never, review, user);
      if (r.ok) await recordSuppressionRetriedOk({ propertyId: prop_, reviewId: review, actorId: user });
      await shimB.rpc("fn_clear_suppression_hold_if_resolved", { p_property_id: prop_ });
      return r;
    };
    const [sweep, hum] = await Promise.all([
      h.als.run(shimA, () => retryOutstandingSuppressionObligations(shimA as never)),
      h.als.run(shimB, human),
    ]);
    expect(hum.ok).toBe(true);
    expect(sweep.failed).toBe(0);
    // Exactly one effective suppression for the single idempotency key; the loser of the race may
    // replay the idempotent write but never adds a second one.
    expect([...h.suppressed.entries()].map(([, n]) => n)).toEqual([1]);
    expect([...h.invocations.values()].every((n) => n >= 1 && n <= 2)).toBe(true);
    const ok = await a.query("select count(*)::int n from public.lead_events where property_id = $1 and event_type = 'suppression_retried_ok'", [prop_]);
    expect(ok.rows[0].n).toBe(1);
    const p = await a.query("select needs_human_attention n, last_ai_escalation_reason r from public.properties where id = $1", [prop_]);
    expect(p.rows[0]).toEqual({ n: false, r: null });
  }, 60_000);
});
