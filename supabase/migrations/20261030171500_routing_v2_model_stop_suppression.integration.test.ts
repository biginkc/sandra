import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261030171500: routing v2 PR-I automatic model_stop suppression + audited lift.
 * Local-only (isolated loopback stack); one rolled-back transaction per test.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261030171500_routing_v2_model_stop_suppression.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261030171500_routing_v2_model_stop_suppression.sql"), "utf8"),
);

const db = new Client({ connectionString: url });
const PHONE = "+18165550101";
let orgId: string;
let ownerId: string;
let outsiderId: string;
let propertyId: string;
let contactId: string;
let inboundId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function setFlags(flags: Record<string, unknown>) {
  await db.query(`update public.ai_responder_configs set routing_v2_flags = routing_v2_flags || $2::jsonb where org_id = $1`, [
    orgId,
    JSON.stringify(flags),
  ]);
}

async function newInbound(): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body, from_address)
     values ($1, $2, $3, $4, 'sms', 'inbound', 'stop texting me', $5)`,
    [id, orgId, propertyId, randomUUID(), PHONE],
  );
  return id;
}

beforeEach(async () => {
  await db.query("begin");
  await db.query(MIGRATION);
  orgId = randomUUID();
  ownerId = randomUUID();
  outsiderId = randomUUID();
  propertyId = randomUUID();
  contactId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'model-stop')", [orgId]);
  await db.query("set local session_replication_role = replica");
  for (const id of [ownerId, outsiderId]) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u-${id}@test.local`]);
  }
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, ownerId]);
  await db.query(`insert into public.properties (id, org_id, address, state, status) values ($1, $2, 'Stop St', 'MO', 'prospect')`, [
    propertyId,
    orgId,
  ]);
  await db.query(`insert into public.contacts (id, org_id, first_name, phone_1) values ($1, $2, 'Pat', $3)`, [contactId, orgId, PHONE]);
  await db.query(`insert into public.ai_responder_configs (org_id, system_prompt, active) values ($1, 'x', true)`, [orgId]);
  inboundId = await newInbound();
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint svc");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    await db.query("release savepoint svc");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint svc");
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    throw e;
  }
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
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

const apply = (inbound = inboundId, phone = PHONE) =>
  asService(async () =>
    (
      await db.query(`select public.fn_apply_model_stop_suppression($1, $2, $3, $4, $5, $6::jsonb) as r`, [
        orgId,
        phone,
        inbound,
        propertyId,
        contactId,
        JSON.stringify({ step: "asked_stop", signal: "asked_stop", probability: 0.93 }),
      ])
    ).rows[0].r,
  );
const lift = (userId: string, suppressionId: string) =>
  asUser(userId, async () => (await db.query(`select public.fn_lift_model_stop_suppression($1, 'resume') as r`, [suppressionId])).rows[0].r);

const suppressions = async () =>
  (await db.query(`select id, source, source_detail from public.sms_phone_suppressions where org_id = $1 and phone_e164 = $2`, [orgId, PHONE])).rows;
const events = async () =>
  (await db.query(`select action, existing_source, actor_user_id, suppression_id from public.routing_v2_model_stop_events where org_id = $1 order by created_at, action`, [orgId])).rows;

describe("fn_apply_model_stop_suppression", () => {
  it("flag off (the default) writes nothing", async () => {
    expect(await apply()).toEqual({ status: "flag_off" });
    expect(await suppressions()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("needs questions_live too: model_stop_suppression alone writes nothing", async () => {
    await setFlags({ model_stop_suppression: true });
    expect(await apply()).toEqual({ status: "flag_off" });
    await setFlags({ model_stop_suppression: false, questions_live: true });
    expect(await apply()).toEqual({ status: "flag_off" });
    expect(await suppressions()).toEqual([]);
  });

  it("flag on: one model_stop row + one audit row", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const r = await apply();
    expect(r.status).toBe("suppressed");
    const rows = await suppressions();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("model_stop");
    expect(rows[0].source_detail).toMatchObject({ inboundMessageId: inboundId, propertyId, step: "asked_stop", probability: 0.93 });
    expect(await events()).toEqual([{ action: "suppressed", existing_source: null, actor_user_id: null, suppression_id: rows[0].id }]);
  });

  it("is idempotent on a duplicate webhook (same inbound): one row, one audit row", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const first = await apply();
    const second = await apply();
    const third = await apply();
    expect(second).toMatchObject({ status: "duplicate", prior: "suppressed", suppressionId: first.suppressionId });
    expect(third.status).toBe("duplicate");
    expect(await suppressions()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("never touches an existing carrier STOP row", async () => {
    await db.query(
      `insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source, source_detail, provider)
       values ($1, 'sms', $2, 'sendillo', '{"externalId":"x"}', 'sendillo')`,
      [orgId, PHONE],
    );
    const before = await suppressions();
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const r = await apply();
    expect(r).toMatchObject({ status: "already_suppressed", existingSource: "sendillo", suppressionId: before[0].id });
    expect(await suppressions()).toEqual(before);
    expect((await events())[0]).toMatchObject({ action: "already_suppressed", existing_source: "sendillo" });
  });

  it("refuses non-service callers", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    await expect(
      asUser(ownerId, () =>
        db.query(`select public.fn_apply_model_stop_suppression($1, $2, $3, $4, $5, '{}'::jsonb)`, [orgId, PHONE, inboundId, propertyId, contactId]),
      ),
    ).rejects.toThrow(/permission denied|FORBIDDEN/);
    expect(await suppressions()).toEqual([]);
  });

  it("rejects a bad phone and an inbound from another org", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    await expect(apply(inboundId, "816-555-0101")).rejects.toThrow(/INVALID_REQUEST/);
    await expect(apply(randomUUID())).rejects.toThrow(/NOT_FOUND/);
    expect(await suppressions()).toEqual([]);
  });
});

describe("fn_lift_model_stop_suppression", () => {
  it("lifts a model_stop row and audits who did it", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const { suppressionId } = await apply();
    expect(await lift(ownerId, suppressionId)).toEqual({ status: "lifted", phone: PHONE });
    expect(await suppressions()).toEqual([]);
    const ev = await events();
    expect(ev.map((e) => e.action).sort()).toEqual(["lifted", "suppressed"]);
    expect(ev.find((e) => e.action === "lifted")).toMatchObject({ actor_user_id: ownerId, suppression_id: suppressionId });
    expect(await lift(ownerId, suppressionId)).toEqual({ status: "already_lifted" });
  });

  it("a duplicate webhook after a lift does not re-suppress", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const { suppressionId } = await apply();
    await lift(ownerId, suppressionId);
    expect((await apply()).status).toBe("duplicate");
    expect(await suppressions()).toEqual([]);
  });

  it.each(["sendillo", "telnyx", "ai_responder", "ai_responder_threat", "human_confirmed_hostile", "outreach_dispo"])(
    "refuses to lift a %s row (carrier STOP / DNC / human), audits the refusal",
    async (source) => {
      const id = (
        await db.query(
          `insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source) values ($1, 'sms', $2, $3) returning id`,
          [orgId, PHONE, source],
        )
      ).rows[0].id;
      expect(await lift(ownerId, id)).toEqual({ status: "not_model_stop" });
      expect(await suppressions()).toHaveLength(1);
      expect((await suppressions())[0].source).toBe(source);
      expect(await events()).toEqual([{ action: "lift_refused", existing_source: source, actor_user_id: ownerId, suppression_id: id }]);
    },
  );

  it("a carrier STOP that lands on a model_stop row makes it unliftable", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const { suppressionId } = await apply();
    // Same upsert the carrier STOP path uses (recordSmsPhoneSuppression).
    await db.query(
      `insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source) values ($1, 'sms', $2, 'sendillo')
       on conflict (org_id, channel, phone_e164) do update set source = excluded.source`,
      [orgId, PHONE],
    );
    expect(await lift(ownerId, suppressionId)).toEqual({ status: "not_model_stop" });
    expect(await suppressions()).toHaveLength(1);
  });

  it("refuses an outsider and an anonymous caller", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    const { suppressionId } = await apply();
    await expect(lift(outsiderId, suppressionId)).rejects.toThrow(/FORBIDDEN/);
    await expect(
      (async () => {
        await db.query("savepoint anon");
        await db.query("set local role anon");
        try {
          await db.query(`select public.fn_lift_model_stop_suppression($1)`, [suppressionId]);
        } finally {
          await db.query("rollback to savepoint anon");
          await db.query("reset role");
        }
      })(),
    ).rejects.toThrow(/permission denied/);
    expect(await suppressions()).toHaveLength(1);
  });

  it("unknown id → NOT_FOUND", async () => {
    await expect(lift(ownerId, randomUUID())).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("audit visibility + rollback", () => {
  it("org members can read the audit, outsiders cannot", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    await apply();
    const read = (u: string) => asUser(u, async () => (await db.query(`select action from public.routing_v2_model_stop_events where org_id = $1`, [orgId])).rows);
    expect(await read(ownerId)).toEqual([{ action: "suppressed" }]);
    expect(await read(outsiderId)).toEqual([]);
  });

  it("rollback drops the audit + functions and leaves suppression rows in force", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    await apply();
    await db.query(ROLLBACK);
    expect(await suppressions()).toHaveLength(1);
    const left = (
      await db.query(
        `select (to_regclass('public.routing_v2_model_stop_events') is null) as t,
                not exists (select 1 from pg_proc where proname in ('fn_apply_model_stop_suppression', 'fn_lift_model_stop_suppression')) as f`,
      )
    ).rows[0];
    expect(left).toEqual({ t: true, f: true });
    // Re-apply is clean (idempotent migration).
    await db.query(MIGRATION);
    await db.query(MIGRATION);
  });
});
