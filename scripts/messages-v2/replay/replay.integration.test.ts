import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildExport } from "./export-core";
import { countTaggedRowsPresent, replayOrgId, seedExport, wipeBatch } from "./seed-core";
import type { Query } from "./schema";

/**
 * Export -> seed -> wipe against real Postgres (loopback only), all inside one
 * transaction that is rolled back. The source rows and the replay copy live in
 * the same database here, so the "source" rows are removed before seeding to
 * mimic a separate target database.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const MIGRATION = readFileSync(path.join(__dirname, "../../../supabase/migrations/20261008155000_replay_harness.sql"), "utf8")
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");

const query: Query = (sql, params) => db.query(sql, params as never[]) as never;
const NOW = new Date("2026-10-07T12:00:00.000Z");
const BUSINESS = "+18165559999";
const SELLER = "+19137771234";

let srcOrg: string;
let contactId: string;
let propertyId: string;
let convId: string;
let inboundId: string;
const batchId = "it-2026-10-07";

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("begin");
  await db.query(MIGRATION);
  srcOrg = randomUUID();
  contactId = randomUUID();
  propertyId = randomUUID();
  convId = randomUUID();
  inboundId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'Source org')", [srcOrg]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type, notes)
     values ($1, $2, 'Pat', 'Seller', $3, 'mobile', 'prefers 913-777-1234 after 5')`,
    [contactId, srcOrg, SELLER],
  );
  await db.query(
    `insert into public.properties (id, org_id, address, city, state, zip, status) values ($1, $2, '9 Elm Ct', 'Olathe', 'KS', '66061', 'prospect')`,
    [propertyId, srcOrg],
  );
  await db.query(
    `insert into public.messages (id, org_id, conversation_id, contact_id, property_id, channel, direction, body, status, provider, from_address, to_address, created_at)
     values
     ($1,$2,$3,$4,$5,'sms','outbound','Hi Pat, still want to sell 9 Elm Ct?','delivered','sendillo',$6,$7,'2026-08-01T15:00:00Z'),
     ($8,$2,$3,$4,$5,'sms','inbound','Maybe. Call me 913-777-1234','received','sendillo',$7,$6,'2026-10-05T15:00:00Z')`,
    [randomUUID(), srcOrg, convId, contactId, propertyId, BUSINESS, SELLER, inboundId],
  );
  await db.query(
    `insert into public.sms_phone_suppressions (org_id, phone_e164, source, suppressed_at) values ($1, '+19137771234', 'stop', '2026-07-01T00:00:00Z')`,
    [srcOrg],
  );
  await db.query(`insert into public.ai_responder_configs (org_id, system_prompt, reply_delay_min_seconds, reply_delay_max_seconds) values ($1, 'x', 30, 90)`, [srcOrg]);
});
afterEach(async () => {
  await db.query("rollback");
});

async function exportSource() {
  return buildExport(query, { batchId, days: 30, contextDays: 120, orgId: srcOrg, now: NOW, salt: "integration-salt", businessNumbers: [BUSINESS] });
}

async function removeSource() {
  // mimic a separate target DB: the source org's rows are not there
  await db.query("delete from public.messages where org_id = $1", [srcOrg]);
  await db.query("delete from public.contacts where org_id = $1", [srcOrg]);
  await db.query("delete from public.properties where org_id = $1", [srcOrg]);
  await db.query("delete from public.sms_phone_suppressions where org_id = $1", [srcOrg]);
  await db.query("delete from public.ai_responder_configs where org_id = $1", [srcOrg]);
}

describe("replay export against real Postgres", () => {
  it("exports the window's inbound and the pre-window context, with no real phone anywhere", async () => {
    const exp = await exportSource();
    expect(exp.inbound).toHaveLength(1);
    expect(exp.inbound[0].id).toBe(inboundId);
    expect(exp.tables.messages).toHaveLength(1); // only the pre-window outbound is baseline
    expect(exp.tables.contacts[0].first_name).toBe("Pat");
    expect(exp.tables.properties[0].address).toBe("9 Elm Ct");
    expect(exp.tables.sms_phone_suppressions).toHaveLength(1);
    const json = JSON.stringify(exp);
    expect(json).not.toMatch(/9137771234|913-777-1234|913\.777\.1234/);
    expect(json).toContain(BUSINESS);
    expect(exp.inbound[0].from).toMatch(/^\+1913555\d{4}$/);
    expect(exp.inbound[0].body).toMatch(/^Maybe\. Call me 913-555-\d{4}$/);
  });

  it("runs read-only: a write inside begin transaction read only is rejected by Postgres", async () => {
    await db.query("rollback");
    await db.query("begin transaction read only");
    await expect(db.query("insert into public.organizations (id, name) values (gen_random_uuid(), 'x')")).rejects.toThrow(/read-only/i);
    await db.query("rollback");
    await db.query("begin"); // keep afterEach's rollback balanced
  });
});

describe("replay seed / wipe", () => {
  it("seeds under the replay org, tags every row, and is idempotent", async () => {
    const exp = await exportSource();
    await removeSource();
    const first = await seedExport(query, exp);
    expect(first.orgId).toBe(replayOrgId(batchId));
    expect(first.inserted).toMatchObject({ contacts: 1, properties: 1, messages: 1, sms_phone_suppressions: 1, ai_responder_configs: 1 });
    expect(first.tagged).toBeGreaterThanOrEqual(5);

    const { rows: contacts } = await db.query("select org_id, phone_1 from public.contacts where id = $1", [contactId]);
    expect(contacts[0].org_id).toBe(first.orgId);
    expect(contacts[0].phone_1).toMatch(/^\+1913555\d{4}$/);
    const { rows: cfg } = await db.query("select reply_delay_min_seconds as a, reply_delay_max_seconds as b from public.ai_responder_configs where org_id = $1", [first.orgId]);
    expect(cfg[0]).toEqual({ a: 0, b: 0 });
    const { rows: batch } = await db.query("select id, inbound_count from public.replay_batches where org_id = $1", [first.orgId]);
    expect(batch[0]).toEqual({ id: batchId, inbound_count: 1 });

    const second = await seedExport(query, exp);
    expect(second.inserted).toMatchObject({ contacts: 0, properties: 0, messages: 0 });
    const { rows: n } = await db.query("select count(*)::int as n from public.contacts where org_id = $1", [first.orgId]);
    expect(n[0].n).toBe(1);
    expect(await countTaggedRowsPresent(query, batchId)).toBe(first.tagged);
  });

  it("keeps the AI reply delay when asked", async () => {
    const exp = await exportSource();
    await removeSource();
    await seedExport(query, exp, { keepReplyDelay: true });
    const { rows } = await db.query("select reply_delay_min_seconds as a from public.ai_responder_configs where org_id = $1", [replayOrgId(batchId)]);
    expect(rows[0].a).toBe(30);
  });

  it("refuses to adopt ids that already live in a real org", async () => {
    const exp = await exportSource();
    // source rows still present under the real org -> clash
    await expect(seedExport(query, exp)).rejects.toThrow(/non-replay org/);
  });

  it("wipe removes the org, the batch and every row the replay produced, and nothing else", async () => {
    const exp = await exportSource();
    await removeSource();
    const seeded = await seedExport(query, exp);
    // a row only the replay run would create (not in the export):
    await db.query(
      `insert into public.messages (org_id, conversation_id, contact_id, property_id, channel, direction, body, status)
       values ($1,$2,$3,$4,'sms','inbound','replayed inbound','received')`,
      [seeded.orgId, convId, contactId, propertyId],
    );
    await db.query(`insert into public.replay_outbound_log (batch_id, provider, to_address, body, external_id) values ($1,'sendillo','+19135550100','would send','replay-stub-1')`, [batchId]);
    const bystander = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, 'Bystander')", [bystander]);
    await db.query("insert into public.contacts (org_id, first_name, phone_1, phone_1_type) values ($1,'Keep','+18165550111','mobile')", [bystander]);

    const wiped = await wipeBatch(query, batchId);
    expect(wiped.leftoverTagged).toBe(0);
    for (const table of ["contacts", "properties", "messages", "sms_phone_suppressions", "ai_responder_configs"]) {
      const { rows } = await db.query(`select count(*)::int as n from public.${table} where org_id = $1`, [seeded.orgId]);
      expect(rows[0].n, table).toBe(0);
    }
    expect((await db.query("select 1 from public.organizations where id = $1", [seeded.orgId])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.replay_batches where id = $1", [batchId])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.replay_outbound_log")).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.contacts where org_id = $1", [bystander])).rows).toHaveLength(1);
  });

  it("wipe refuses an org that is not a replay org", async () => {
    await db.query("insert into public.replay_batches (id, org_id) values ('bad', $1)", [srcOrg]);
    await expect(wipeBatch(query, "bad")).rejects.toThrow(/refusing to wipe/);
    expect((await db.query("select 1 from public.contacts where org_id = $1", [srcOrg])).rows).toHaveLength(1);
  });
});
