import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Luna suggestions (20261008250000). Local-only: replays the
 * 20261008140000..20261008250000 chain inside a rolled-back transaction and
 * checks constraints, the update guard, RLS / grants, and fn_luna_suggestion_stats.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008250000_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

let orgId: string;
let otherOrgId: string;
let ownerId: string;
let acqId: string;
let plainId: string;
let outsiderId: string;

beforeAll(async () => {
  await db.connect();
  // Replay the chain once in a transaction that is never committed; each test
  // runs inside a savepoint that is rolled back.
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [
    orgId, `Luna ${orgId}`, otherOrgId, `Other ${otherOrgId}`,
  ]);
  // Fixture-only: bypass the protected acquisitions_enabled designation trigger.
  await db.query("set local session_replication_role = replica");
  ownerId = await addUser(orgId, "owner");
  acqId = await addUser(orgId, "member", true);
  plainId = await addUser(orgId, "member");
  outsiderId = await addUser(otherOrgId, "owner");
  await db.query("set local session_replication_role = origin");
}, 180_000);
afterAll(async () => {
  await db.query("rollback");
  await db.end();
});

async function addUser(org: string, role: "owner" | "member", acq = false): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [org, id, role, acq],
  );
  return id;
}

beforeEach(async () => {
  await db.query("savepoint test_case");
});
afterEach(async () => {
  await db.query("rollback to savepoint test_case");
});

async function property(org = orgId): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state) values ($1, $2, '1 Test St', 'MO')`,
    [id, org],
  );
  return id;
}
async function inbound(org = orgId): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, 'sms', 'inbound', 'hi')`,
    [id, org, randomUUID()],
  );
  return id;
}

type Seed = {
  outcome?: string;
  confidence?: number;
  ageDays?: number;
  org?: string;
  state?: "open" | "accepted" | "rejected" | "agreed";
};
async function suggest(s: Seed = {}): Promise<{ id: string; propertyId: string; messageId: string }> {
  const org = s.org ?? orgId;
  const propertyId = await property(org);
  const messageId = await inbound(org);
  const outcome = s.outcome ?? "nurture";
  const state = s.state ?? "open";
  const id = randomUUID();
  await db.query(
    `insert into public.luna_suggestions (id, org_id, property_id, inbound_message_id, outcome, confidence, model, created_at)
     values ($1, $2, $3, $4, $5, $6, 'm', now() - ($7::int * interval '1 day'))`,
    [id, org, propertyId, messageId, outcome, s.confidence ?? 0.9, s.ageDays ?? 0],
  );
  if (state === "accepted") {
    await db.query(`update public.luna_suggestions set accepted_at = now(), accepted_by = $2, applied_outcome = outcome where id = $1`, [id, ownerId]);
  } else if (state === "rejected") {
    await db.query(`update public.luna_suggestions set rejected_at = now(), rejected_by = $2 where id = $1`, [id, ownerId]);
  } else if (state === "agreed") {
    await db.query(`update public.luna_suggestions set applied_outcome = outcome where id = $1`, [id]);
  }
  return { id, propertyId, messageId };
}

async function expectFail(sql: string, params: unknown[], pattern: RegExp) {
  await db.query("savepoint f");
  await expect(db.query(sql, params)).rejects.toThrow(pattern);
  await db.query("rollback to savepoint f");
}

async function asRole<T>(role: "authenticated" | "service_role", userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint r");
  await db.query(`set local role ${role}`);
  if (userId) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    return await fn();
  } finally {
    await db.query("rollback to savepoint r");
    await db.query("reset role");
  }
}

describe("luna_suggestions constraints", () => {
  it("rejects a second suggestion for the same inbound message", async () => {
    const a = await suggest();
    await expectFail(
      `insert into public.luna_suggestions (org_id, property_id, inbound_message_id, outcome, confidence, model)
       values ($1, $2, $3, 'nurture', 0.5, 'm')`,
      [orgId, a.propertyId, a.messageId],
      /duplicate key|unique/i,
    );
  });

  it("rejects bad outcome, bad confidence, and a property from another org", async () => {
    const p = await property();
    const m = await inbound();
    const ins = `insert into public.luna_suggestions (org_id, property_id, inbound_message_id, outcome, confidence, model)
                 values ($1, $2, $3, $4, $5, 'm')`;
    await expectFail(ins, [orgId, p, m, "maybe", 0.5], /luna_suggestions_outcome_check/);
    await expectFail(ins, [orgId, p, m, "nurture", 1.2], /luna_suggestions_confidence_check|numeric field overflow/);
    await expectFail(ins, [orgId, p, m, "nurture", -0.1], /luna_suggestions_confidence_check/);
    const foreign = await property(otherOrgId);
    await expectFail(ins, [orgId, foreign, m, "nurture", 0.5], /luna_suggestions_property_fk/);
    for (const o of ["new_lead","nurture","not_interested","wrong_number","bad_number","opted_out","dnc","unclear"]) {
      await db.query("savepoint ok");
      await db.query(ins, [orgId, p, await inbound(), o, 0.5]);
      await db.query("release savepoint ok");
    }
  });

  it("enforces accept / reject pairing and exclusivity", async () => {
    const a = await suggest();
    const upd = (set: string) => `update public.luna_suggestions set ${set} where id = $1`;
    await expectFail(upd(`accepted_at = now(), applied_outcome = outcome`), [a.id], /luna_suggestions_accepted_pair_check/);
    await expectFail(upd(`rejected_at = now()`), [a.id], /luna_suggestions_rejected_pair_check/);
    await expectFail(upd(`accepted_by = '${ownerId}'`), [a.id], /luna_suggestions_accepted_pair_check/);
    await expectFail(
      upd(`accepted_at = now(), accepted_by = '${ownerId}', rejected_at = now(), rejected_by = '${ownerId}', applied_outcome = outcome`),
      [a.id], /luna_suggestions_not_both_check/,
    );
  });

  it("requires accepted rows to apply the suggested outcome; open rows may only agree", async () => {
    const a = await suggest();
    await expectFail(
      `update public.luna_suggestions set accepted_at = now(), accepted_by = $2 where id = $1`,
      [a.id, ownerId], /luna_suggestions_accepted_applied_check/,
    );
    await expectFail(
      `update public.luna_suggestions set accepted_at = now(), accepted_by = $2, applied_outcome = 'dnc' where id = $1`,
      [a.id, ownerId], /luna_suggestions_accepted_applied_check/,
    );
    await expectFail(
      `update public.luna_suggestions set applied_outcome = 'dnc' where id = $1`,
      [a.id], /luna_suggestions_open_applied_check/,
    );
    await db.query(`update public.luna_suggestions set applied_outcome = outcome where id = $1`, [a.id]);
  });
});

describe("luna_suggestions update guard", () => {
  it("keeps identity columns immutable", async () => {
    const a = await suggest();
    for (const set of [
      `outcome = 'dnc'`,
      `confidence = 0.1`,
      `model = 'other'`,
      `created_at = now() - interval '1 year'`,
      `org_id = '${otherOrgId}'`,
      `inbound_message_id = '${randomUUID()}'`,
      `property_id = '${randomUUID()}'`,
    ]) {
      await expectFail(`update public.luna_suggestions set ${set} where id = $1`, [a.id], /./);
    }
    await expectFail(`update public.luna_suggestions set outcome = 'dnc' where id = $1`, [a.id], /identity columns are immutable/);
  });

  it("freezes a decided row", async () => {
    const acc = await suggest({ state: "accepted" });
    await expectFail(`update public.luna_suggestions set accepted_at = null, accepted_by = null, applied_outcome = null where id = $1`, [acc.id], /already decided|applied_outcome cannot change/);
    await expectFail(`update public.luna_suggestions set accepted_by = $2 where id = $1`, [acc.id, acqId], /already decided/);
    const rej = await suggest({ state: "rejected" });
    await expectFail(`update public.luna_suggestions set rejected_by = $2 where id = $1`, [rej.id, acqId], /already decided/);
    await expectFail(`update public.luna_suggestions set rejected_at = null, rejected_by = null where id = $1`, [rej.id], /already decided/);
    await expectFail(
      `update public.luna_suggestions set accepted_at = now(), accepted_by = $2, rejected_at = null, rejected_by = null, applied_outcome = outcome where id = $1`,
      [rej.id, ownerId], /already decided/,
    );
    await expectFail(`update public.luna_suggestions set applied_outcome = 'dnc' where id = $1`, [rej.id], /already decided|open_applied/);
  });

  it("never lets applied_outcome change or clear once set; an agreed-manually row can still be decided", async () => {
    const ag = await suggest({ state: "agreed" });
    await expectFail(`update public.luna_suggestions set applied_outcome = null where id = $1`, [ag.id], /applied_outcome cannot change/);
    await expectFail(`update public.luna_suggestions set applied_outcome = 'dnc' where id = $1`, [ag.id], /applied_outcome cannot change|open_applied/);
    await db.query(
      `update public.luna_suggestions set rejected_at = now(), rejected_by = $2 where id = $1`,
      [ag.id, ownerId],
    );
    // no-op updates on a decided row are fine
    await db.query(`update public.luna_suggestions set model = model where id = $1`, [ag.id]);
  });
});

describe("luna_suggestions access", () => {
  it("lets an owner and an Acquisitions member read their own org only", async () => {
    await suggest();
    await suggest({ org: otherOrgId });
    for (const uid of [ownerId, acqId]) {
      const rows = await asRole("authenticated", uid, async () =>
        (await db.query("select org_id from public.luna_suggestions")).rows);
      expect(rows.map((r) => r.org_id)).toEqual([orgId]);
    }
  });

  it("hides rows from a plain member and from another org's owner", async () => {
    await suggest();
    for (const uid of [plainId, outsiderId]) {
      const rows = await asRole("authenticated", uid, async () =>
        (await db.query("select id from public.luna_suggestions where org_id = $1", [orgId])).rows);
      expect(rows).toHaveLength(0);
    }
  });

  it("denies authenticated and anon any write", async () => {
    const a = await suggest();
    for (const role of ["authenticated", "anon"] as const) {
      for (const sql of [
        `insert into public.luna_suggestions (org_id, property_id, inbound_message_id, outcome, confidence, model) values ('${orgId}', '${a.propertyId}', '${randomUUID()}', 'nurture', 0.5, 'm')`,
        `update public.luna_suggestions set model = 'x'`,
        `delete from public.luna_suggestions`,
      ]) {
        await db.query("savepoint w");
        await db.query(`set local role ${role}`);
        if (role === "authenticated") await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
        await db.query("rollback to savepoint w");
        await db.query("reset role");
      }
    }
  });

  it("lets service_role insert and update but not delete", async () => {
    const a = await suggest();
    await asRole("service_role", null, async () => {
      const m = randomUUID();
      await db.query("reset role");
      await db.query(`insert into public.messages (id, org_id, conversation_id, channel, direction, body) values ($1,$2,$3,'sms','inbound','x')`, [m, orgId, randomUUID()]);
      await db.query("set local role service_role");
      await db.query(
        `insert into public.luna_suggestions (org_id, property_id, inbound_message_id, outcome, confidence, model)
         values ($1, $2, $3, 'dnc', 0.8, 'm')`,
        [orgId, a.propertyId, m],
      );
      await db.query(`update public.luna_suggestions set rejected_at = now(), rejected_by = $2 where id = $1`, [a.id, ownerId]);
      await db.query("savepoint d");
      await expect(db.query("delete from public.luna_suggestions where id = $1", [a.id])).rejects.toThrow(/permission denied/);
      await db.query("rollback to savepoint d");
    });
  });

  it("is cleared by reset_tenant_tables", async () => {
    await suggest();
    await db.query("set local session_replication_role = replica"); // skip the membership designation guard
    await db.query("select public.reset_tenant_tables()");
    expect((await db.query("select 1 from public.luna_suggestions")).rows).toHaveLength(0);
  });
});

describe("fn_luna_suggestion_stats", () => {
  const stats = async (days: number, asUserId?: string, org = orgId) => {
    const run = async () => {
      const res = await db.query("select * from public.fn_luna_suggestion_stats($1, $2)", [org, days]);
      return Object.fromEntries(res.rows.map((r) => [r.outcome as string, r]));
    };
    return asUserId ? asRole("authenticated", asUserId, run) : run();
  };

  it("counts each state per outcome", async () => {
    await suggest({ outcome: "nurture", state: "accepted" });
    await suggest({ outcome: "nurture", state: "accepted" });
    await suggest({ outcome: "nurture", state: "rejected" });
    await suggest({ outcome: "nurture", state: "agreed" });
    await suggest({ outcome: "nurture", state: "open" });
    await suggest({ outcome: "nurture", state: "open" });
    await suggest({ outcome: "dnc", state: "open" });
    const s = await stats(7);
    expect(s.nurture).toMatchObject({ shown: "6", accepted: "2", rejected: "1", agreed_manually: "1", open: "2" });
    expect(s.dnc).toMatchObject({ shown: "1", accepted: "0", rejected: "0", agreed_manually: "0", open: "1" });
    expect(Object.keys(s).sort()).toEqual(["dnc", "nurture"]);
  });

  it("excludes bad_number and unclear, and other orgs", async () => {
    await suggest({ outcome: "bad_number" });
    await suggest({ outcome: "unclear" });
    await suggest({ outcome: "wrong_number" });
    await suggest({ outcome: "wrong_number", org: otherOrgId });
    const s = await stats(30);
    expect(Object.keys(s)).toEqual(["wrong_number"]);
    expect(s.wrong_number.shown).toBe("1");
  });

  it("filters by the trailing window", async () => {
    await suggest({ outcome: "new_lead", ageDays: 2 });
    await suggest({ outcome: "new_lead", ageDays: 10 });
    await suggest({ outcome: "new_lead", ageDays: 45 });
    expect((await stats(7)).new_lead.shown).toBe("1");
    expect((await stats(30)).new_lead.shown).toBe("2");
  });

  it("rejects any window other than 7 or 30", async () => {
    for (const d of [0, 1, 14, 90, -7]) {
      await expectFail("select * from public.fn_luna_suggestion_stats($1, $2)", [orgId, d], /must be 7 or 30/);
    }
    await expectFail("select * from public.fn_luna_suggestion_stats($1, null)", [orgId], /must be 7 or 30/);
  });

  it("is SECURITY INVOKER: owner sees counts, another org's or plain member sees nothing", async () => {
    await suggest({ outcome: "nurture" });
    expect((await stats(7, ownerId)).nurture.shown).toBe("1");
    expect((await stats(7, acqId)).nurture.shown).toBe("1");
    expect(await stats(7, outsiderId)).toEqual({});
    expect(await stats(7, plainId)).toEqual({});
  });

  it("is not executable by anon", async () => {
    await db.query("savepoint a");
    await db.query("set local role anon");
    await expect(db.query("select * from public.fn_luna_suggestion_stats($1, 7)", [orgId])).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint a");
    await db.query("reset role");
  });
});
