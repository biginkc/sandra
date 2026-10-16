import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 dead letter + lease renewal (20261008143400). Local-only.
 * Two parts:
 *  1. Replays the 20261008140000..20261008143400 chain inside a rolled-back
 *     transaction: dead-letter table + RLS, fn_renew_ai_send, the regex RPC
 *     guard assertion (a comment must not satisfy it), policy comments.
 *  2. A two-connection concurrency suite against a committed scratch schema
 *     that holds ONLY the reservation table + functions extracted from the
 *     migration SQL (parallel reserve: exactly one winner; slow holder expiry;
 *     renew keeps a slow holder alive).
 */
const dir = __dirname;
const files = readdirSync(dir)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008143400_zz")
  .sort();
const CHAIN = files.map((f) =>
  readFileSync(path.join(dir, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
);
const url = process.env.TEST_SUPABASE_DB_URL;

const db = new Client({ connectionString: url });
let orgId: string;
let decisionId: string;
const users = {} as Record<"owner" | "acq" | "plain", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member", acq = false) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [orgId, id, role, acq],
  );
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
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

describe("chain replay", () => {
  beforeEach(async () => {
    await db.query("begin");
    for (const sql of CHAIN) await db.query(sql);
    orgId = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `DeadLetter ${orgId}`]);
    await db.query("set local session_replication_role = replica");
    await addMember("owner", "owner");
    await addMember("acq", "member", true);
    await addMember("plain", "member");
    decisionId = randomUUID();
    await db.query(
      `insert into public.jev_lead_decisions
         (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome)
       values ($1, $2, $3, $4, $5, $6, 'new_lead')`,
      [decisionId, orgId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
    await db.query("set local session_replication_role = origin");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  describe("ai_reply_dead_letters", () => {
    const count = async () => (await db.query("select id from public.ai_reply_dead_letters")).rows.length;

    it("owner and acquisitions read; a plain member does not", async () => {
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.ai_reply_dead_letters (org_id, inbound_message_id, body, reason) values ($1, $2, 'text', 'send_reserved_elsewhere')`,
        [orgId, randomUUID()],
      );
      await db.query("set local session_replication_role = origin");
      expect(await asUser(users.owner, count)).toBe(1);
      expect(await asUser(users.acq, count)).toBe(1);
      expect(await asUser(users.plain, count)).toBe(0);
    });

    it("authenticated members cannot insert; the service role can", async () => {
      await db.query("set local session_replication_role = replica");
      const insert = () =>
        db.query(
          `insert into public.ai_reply_dead_letters (org_id, inbound_message_id, body, reason) values ($1, $2, 'text', 'draft_persist_failed')`,
          [orgId, randomUUID()],
        );
      await db.query("savepoint a");
      await db.query("set local role authenticated");
      await expect(insert()).rejects.toThrow(/permission denied/);
      await db.query("rollback to savepoint a");
      await db.query("reset role");
      await db.query("set local role service_role");
      await insert();
      await db.query("reset role");
      expect(await count()).toBe(1);
    });
  });

  describe("fn_renew_ai_send", () => {
    const conv = () => randomUUID();
    const reserve = async (c: string, holder: string) =>
      (await db.query("select public.fn_reserve_ai_send($1, null, $2, 60) as ok", [c, holder])).rows[0].ok as boolean;
    const renew = async (c: string, holder: string, secs = 90) =>
      (await db.query("select public.fn_renew_ai_send($1, $2, $3) as ok", [c, holder, secs])).rows[0].ok as boolean;

    it("renews only for the live holder and extends the expiry", async () => {
      const c = conv();
      await reserve(c, "a");
      expect(await renew(c, "b")).toBe(false);
      expect(await renew(c, "a", 600)).toBe(true);
      const { rows } = await db.query(
        "select expires_at > clock_timestamp() + interval '300 seconds' as long from public.ai_send_reservations where conversation_id = $1",
        [c],
      );
      expect(rows[0].long).toBe(true);
    });

    it("cannot renew an expired lease (the holder lost it)", async () => {
      const c = conv();
      await reserve(c, "a");
      await db.query(
        "update public.ai_send_reservations set expires_at = clock_timestamp() - interval '1 second' where conversation_id = $1",
        [c],
      );
      expect(await renew(c, "a")).toBe(false);
      expect(await reserve(c, "b")).toBe(true);
      expect(await renew(c, "a")).toBe(false);
    });

    it("is service-role only", async () => {
      await db.query("savepoint x");
      await expect(
        asUser(users.owner, () => db.query("select public.fn_renew_ai_send($1, 'a', 30)", [randomUUID()])),
      ).rejects.toThrow(/permission denied/);
      await db.query("rollback to savepoint x");
    });
  });

  describe("RPC guard assertion is a regex over comment-stripped source", () => {
    const last = CHAIN[CHAIN.length - 1];

    it("a guard that only appears in a comment fails the assertion", async () => {
      await db.query("savepoint s");
      await db.query(
        `create or replace function public.fn_confirm_jev_lead_decision(p_decision_id uuid) returns jsonb language plpgsql as $f$
         begin
           -- TODO call pipeline_runs_can_read(org) here
           return null;
         end $f$`,
      );
      await expect(db.query(last)).rejects.toThrow(/missing a pipeline_runs_can_read\( call/);
      await db.query("rollback to savepoint s");
    });

    it("a superseded function without a real call fails the assertion", async () => {
      await db.query("savepoint s");
      await db.query(
        `create or replace function public.fn_begin_jev_lead_decision_correction(p uuid) returns void language sql as 'select 1'`,
      );
      await expect(db.query(last)).rejects.toThrow(/without a pipeline_runs_can_read\( call/);
      await db.query("rollback to savepoint s");
    });

    it("the real functions pass (the whole chain applied)", async () => {
      const { rows } = await db.query(
        "select pg_get_functiondef('public.fn_confirm_jev_lead_decision(uuid)'::regprocedure) ~ 'pipeline_runs_can_read\\s*\\(' as ok",
      );
      expect(rows[0].ok).toBe(true);
    });
  });

  it("states the per-row vs once-per-statement truth in the policy comments", async () => {
    const { rows } = await db.query(
      `select obj_description(p.oid, 'pg_policy') as c
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname = 'ai_reply_drafts' and p.polname = 'ai_reply_drafts_org_select'`,
    );
    expect(rows[0].c).toMatch(/per row/);
    expect(rows[0].c).toMatch(/once-per-statement/);
  });
});

describe("send reservation concurrency (two real connections, committed scratch schema)", () => {
  const schema = `conc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Client({ connectionString: url });
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });

  const slice = (source: string, re: RegExp) => {
    const m = source.match(re);
    if (!m) throw new Error(`could not extract ${re}`);
    return m[0].replaceAll("public.", `${schema}.`);
  };

  beforeAll(async () => {
    const s300 = readFileSync(path.join(dir, "20261008143300_messages_v2_send_reservation.sql"), "utf8");
    const s400 = readFileSync(path.join(dir, "20261008143400_messages_v2_dead_letter.sql"), "utf8");
    await Promise.all([admin.connect(), a.connect(), b.connect()]);
    await admin.query(`create schema ${schema}`);
    await admin.query(slice(s300, /create table if not exists public\.ai_send_reservations \([\s\S]*?\n\);/));
    await admin.query(slice(s300, /create or replace function public\.fn_reserve_ai_send[\s\S]*?\n\$\$;/));
    await admin.query(slice(s400, /create or replace function public\.fn_renew_ai_send[\s\S]*?\n\$\$;/));
  });
  afterAll(async () => {
    await admin.query(`drop schema if exists ${schema} cascade`);
    await Promise.all([admin.end(), a.end(), b.end()]);
  });

  const reserve = (c: Client, conv: string, holder: string, secs = 60) =>
    c.query(`select ${schema}.fn_reserve_ai_send($1, null, $2, $3) as ok`, [conv, holder, secs]).then((r) => r.rows[0].ok as boolean);

  it("parallel reservations for one conversation from two connections: exactly one wins", async () => {
    for (let round = 0; round < 25; round += 1) {
      const conv = randomUUID();
      const results = await Promise.all([
        reserve(a, conv, "a1"),
        reserve(b, conv, "b1"),
        reserve(a, conv, "a2"),
        reserve(b, conv, "b2"),
      ]);
      // a1/a2 share a connection so they serialise there; across the pair of
      // connections still exactly one row can hold the lease.
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  it("a slow holder is displaced after expiry and can no longer renew", async () => {
    const conv = randomUUID();
    expect(await reserve(a, conv, "slow", 1)).toBe(true);
    expect(await reserve(b, conv, "fast")).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await reserve(b, conv, "fast")).toBe(true);
    const renewed = await a.query(`select ${schema}.fn_renew_ai_send($1, 'slow', 60) as ok`, [conv]);
    expect(renewed.rows[0].ok).toBe(false);
  });

  it("renewing keeps a slow holder alive past its original lease", async () => {
    const conv = randomUUID();
    expect(await reserve(a, conv, "slow", 1)).toBe(true);
    const renewed = await a.query(`select ${schema}.fn_renew_ai_send($1, 'slow', 60) as ok`, [conv]);
    expect(renewed.rows[0].ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await reserve(b, conv, "fast")).toBe(false);
  });
});
