import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizePhone } from "@/lib/csv/normalize";
import { canaryBucket, isV2Eligible, parseRoutingV2Flags, v2SliceAllowedForAll } from "@/lib/sms-classification/routing-v2/flags";
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

/** Flags on and the inbound's property in the canary list. */
const enable = (extra: Record<string, unknown> = {}) =>
  setFlags({ questions_live: true, model_stop_suppression: true, canary_property_ids: [propertyId], ...extra });

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
  await db.query(`insert into public.ai_responder_configs (org_id, system_prompt, active) values ($1, 'x', true)`, [orgId]);
  inboundId = await newInbound();
  await db.query("set local session_replication_role = origin");
  // Triggers on: contact_phone_numbers_sync_insert fills the phone index, as in prod.
  await db.query(`insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Pat', $3, 'mobile')`, [contactId, orgId, PHONE]);
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
    await enable();
    const r = await apply();
    expect(r.status).toBe("suppressed");
    const rows = await suppressions();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("model_stop");
    expect(rows[0].source_detail).toMatchObject({ inboundMessageId: inboundId, propertyId, step: "asked_stop", probability: 0.93 });
    expect(await events()).toEqual([{ action: "suppressed", existing_source: null, actor_user_id: null, suppression_id: rows[0].id }]);
  });

  it("is idempotent on a duplicate webhook (same inbound): one row, one audit row", async () => {
    await enable();
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
    await enable();
    const r = await apply();
    expect(r).toMatchObject({ status: "already_suppressed", existingSource: "sendillo", suppressionId: before[0].id });
    expect(await suppressions()).toEqual(before);
    expect((await events())[0]).toMatchObject({ action: "already_suppressed", existing_source: "sendillo" });
  });

  it("refuses non-service callers", async () => {
    await enable();
    await expect(
      asUser(ownerId, () =>
        db.query(`select public.fn_apply_model_stop_suppression($1, $2, $3, $4, $5, '{}'::jsonb)`, [orgId, PHONE, inboundId, propertyId, contactId]),
      ),
    ).rejects.toThrow(/permission denied|FORBIDDEN/);
    expect(await suppressions()).toEqual([]);
  });

  it("rejects a bad phone and an inbound from another org", async () => {
    await enable();
    await expect(apply(inboundId, "816-555-0101")).rejects.toThrow(/INVALID_REQUEST/);
    await expect(apply(randomUUID())).rejects.toThrow(/NOT_FOUND/);
    expect(await suppressions()).toEqual([]);
  });
});

describe("fn_lift_model_stop_suppression", () => {
  it("lifts a model_stop row and audits who did it", async () => {
    await enable();
    const { suppressionId } = await apply();
    expect(await lift(ownerId, suppressionId)).toEqual({ status: "lifted", phone: PHONE });
    expect(await suppressions()).toEqual([]);
    const ev = await events();
    expect(ev.map((e) => e.action).sort()).toEqual(["lifted", "suppressed"]);
    expect(ev.find((e) => e.action === "lifted")).toMatchObject({ actor_user_id: ownerId, suppression_id: suppressionId });
    expect(await lift(ownerId, suppressionId)).toEqual({ status: "already_lifted" });
  });

  it("a duplicate webhook after a lift does not re-suppress", async () => {
    await enable();
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
    await enable();
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
    await enable();
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

/** contacts.phone_1 is unique, so a phone maps to one contact; PHONE belongs to `contactId`. */
async function contactFor(phone: string, slot: 1 | 2 | 3 = 1, legacy = false): Promise<string> {
  if (phone === PHONE) return contactId;
  const id = randomUUID();
  // Triggers on (prod contract): contact_phone_numbers_sync_insert indexes the phone.
  // legacy = replica role, triggers skipped: a row the index never saw.
  if (legacy) await db.query("set local session_replication_role = replica");
  await db.query(`insert into public.contacts (id, org_id, first_name, phone_${slot}, phone_${slot}_type) values ($1, $2, 'Other', $3, 'mobile')`, [id, orgId, phone]);
  if (legacy) await db.query("set local session_replication_role = origin");
  return id;
}

async function addProperty(
  opts: { homeownerPhone?: string; linkPhone?: string; deleted?: boolean; slot?: 1 | 2 | 3; legacy?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const homeowner = opts.homeownerPhone ? await contactFor(opts.homeownerPhone, opts.slot, opts.legacy) : null;
  const linked = opts.linkPhone ? await contactFor(opts.linkPhone, opts.slot, opts.legacy) : null;
  await db.query("set local session_replication_role = replica");
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, homeowner_contact_id, deleted_at)
     values ($1, $2, 'Other St', 'MO', 'prospect', $3, $4)`,
    [id, orgId, homeowner, opts.deleted ? new Date().toISOString() : null],
  );
  if (linked) {
    await db.query(
      `insert into public.property_contacts (property_id, contact_id, org_id, source_identity, source_position) values ($1, $2, $3, 'x', 1)`,
      [id, linked, orgId],
    );
  }
  await db.query("set local session_replication_role = origin");
  return id;
}

const phoneSet = async (phone = PHONE): Promise<string[] | null> =>
  (await db.query(`select public.fn_model_stop_phone_property_ids($1, $2, $3) as ids`, [orgId, phone, propertyId])).rows[0].ids;

describe("phone set comes from the contact_phone_numbers index (sync-trigger contract)", () => {
  it("the insert trigger indexes formatted phones with the same normalizer", async () => {
    const id = await contactFor("(816) 555-0101", 2);
    const rows = (await db.query(`select slot, e164, digits10 from public.contact_phone_numbers where contact_id = $1`, [id])).rows;
    expect(rows).toEqual([{ slot: 2, e164: PHONE, digits10: "8165550101" }]);
    const viaTs = normalizePhone("(816) 555-0101");
    const viaSql = (await db.query(`select public.dialpad_cti_normalize_us_phone($1) as v`, ["(816) 555-0101"])).rows[0].v;
    expect([viaTs, viaSql]).toEqual([PHONE, PHONE]);
  });

  it("normalizer parity: TS normalizePhone = dialpad_cti_normalize_us_phone for every tested format", async () => {
    const formats = [
      "(816) 555-0101", "816.555.0101", "816-555-0101", "8165550101", "18165550101", "+1 816 555 0101", "1 (816) 555-0101",
      "+18165550101 ", "816-555-0101 x2", "+44 816 555 0101", "0018165550101", "555-0101", "", "call me",
    ];
    for (const f of formats) {
      const sql = (await db.query(`select public.dialpad_cti_normalize_us_phone($1) as v`, [f])).rows[0].v;
      expect({ f, v: sql }).toEqual({ f, v: normalizePhone(f) });
    }
  });

  it.each([
    ["(816) 555-0101", 1],
    ["816.555.0101", 2],
    ["816-555-0101", 3],
    ["8165550101", 1],
    ["18165550101", 2],
    ["+1 816 555 0101", 3],
    ["1 (816) 555-0101", 1],
  ] as const)("inserted homeowner phone %s (slot %i) is found through the index, and an ineligible one blocks the write", async (raw, slot) => {
    const other = await addProperty({ homeownerPhone: raw, slot });
    expect(new Set(await phoneSet())).toEqual(new Set([propertyId, other]));
    await enable();
    expect(await apply()).toEqual({ status: "not_eligible" });
    expect(await suppressions()).toEqual([]);
  });

  it.each([
    ["(816) 555-0101", 1],
    ["816.555.0101", 2],
    ["+18165550101 ", 3],
  ] as const)("property_contacts-linked phone %s (slot %i) is found, and an ineligible one blocks the write", async (raw, slot) => {
    const linked = await addProperty({ linkPhone: raw, slot });
    expect(new Set(await phoneSet())).toEqual(new Set([propertyId, linked]));
    await enable();
    expect(await apply()).toEqual({ status: "not_eligible" });
    await enable({ canary_property_ids: [propertyId, linked] });
    expect((await apply()).status).toBe("suppressed");
  });

  it("the update trigger: a contact changed to a formatted copy of the phone joins the set; changed away, it leaves", async () => {
    const other = await addProperty({ homeownerPhone: "+18165550199" });
    expect(await phoneSet()).toEqual([propertyId]);
    const cid = (await db.query(`select homeowner_contact_id as c from public.properties where id = $1`, [other])).rows[0].c;
    await db.query(`update public.contacts set phone_2 = '816.555.0101', phone_2_type = 'mobile' where id = $1`, [cid]);
    expect(new Set(await phoneSet())).toEqual(new Set([propertyId, other]));
    await db.query(`update public.contacts set phone_2 = null where id = $1`, [cid]);
    expect(await phoneSet()).toEqual([propertyId]);
  });

  it("a different number that only shares digits is not in the set", async () => {
    await addProperty({ homeownerPhone: "(816) 555-0102" });
    expect(await phoneSet()).toEqual([propertyId]);
  });

  it.each(["816-555-0101 x2", "ext 12 816 555 0101", "0018165550101", "+44 816 555 0101", "8165550101 / 8165550102"])(
    "an un-normalizable slot carrying this phone's digits (%s) fails closed (anomaly index)",
    async (raw) => {
      await addProperty({ homeownerPhone: raw, slot: 2 });
      expect(await phoneSet()).toBeNull();
      await setFlags({ questions_live: true, model_stop_suppression: true, canary_percent: 100 });
      expect(await apply()).toEqual({ status: "not_eligible" });
      expect(await suppressions()).toEqual([]);
    },
  );

  it("un-normalizable slots with unrelated digits, or under 10 digits, do not block", async () => {
    await addProperty({ homeownerPhone: "call me maybe 12" });
    await addProperty({ homeownerPhone: "555-0101" });
    await addProperty({ homeownerPhone: "816-555-0199 x2" });
    expect(await phoneSet()).toEqual([propertyId]);
  });

  it("the anomaly trigger follows updates: fixing the slot clears the block, breaking it again restores it", async () => {
    const other = await addProperty({ homeownerPhone: "816-555-0101 x2", slot: 3 });
    expect(await phoneSet()).toBeNull();
    const cid = (await db.query(`select homeowner_contact_id as c from public.properties where id = $1`, [other])).rows[0].c;
    await db.query(`update public.contacts set phone_3 = '(816) 555-0101', phone_3_type = 'mobile' where id = $1`, [cid]);
    expect(new Set(await phoneSet())).toEqual(new Set([propertyId, other]));
    await db.query(`update public.contacts set phone_3 = '816 555 0101 ext 9' where id = $1`, [cid]);
    expect(await phoneSet()).toBeNull();
    await db.query(`update public.contacts set phone_3 = null where id = $1`, [cid]);
    expect(await phoneSet()).toEqual([propertyId]);
  });

  it("the anomaly trigger follows an org_id move", async () => {
    // Any un-normalizable slot with these digits in the org blocks, linked to a property or not.
    const cid = await contactFor("816-555-0101 x2");
    expect(await phoneSet()).toBeNull();
    const otherOrg = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, 'moved')", [otherOrg]);
    await db.query(`update public.contacts set org_id = $2 where id = $1`, [cid, otherOrg]);
    expect(await phoneSet()).toEqual([propertyId]);
    const moved = (await db.query(`select count(*)::int n from public.routing_v2_contact_phone_anomalies where org_id = $1`, [otherOrg])).rows[0].n;
    expect(moved).toBeGreaterThan(0);
  });

  it("the migration backfill finds legacy un-normalizable slots the trigger never saw", async () => {
    await addProperty({ homeownerPhone: "816-555-0101 x2", legacy: true });
    expect(await phoneSet()).toEqual([propertyId]);
    await db.query(MIGRATION);
    expect(await phoneSet()).toBeNull();
  });

  it("a contact the triggers never saw is not found (the cutover depends on the sync triggers)", async () => {
    await addProperty({ homeownerPhone: "(816) 555-0101", legacy: true });
    expect(await phoneSet()).toEqual([propertyId]);
  });

  it.each(["+448165550101", "+1816555010", "8165550101"])("a phone that is not a normalized US E.164 number (%s) fails closed", async (phone) => {
    expect(await phoneSet(phone)).toBeNull();
  });
});

describe("execution-time guard", () => {
  it("a phone-lock wait past lock_timeout returns not_eligible and writes nothing", async () => {
    await enable();
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      await other.query(`select pg_advisory_lock(hashtext($1))`, [`model_stop_phone:${orgId}:${PHONE}`]);
      const started = Date.now();
      expect(await apply()).toEqual({ status: "not_eligible", reason: "lock_timeout" });
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await other.query(`select pg_advisory_unlock_all()`);
      await other.end();
    }
    expect(await suppressions()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("over the time budget returns not_eligible and writes nothing", async () => {
    await enable();
    await db.query(`select set_config('sandra.model_stop_budget_ms', '0', true)`);
    expect(await apply()).toEqual({ status: "not_eligible", reason: "time_budget" });
    await db.query(`select set_config('sandra.model_stop_budget_ms', '', true)`);
    expect(await suppressions()).toEqual([]);
    expect((await apply()).status).toBe("suppressed");
  });
});

describe("write-time canary eligibility (§13.1/§13.2)", () => {
  it("not in the canary (no ids, percent 0) → not_eligible, nothing written", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true });
    expect(await apply()).toEqual({ status: "not_eligible" });
    expect(await suppressions()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("canary_percent 100 makes every property eligible", async () => {
    await setFlags({ questions_live: true, model_stop_suppression: true, canary_percent: 100 });
    expect((await apply()).status).toBe("suppressed");
  });

  it("eligibility flips off between the decision and the write → nothing written; flips back → written once", async () => {
    await enable();
    // The decision was taken while eligible; the property is removed from the canary before the write.
    await setFlags({ canary_property_ids: [] });
    expect(await apply()).toEqual({ status: "not_eligible" });
    expect(await suppressions()).toEqual([]);
    // not_eligible records nothing, so a later eligible redelivery can still act once.
    await enable();
    expect((await apply()).status).toBe("suppressed");
    expect((await apply()).status).toBe("duplicate");
    expect(await suppressions()).toHaveLength(1);
  });

  it("multi-property phone: one ineligible property (homeowner) → nothing written", async () => {
    const other = await addProperty({ homeownerPhone: PHONE });
    await enable();
    expect(await apply()).toEqual({ status: "not_eligible" });
    expect(await suppressions()).toEqual([]);
    await enable({ canary_property_ids: [propertyId, other] });
    expect((await apply()).status).toBe("suppressed");
  });

  it("multi-property phone: one ineligible property linked through property_contacts → nothing written", async () => {
    await addProperty({ linkPhone: PHONE });
    await enable();
    expect(await apply()).toEqual({ status: "not_eligible" });
  });

  it("the phone set: own property, homeowner and linked properties; not deleted ones or other phones", async () => {
    const home = await addProperty({ homeownerPhone: PHONE });
    const linked = await addProperty({ linkPhone: PHONE });
    await addProperty({ homeownerPhone: PHONE, deleted: true });
    await addProperty({ homeownerPhone: "+18165550199" });
    // The base property's homeowner contact is not set, but it is the inbound's own property.
    const ids = await phoneSet();
    expect(new Set(ids)).toEqual(new Set([propertyId, home, linked]));
    // A deleted property never blocks; an ineligible live one does.
    await enable({ canary_property_ids: [propertyId, home, linked] });
    expect((await apply()).status).toBe("suppressed");
  });

  it.each([
    ["non-UUID entry", { canary_property_ids: ["PROP", "nope"], canary_percent: 100 }],
    ["ids not an array", { canary_property_ids: "PROP", canary_percent: 100 }],
    ["ids null", { canary_property_ids: null, canary_percent: 100 }],
    ["number entry", { canary_property_ids: [1], canary_percent: 100 }],
    ["percent 101", { canary_property_ids: ["PROP"], canary_percent: 101 }],
    ["percent -1", { canary_property_ids: ["PROP"], canary_percent: -1 }],
    ["percent 50.5", { canary_property_ids: ["PROP"], canary_percent: 50.5 }],
    ["percent string", { canary_property_ids: ["PROP"], canary_percent: "100" }],
    ["percent null", { canary_property_ids: ["PROP"], canary_percent: null }],
  ])("malformed canary config (%s) fails closed", async (_n, extra) => {
    const fix = (v: unknown): unknown => (v === "PROP" ? propertyId : Array.isArray(v) ? v.map(fix) : v);
    const cfg = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, fix(v)]));
    await setFlags({ questions_live: true, model_stop_suppression: true, ...cfg });
    expect(await apply()).toEqual({ status: "not_eligible" });
    expect(await suppressions()).toEqual([]);
  });

  it("two active configs read as off (flags.ts maybeSingle parity)", async () => {
    await enable();
    await db.query("savepoint cfg");
    try {
      await db.query(`insert into public.ai_responder_configs (org_id, system_prompt, active, routing_v2_flags) select org_id, 'y', true, routing_v2_flags from public.ai_responder_configs where org_id = $1`, [orgId]);
    } catch {
      // A unique index on one active config per org is an equally safe outcome.
      await db.query("rollback to savepoint cfg");
      return;
    }
    expect(await apply()).toEqual({ status: "flag_off" });
  });
});

describe("TS ↔ SQL eligibility parity (flags.ts vs fn_routing_v2_property_eligible)", () => {
  const ids = Array.from({ length: 300 }, () => randomUUID());
  ids.push("00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff");

  it("canary buckets are identical", async () => {
    const rows = (await db.query(`select x::text as id, public.fn_routing_v2_canary_bucket(x) as b from unnest($1::uuid[]) x`, [ids])).rows;
    for (const r of rows) expect([r.id, r.b]).toEqual([r.id, canaryBucket(r.id)]);
  });

  it("property eligibility is identical across valid and malformed configs", async () => {
    const listed = ids.slice(0, 5);
    const configs: unknown[] = [
      {},
      { canary_percent: 0 },
      { canary_percent: 1 },
      { canary_percent: 10 },
      { canary_percent: 50 },
      { canary_percent: 99 },
      { canary_percent: 100 },
      { canary_percent: 50.0 },
      { canary_percent: 50.5 },
      { canary_percent: -1 },
      { canary_percent: 101 },
      { canary_percent: "50" },
      { canary_percent: null },
      { canary_percent: true },
      { canary_property_ids: listed },
      { canary_property_ids: listed.map((s) => s.toUpperCase()), canary_percent: 10 },
      { canary_property_ids: [...listed, "bad"], canary_percent: 100 },
      { canary_property_ids: "x", canary_percent: 100 },
      { canary_property_ids: null },
      { canary_property_ids: [], canary_percent: 30 },
      { canary_property_ids: [{ id: listed[0] }] },
      "not-an-object",
      [],
    ];
    let compared = 0;
    for (const cfg of configs) {
      const ts = parseRoutingV2Flags(cfg);
      const rows = (
        await db.query(`select x::text as id, public.fn_routing_v2_property_eligible($2::jsonb, x) as e from unnest($1::uuid[]) x`, [
          ids,
          JSON.stringify(cfg),
        ])
      ).rows;
      for (const r of rows) {
        expect({ cfg, id: r.id, e: r.e }).toEqual({ cfg, id: r.id, e: isV2Eligible(ts, r.id) });
        compared++;
      }
    }
    expect(compared).toBe(configs.length * ids.length);
  });

  it("phone-wide answer matches v2SliceAllowedForAll", async () => {
    const other = await addProperty({ homeownerPhone: PHONE });
    for (const cfg of [
      { canary_property_ids: [propertyId] },
      { canary_property_ids: [propertyId, other] },
      { canary_percent: 100 },
      { canary_percent: 0 },
      { canary_property_ids: [propertyId, other, "bad"] },
    ]) {
      const flags = { questions_live: true, model_stop_suppression: true, ...cfg };
      await setFlags({ canary_property_ids: [], canary_percent: 0 });
      await db.query(`update public.ai_responder_configs set routing_v2_flags = $2::jsonb where org_id = $1`, [orgId, JSON.stringify(flags)]);
      const expected = v2SliceAllowedForAll(parseRoutingV2Flags(flags), "model_stop_suppression", [propertyId, other]);
      await db.query("savepoint parity");
      const r = await apply();
      await db.query("rollback to savepoint parity");
      expect({ cfg, status: r.status }).toEqual({ cfg, status: expected ? "suppressed" : "not_eligible" });
    }
  });
});

describe("lock order: lift vs a concurrent carrier STOP (committed data, two sessions)", () => {
  // Needs committed rows visible to two sessions, so this suite commits its own fixture
  // and deletes it afterwards.
  const ORG = randomUUID();
  const OWNER = randomUUID();
  const CPHONE = "+18165550177";
  let a: Client;
  let b: Client;
  const carrierUpsert = (c: Client) =>
    c.query(
      `insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source, provider)
       values ($1, 'sms', $2, 'sendillo', 'sendillo')
       on conflict (org_id, channel, phone_e164) do update set source = excluded.source, updated_at = now()`,
      [ORG, CPHONE],
    );
  const liftAs = async (c: Client, id: string) => {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER]);
    await c.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
    const r = (await c.query(`select public.fn_lift_model_stop_suppression($1) as r`, [id])).rows[0].r;
    await c.query("reset role");
    return r;
  };
  const seedModelStop = async (): Promise<string> =>
    (
      await a.query(
        `insert into public.sms_phone_suppressions (org_id, channel, phone_e164, source, provider)
         values ($1, 'sms', $2, 'model_stop', 'routing_v2')
         on conflict (org_id, channel, phone_e164) do update set source = 'model_stop' returning id`,
        [ORG, CPHONE],
      )
    ).rows[0].id;
  const finalRows = async () =>
    (await a.query(`select source from public.sms_phone_suppressions where org_id = $1 and phone_e164 = $2`, [ORG, CPHONE])).rows;

  // The shared `db` client re-applies the migration in an open transaction before every
  // test (holding DDL locks); release it for these committed two-session tests.
  beforeEach(async () => {
    await db.query("rollback");
  });
  afterEach(async () => {
    await db.query("begin");
  });

  beforeAll(async () => {
    a = new Client({ connectionString: url });
    b = new Client({ connectionString: url });
    await a.connect();
    await b.connect();
    await a.query("insert into public.organizations (id, name) values ($1, $2)", [ORG, `lock-order-${ORG}`]);
    await a.query(`insert into auth.users (id, email) values ($1, $2)`, [OWNER, `u-${OWNER}@test.local`]);
    await a.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [ORG, OWNER]);
  });
  afterAll(async () => {
    await a.query("set session_replication_role = replica");
    await a.query(`delete from public.routing_v2_model_stop_events where org_id = $1`, [ORG]);
    await a.query(`delete from public.sms_phone_suppressions where org_id = $1`, [ORG]);
    await a.query(`delete from public.memberships where org_id = $1`, [ORG]);
    await a.query(`delete from auth.users where id = $1`, [OWNER]);
    await a.query(`delete from public.organizations where id = $1`, [ORG]);
    await a.query("set session_replication_role = origin");
    await a.end();
    await b.end();
  });

  it("carrier STOP first, lift waits, then refuses: no deadlock, carrier row stays", async () => {
    const id = await seedModelStop();
    await b.query("begin");
    await carrierUpsert(b);
    await a.query("begin");
    const lift = liftAs(a, id);
    await new Promise((r) => setTimeout(r, 300));
    await b.query("commit");
    expect(await lift).toEqual({ status: "not_model_stop" });
    await a.query("commit");
    expect(await finalRows()).toEqual([{ source: "sendillo" }]);
  });

  it("lift first, carrier STOP waits and never aborts: no deadlock, carrier row present", async () => {
    const id = await seedModelStop();
    await a.query("begin");
    expect(await liftAs(a, id)).toMatchObject({ status: "lifted" });
    await b.query("begin");
    const carrier = carrierUpsert(b);
    await new Promise((r) => setTimeout(r, 300));
    await a.query("commit");
    await carrier;
    await b.query("commit");
    expect(await finalRows()).toEqual([{ source: "sendillo" }]);
  });

  it("truly concurrent lift + carrier STOP, 20 rounds: never a deadlock, the carrier row always present", async () => {
    for (let i = 0; i < 20; i++) {
      const id = await seedModelStop();
      const runLift = (async () => {
        await a.query("begin");
        try {
          const r = await liftAs(a, id);
          await a.query("commit");
          return r;
        } catch (e) {
          await a.query("rollback");
          throw e;
        }
      })();
      const runCarrier = (async () => {
        await b.query("begin");
        await carrierUpsert(b);
        await b.query("commit");
      })();
      const [lr] = await Promise.all([runLift, runCarrier]);
      expect(["lifted", "not_model_stop"]).toContain((lr as { status: string }).status);
      expect(await finalRows()).toEqual([{ source: "sendillo" }]);
    }
  });
});

describe("audit visibility + rollback", () => {
  it("org members can read the audit, outsiders cannot", async () => {
    await enable();
    await apply();
    const read = (u: string) => asUser(u, async () => (await db.query(`select action from public.routing_v2_model_stop_events where org_id = $1`, [orgId])).rows);
    expect(await read(ownerId)).toEqual([{ action: "suppressed" }]);
    expect(await read(outsiderId)).toEqual([]);
  });

  it("rollback drops the audit + functions and leaves suppression rows in force", async () => {
    await enable();
    await apply();
    await db.query(ROLLBACK);
    expect(await suppressions()).toHaveLength(1);
    const left = (
      await db.query(
        `select (to_regclass('public.routing_v2_model_stop_events') is null and to_regclass('public.routing_v2_contact_phone_anomalies') is null) as t,
                not exists (select 1 from pg_proc where proname in ('fn_apply_model_stop_suppression', 'fn_lift_model_stop_suppression')) as f`,
      )
    ).rows[0];
    expect(left).toEqual({ t: true, f: true });
    // Re-apply is clean (idempotent migration).
    await db.query(MIGRATION);
    await db.query(MIGRATION);
  });
});
