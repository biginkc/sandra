import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Nurture auto-drip switch (20261009050000). Local-only; each test runs in a
 * transaction that is rolled back. The migration (and its rollback) is applied
 * inside the test, so it only needs the base tables (ai_responder_configs,
 * sequences, memberships).
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261009050000_nurture_auto_drip.sql"), "utf8"));
const ROLLBACK = strip(readFileSync(path.join(__dirname, "../rollbacks/20261009050000_nurture_auto_drip.sql"), "utf8"));

const db = new Client({ connectionString: url });
let orgId: string;
let otherOrgId: string;
let configId: string;
let sequenceId: string;
let otherOrgSequenceId: string;
const users = {} as Record<"owner" | "member", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member") {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`,
    [orgId, id, role],
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

const setSwitch = (enabled: boolean, seq: string | null, ...rest: Array<string | null>) => () => {
  // One drip for every route unless the test gives all four.
  const four = rest.length === 3 ? [seq, ...rest] : [seq, seq, seq, seq];
  return db.query(`select public.fn_set_nurture_auto_drip($1, $2, $3, $4, $5, $6) as r`, [configId, enabled, ...four]);
};

const cfg = async () =>
  (await db.query(`select nurture_auto_drip, nurture_drip_maybe_later_sequence_id as ml, nurture_drip_check_in_60_sequence_id as c60, nurture_drip_listed_not_selling_sequence_id as ls, nurture_drip_hot_book_appointment_sequence_id as hot from public.ai_responder_configs where id = $1`, [configId]))
    .rows[0];

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $3), ($2, $4)", [orgId, otherOrgId, `nd-${orgId}`, `nd-other-${otherOrgId}`]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("member", "member");
  await db.query("set local session_replication_role = origin");
  const c = await db.query(
    `insert into public.ai_responder_configs (org_id, system_prompt) values ($1, 'x') returning id`,
    [orgId],
  );
  configId = c.rows[0].id;
  sequenceId = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Nurture', true) returning id`, [orgId])).rows[0].id;
  otherOrgSequenceId = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Other', true) returning id`, [otherOrgId])).rows[0].id;
  await db.query(MIGRATION);
});
afterEach(async () => {
  await db.query("rollback");
});

describe("nurture auto-drip switch", () => {
  it("is OFF with no drip by default (zero behaviour change)", async () => {
    expect(await cfg()).toEqual({ nurture_auto_drip: false, ml: null, c60: null, ls: null, hot: null });
  });

  it("an owner turns it on with a drip, and off again", async () => {
    await asUser(users.owner, setSwitch(true, sequenceId));
    expect(await cfg()).toEqual({ nurture_auto_drip: true, ml: sequenceId, c60: sequenceId, ls: sequenceId, hot: sequenceId });
    await asUser(users.owner, setSwitch(false, sequenceId));
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("refuses to turn on without a drip, with another org's drip, or with an inactive drip", async () => {
    await expect(asUser(users.owner, setSwitch(true, null))).rejects.toThrow(/DRIP_REQUIRED/);
    await expect(asUser(users.owner, setSwitch(true, otherOrgSequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    await db.query(`update public.sequences set active = false where id = $1`, [sequenceId]);
    await expect(asUser(users.owner, setSwitch(true, sequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("cannot be turned on unless ALL FOUR routes have a drip, and each must be this org's active drip", async () => {
    const other = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Second', true) returning id`, [orgId])).rows[0].id;
    for (let missing = 0; missing < 4; missing++) {
      const four = [sequenceId, other, sequenceId, other];
      four[missing] = null as unknown as string;
      await expect(asUser(users.owner, setSwitch(true, four[0], four[1], four[2], four[3]))).rejects.toThrow(/DRIP_REQUIRED/);
    }
    await expect(asUser(users.owner, setSwitch(true, sequenceId, other, sequenceId, otherOrgSequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    await asUser(users.owner, setSwitch(true, sequenceId, other, sequenceId, other));
    expect(await cfg()).toEqual({ nurture_auto_drip: true, ml: sequenceId, c60: other, ls: sequenceId, hot: other });
  });

  it("only an owner may change it", async () => {
    await expect(asUser(users.member, setSwitch(true, sequenceId))).rejects.toThrow(/FORBIDDEN/);
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("the table itself refuses 'on' with no drip (check constraint)", async () => {
    await expect(
      db.query(`update public.ai_responder_configs set nurture_auto_drip = true where id = $1`, [configId]),
    ).rejects.toThrow(/nurture_auto_drip_sequences_check/);
  });

  it("deleting the chosen drip while the switch is on is refused, so 'on' can never point at nothing", async () => {
    await asUser(users.owner, setSwitch(true, sequenceId));
    await expect(db.query(`delete from public.sequences where id = $1`, [sequenceId])).rejects.toThrow(/NURTURE_DRIP_IN_USE: .*Turn the switch off/);
  });

  it("deleting a mapped drip is fine once the switch is off", async () => {
    await asUser(users.owner, setSwitch(true, sequenceId));
    await asUser(users.owner, setSwitch(false, sequenceId));
    await db.query(`delete from public.sequences where id = $1`, [sequenceId]);
    expect((await cfg()).ml).toBeNull();
  });

  describe("a person assigning the lead pauses the Book appointment drip", () => {
    async function seed(sequenceForEnrollment: string, route: string | null) {
      const contact = (await db.query(`insert into public.contacts (org_id, first_name, last_name) values ($1,'T','T') returning id`, [orgId])).rows[0].id;
      const property = (await db.query(
        `insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1, '1 Test', 'MO', 'new_lead', $2) returning id`,
        [orgId, contact],
      )).rows[0].id;
      await db.query(
        `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, auto_enrolled_route)
         values ($1, $2, $3, $4, 'active', 0, now(), $5)`,
        [orgId, sequenceForEnrollment, property, contact, route],
      );
      return property as string;
    }
    const enrollment = async (property: string) =>
      (await db.query(`select status, pause_reason from public.sequence_enrollments where property_id = $1`, [property])).rows[0];
    const assignAs = async (userId: string | null, property: string) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
      await db.query(`update public.properties set assigned_user_id = $2 where id = $1`, [property, users.member]);
    };

    it("a signed-in person assigning pauses the hot enrolment with reason person_took_over", async () => {
      const property = await seed(sequenceId, "hot_book_appointment");
      await assignAs(users.owner, property);
      expect(await enrollment(property)).toEqual({ status: "paused", pause_reason: "person_took_over" });
      // The same lead event the app's pause path writes.
      const ev = (await db.query(`select actor_type, actor_id, payload from public.lead_events where property_id = $1 and event_type = 'sequence_paused'`, [property])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor_type: "user", actor_id: users.owner, payload: { count: 1, reason: "person_took_over", permanent: false } });
    });
    it("the system (no signed-in person) assigning leaves it running", async () => {
      const property = await seed(sequenceId, "hot_book_appointment");
      await assignAs(null, property);
      expect(await enrollment(property)).toEqual({ status: "active", pause_reason: null });
      expect((await db.query(`select 1 from public.lead_events where property_id = $1`, [property])).rows).toEqual([]);
    });
    it("a person assigning a lead in any OTHER drip leaves it running", async () => {
      const other = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Other drip', true) returning id`, [orgId])).rows[0].id;
      const property = await seed(other, "maybe_later");
      await assignAs(users.owner, property);
      expect(await enrollment(property)).toEqual({ status: "active", pause_reason: null });
    });
    it("remapping the owner's Book appointment drip later does not strip protection: the route the enrolment was created with decides", async () => {
      const property = await seed(sequenceId, "hot_book_appointment");
      const other = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Remapped', true) returning id`, [orgId])).rows[0].id;
      await db.query(
        `update public.ai_responder_configs set nurture_auto_drip = true, nurture_drip_maybe_later_sequence_id = $2, nurture_drip_check_in_60_sequence_id = $2,
           nurture_drip_listed_not_selling_sequence_id = $2, nurture_drip_hot_book_appointment_sequence_id = $2 where id = $1`,
        [configId, other],
      );
      await assignAs(users.owner, property);
      expect(await enrollment(property)).toEqual({ status: "paused", pause_reason: "person_took_over" });
    });
    describe("hot enrolment fence (born paused when a takeover or newer seller reply happened since the triggering inbound)", () => {
      async function seedProperty() {
        const contact = (await db.query(`insert into public.contacts (org_id, first_name, last_name) values ($1,'T',$2) returning id`, [orgId, randomUUID()])).rows[0].id;
        const property = (await db.query(
          `insert into public.properties (org_id, address, state, status, homeowner_contact_id) values ($1, '1 Test', 'MO', 'new_lead', $2) returning id`,
          [orgId, contact],
        )).rows[0].id;
        return { contact: contact as string, property: property as string };
      }
      const insertMessage = async (p: { contact: string; property: string }, at: string) =>
        (await db.query(
          `insert into public.messages (org_id, property_id, contact_id, channel, direction, body, status, created_at)
           values ($1, $2, $3, 'sms', 'inbound', 'hi', 'received', $4) returning id`,
          [orgId, p.property, p.contact, at],
        )).rows[0].id as string;
      const insertEnrollment = async (p: { contact: string; property: string }, fenceMessageId: string | null, route = "hot_book_appointment") => {
        await db.query(
          `insert into public.sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, auto_enrolled_route, hot_fence_message_id)
           values ($1, $2, $3, $4, 'active', 0, now(), $5, $6)`,
          [orgId, sequenceId, p.property, p.contact, route, fenceMessageId],
        );
        return enrollment(p.property);
      };
      const FENCE = "2026-10-08 12:00:00.123456+00"; // microseconds on purpose

      it("only the triggering inbound (microsecond timestamp), no takeover: born active, not falsely paused", async () => {
        const p = await seedProperty();
        const m = await insertMessage(p, FENCE);
        expect(await insertEnrollment(p, m)).toEqual({ status: "active", pause_reason: null });
      });
      it("a person took over after the triggering inbound (before the enrolment existed): born paused", async () => {
        const p = await seedProperty();
        const m = await insertMessage(p, FENCE);
        await db.query(`update public.properties set last_person_takeover_at = '2026-10-08 12:00:05+00' where id = $1`, [p.property]);
        expect(await insertEnrollment(p, m)).toEqual({ status: "paused", pause_reason: "person_took_over" });
      });
      it("a takeover BEFORE the triggering inbound does not count", async () => {
        const p = await seedProperty();
        const m = await insertMessage(p, FENCE);
        await db.query(`update public.properties set last_person_takeover_at = '2026-10-08 11:00:00+00' where id = $1`, [p.property]);
        expect(await insertEnrollment(p, m)).toEqual({ status: "active", pause_reason: null });
      });
      it("the seller replied again after the triggering inbound: born paused (inbound_reply)", async () => {
        const p = await seedProperty();
        const m = await insertMessage(p, FENCE);
        await insertMessage(p, "2026-10-08 12:00:09+00");
        expect(await insertEnrollment(p, m)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
      });
      it("a reply a microsecond after the triggering inbound still counts", async () => {
        const p = await seedProperty();
        const m = await insertMessage(p, FENCE);
        await insertMessage(p, "2026-10-08 12:00:00.123457+00");
        expect(await insertEnrollment(p, m)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
      });
      it("no fence, or any other route: untouched", async () => {
        const p = await seedProperty();
        await db.query(`update public.properties set last_person_takeover_at = now() where id = $1`, [p.property]);
        expect(await insertEnrollment(p, null)).toEqual({ status: "active", pause_reason: null });
        const q = await seedProperty();
        const m = await insertMessage(q, FENCE);
        await db.query(`update public.properties set last_person_takeover_at = now() where id = $1`, [q.property]);
        expect(await insertEnrollment(q, m, "maybe_later")).toEqual({ status: "active", pause_reason: null });
      });
    });

    it("a person assigning also leaves the durable takeover marker (the enrol-vs-takeover race fence)", async () => {
      const property = await seed(sequenceId, null);
      await assignAs(users.owner, property);
      const { rows } = await db.query(`select last_person_takeover_at from public.properties where id = $1`, [property]);
      expect(rows[0].last_person_takeover_at).not.toBeNull();
    });
  });

  it("the rollback removes the columns, constraint and RPC", async () => {
    await db.query(ROLLBACK);
    const cols = await db.query(
      `select column_name from information_schema.columns where table_name = 'ai_responder_configs' and (column_name like 'nurture_auto_drip%' or column_name like 'nurture_drip_%')`,
    );
    expect(cols.rows).toEqual([]);
    const fn = await db.query(`select 1 from pg_proc where proname in ('fn_set_nurture_auto_drip', 'fn_guard_nurture_mapped_sequence_delete')`);
    expect(fn.rows).toEqual([]);
  });
});
