import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import {
  CI_QUERIES,
  ORG_A,
  ORG_B,
  USERS,
  generateFixture,
  localQueries,
  referenceMatch,
  type OracleFixture,
  type OracleMembership,
} from "./index";

// Seeds the independent oracle's deterministic corpus into the LOCAL stack and
// compares public.search_properties (via real authenticated PostgREST clients)
// with the naive TypeScript referenceMatch. Disagreements are REPORTED, never
// reconciled by editing the oracle. SEARCH_ORACLE_FULL=1 runs the 200-query set.

const service = createTestClient();
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const orgMap: Record<string, string> = { [ORG_A]: BMH_ORG_ID, [ORG_B]: TEST_ORG_B_ID };
const tag = randomUUID().slice(0, 6);
const createdUsers: string[] = [];
const realUser: Record<string, string> = {};
const clients: Record<string, ReturnType<typeof clientForUser>> = {};
let fixture: OracleFixture;

const mapOrg = (o: string) => orgMap[o] ?? o;
async function insertAll(table: string, rows: Record<string, unknown>[], size = 100) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await service.from(table as never).insert(rows.slice(i, i + size) as never);
    if (error) throw new Error(`${table} seed failed: ${error.message}`);
  }
}

describe("search_properties vs independent oracle", () => {
  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await db.connect();
    await resetTenantTables(service);
    await seedTwoOrgs(service);
    for (const org of [BMH_ORG_ID, TEST_ORG_B_ID]) {
      const owner = await createOrgUser(service, { orgId: org, email: `or-${tag}-owner-${randomUUID()}@example.test`, role: "owner" }).catch(() => null);
      if (owner) createdUsers.push(owner.userId);
    }
    const mk = async (key: keyof typeof USERS, orgs: string[]) => {
      let jwt = "";
      for (const org of orgs) {
        const u = await createOrgUser(service, { orgId: org, email: `or-${tag}-${key}-${randomUUID()}@example.test`, role: "member" });
        createdUsers.push(u.userId);
        if (!realUser[key]) { realUser[key] = u.userId; jwt = u.jwt; }
      }
      clients[key] = clientForUser(jwt);
    };
    // "both" needs ONE user in two orgs: create in org A, then add the B membership directly.
    await mk("a", [BMH_ORG_ID]);
    await mk("b", [TEST_ORG_B_ID]);
    await mk("both", [BMH_ORG_ID]);
    await db.query("insert into public.memberships (user_id, org_id, role) values ($1,$2,'member')", [realUser.both, TEST_ORG_B_ID]);
    await mk("expired", [BMH_ORG_ID]);
    await mk("deletionPrepared", [BMH_ORG_ID]);
    await mk("suspended", [BMH_ORG_ID]);
    await db.query("update public.memberships set access_expires_at = now() - interval '1 day' where user_id=$1", [realUser.expired]);
    await db.query("update public.memberships set deletion_prepared_at = now() where user_id=$1", [realUser.deletionPrepared]);
    await db.query("update public.memberships set access_status='suspended' where user_id=$1", [realUser.suspended]);

    // Oracle corpus -> DB (same ids; orgs remapped to the local test orgs).
    const raw = generateFixture();
    const memberships: OracleMembership[] = [];
    const push = (key: keyof typeof USERS, org: string, patch: Partial<OracleMembership> = {}) =>
      memberships.push({ user_id: realUser[key], org_id: org, access_status: "active", access_expires_at: null, deletion_prepared_at: null, ...patch });
    push("a", BMH_ORG_ID); push("b", TEST_ORG_B_ID); push("both", BMH_ORG_ID); push("both", TEST_ORG_B_ID);
    push("expired", BMH_ORG_ID, { access_expires_at: new Date(Date.now() - 86400000).toISOString() });
    push("deletionPrepared", BMH_ORG_ID, { deletion_prepared_at: new Date().toISOString() });
    push("suspended", BMH_ORG_ID, { access_status: "suspended" });
    fixture = {
      contacts: raw.contacts.map((c) => ({ ...c, org_id: mapOrg(c.org_id) })),
      properties: raw.properties.map((p) => ({ ...p, org_id: mapOrg(p.org_id) })),
      // messages.channel only allows sms|email; the corpus' "call" rows stand in as non-sms, so seed them as email.
      messages: raw.messages.map((m) => ({ ...m, org_id: mapOrg(m.org_id), channel: m.channel === "sms" ? "sms" : "email" })),
      memberships,
      users: Object.keys(realUser).map((k) => ({ id: realUser[k], orgIds: memberships.filter((m) => m.user_id === realUser[k]).map((m) => m.org_id) })),
    };
    const type = (v: string | null) => (v ? "mobile" : "unknown");
    await insertAll("contacts", fixture.contacts.map((c) => ({
      ...c, phone_1_type: type(c.phone_1), phone_2_type: type(c.phone_2), phone_3_type: type(c.phone_3),
    })));
    // Properties first without contact links, then link (contacts may be cross-org by design of the corpus).
    const propRow = (p: (typeof fixture.properties)[number]) => ({
      id: p.id, org_id: p.org_id, address: p.address ?? "unknown", city: p.city, state: p.state ?? "MO", zip: p.zip, market: p.market,
      apn: p.apn, mls_number: p.mls_number, status: p.status, is_training: p.is_training, deleted_at: p.deleted_at,
    });
    await insertAll("properties", fixture.properties.filter((p) => !p.is_training).map(propRow));
    // The corpus' training rows do not satisfy the training seed guard (dedicated contact, new_lead); the oracle
    // only needs the is_training flag present, so seed them as superuser on the LOCAL stack with triggers off.
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      for (const p of fixture.properties.filter((x) => x.is_training)) {
        const r = propRow(p);
        await db.query(
          "insert into public.properties (id, org_id, address, city, state, zip, market, apn, mls_number, status, is_training, deleted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)",
          [r.id, r.org_id, r.address, r.city, r.state, r.zip, r.market, r.apn, r.mls_number, r.status, r.deleted_at],
        );
      }
      await db.query("commit");
    } catch (e) { await db.query("rollback"); throw e; }
    for (const p of fixture.properties) {
      if (!p.homeowner_contact_id && !p.agent_contact_id) continue;
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await db.query("update public.properties set homeowner_contact_id=$2, agent_contact_id=$3 where id=$1", [p.id, p.homeowner_contact_id, p.agent_contact_id]);
        await db.query("commit");
      } catch (e) { await db.query("rollback"); throw e; }
    }
    // Messages on training properties are blocked by a customer-workflow guard; seed all of them as superuser (local only).
    const msgRows = fixture.messages.map((m) => ({ ...m, body: m.body ?? "", from_address: "+15550000001", to_address: "+15550000002" }));
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      for (let i = 0; i < msgRows.length; i += 200) {
        await db.query(
          `insert into public.messages (id, org_id, property_id, contact_id, conversation_id, channel, direction, body, from_address, to_address)
           select id, org_id, property_id, contact_id, conversation_id, channel, direction, body, from_address, to_address
           from jsonb_to_recordset($1::jsonb) as t(id uuid, org_id uuid, property_id uuid, contact_id uuid, conversation_id uuid, channel text, direction text, body text, from_address text, to_address text)`,
          [JSON.stringify(msgRows.slice(i, i + 200))],
        );
      }
      await db.query("commit");
    } catch (e) { await db.query("rollback"); throw e; }
  }, 300000);

  afterAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    try {
      for (const id of createdUsers) await service.auth.admin.deleteUser(id);
      await resetTenantTables(service);
    } finally { await db.end(); }
  }, 120000);

  const cases = process.env.SEARCH_ORACLE_FULL === "1" ? null : CI_QUERIES;
  it(`agrees with referenceMatch for ${cases ? cases.length : 200} queries x 6 users`, async () => {
    const queries = cases ?? localQueries(fixture);
    const disagreements: string[] = [];
    for (const query of queries) {
      for (const user of Object.keys(clients)) {
        const { data, error } = await clients[user].rpc("search_properties", { q: query.q, include_messages: query.includeMessages }).select("id");
        if (error) { disagreements.push(`${user} ${JSON.stringify(query.q)}: RPC error ${error.code} ${error.message}`); continue; }
        const got = new Set((data ?? []).map((r: { id: string }) => r.id));
        const want = referenceMatch(fixture, query, realUser[user]);
        const extra = [...got].filter((id) => !want.has(id));
        const missing = [...want].filter((id) => !got.has(id));
        if (extra.length || missing.length) {
          disagreements.push(`${user} [${query.label}] ${JSON.stringify(query.q.slice(0, 60))} includeMessages=${query.includeMessages}: sql-only=${extra.length} oracle-only=${missing.length} (e.g. sql-only ${extra[0] ?? "-"}, oracle-only ${missing[0] ?? "-"})`);
        }
      }
    }
    // Unauthenticated / service-role caller: both sides must be empty.
    const { data } = await service.rpc("search_properties", { q: "smith" }).select("id");
    expect(data).toEqual([]);
    expect(referenceMatch(fixture, { q: "smith", includeMessages: true }, null).size).toBe(0);
    if (disagreements.length) console.error(`ORACLE DISAGREEMENTS (${disagreements.length}):\n${disagreements.join("\n")}`);
    expect(disagreements).toEqual([]);
  }, 300000);
});
