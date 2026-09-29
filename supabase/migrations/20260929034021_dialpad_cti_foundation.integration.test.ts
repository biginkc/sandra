import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Local-only migration test for the Dialpad CTI foundation. Run with
 * `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch db> npm run test:integration:local`.
 * It rejects non-loopback URLs and is excluded from `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const migrationSql = readFileSync(path.resolve(__dirname, "20260929034021_dialpad_cti_foundation.sql"), "utf8");

const uuid = () => crypto.randomUUID();
const DIALPAD_REP_A = "5150000000000001";
const DIALPAD_REP_B = "5150000000000002";
const BIG_CALL_ID = "6543210987654321098";
let NOW_MS = Date.now();

let pg: Client;
let orgId = "";
let otherOrgId = "";
let ownerId = "";
let repA = "";
let repB = "";
let otherRep = "";
let contactId = "";
let propertyId = "";
let connectionId = "";
let bindingA = "";

async function service<T>(run: () => Promise<T>): Promise<T> {
  await pg.query("set local role service_role");
  await pg.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return await run();
  } finally {
    await pg.query("reset role").catch(() => undefined);
  }
}

async function authenticated<T>(userId: string, run: () => Promise<T>): Promise<T> {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
  try {
    return await run();
  } finally {
    await pg.query("reset role").catch(() => undefined);
  }
}

async function anonymous<T>(run: () => Promise<T>): Promise<T> {
  await pg.query("set local role anon");
  try {
    return await run();
  } finally {
    await pg.query("reset role").catch(() => undefined);
  }
}

interface PgError extends Error {
  code?: string;
  detail?: string;
}

async function failure(run: () => Promise<unknown>): Promise<PgError> {
  await pg.query("savepoint expect_failure");
  let error: PgError | undefined;
  try {
    await run();
  } catch (caught) {
    error = caught as PgError;
  }
  await pg.query("rollback to savepoint expect_failure");
  await pg.query("reset role");
  if (!error) throw new Error("expected the statement to fail");
  return error;
}

async function count(table: string): Promise<number> {
  const result = await pg.query<{ n: string }>(`select count(*)::text as n from public.${table}`);
  return Number(result.rows[0]!.n);
}

async function setDesignation(user: string, org: string, enabled: boolean): Promise<void> {
  await service(async () => {
    await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [org, user]);
    await pg.query("update public.memberships set acquisitions_enabled=$3 where org_id=$1 and user_id=$2", [org, user, enabled]);
    await pg.query("select set_config('my_leads.designation_update', '', true)");
  });
}

async function seedFixture(): Promise<void> {
  orgId = uuid();
  otherOrgId = uuid();
  ownerId = uuid();
  repA = uuid();
  repB = uuid();
  otherRep = uuid();
  contactId = uuid();
  propertyId = uuid();
  for (const id of [ownerId, repA, repB, otherRep]) await pg.query("insert into auth.users(id) values ($1)", [id]);
  await pg.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `CTI ${orgId}`, otherOrgId, `CTI ${otherOrgId}`]);
  await service(async () => {
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member'),($3,$2,'member')", [repA, orgId, repB]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, otherOrgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [otherRep, otherOrgId]);
  });
  for (const [user, org] of [[repA, orgId], [repB, orgId], [otherRep, otherOrgId]] as const) await setDesignation(user, org, true);
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true),($2,true)", [orgId, otherOrgId]);
  await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type,phone_2,phone_2_type) values ($1,$2,'Seller','(816) 555-0142','mobile','816-555-0143','landline')", [contactId, orgId]);
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 CTI Way','MO',$3,$4)",
    [propertyId, orgId, contactId, repA],
  );
  const connection = await service(() =>
    pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','client_abc','op://vault/dialpad-webhook') returning id",
      [orgId],
    ),
  );
  connectionId = connection.rows[0]!.id;
  bindingA = await verifiedBinding(orgId, repA, DIALPAD_REP_A);
}

async function verifiedBinding(org: string, user: string, dialpadUserId: string): Promise<string> {
  return service(async () => {
    const claim = await pg.query<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [org, user, dialpadUserId]);
    const bindingId = claim.rows[0]!.v.bindingId;
    await pg.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','test-attestation')", [bindingId]);
    return bindingId;
  });
}

interface PrepareOptions {
  org?: string;
  rep?: string;
  property?: string;
  contact?: string;
  slot?: number;
  key?: string;
  grant?: string | null;
  ttl?: number;
}

type Intent = Record<string, string | number | null | boolean>;

async function prepare(options: PrepareOptions = {}): Promise<Intent> {
  const result = await service(() =>
    pg.query<{ v: Intent }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,$5::smallint,$6,$7,$8) as v", [
      options.org ?? orgId,
      options.rep ?? repA,
      options.property ?? propertyId,
      options.contact ?? contactId,
      options.slot ?? 1,
      options.key ?? uuid(),
      options.grant ?? null,
      options.ttl ?? 600,
    ]),
  );
  return result.rows[0]!.v;
}

async function prepareFailure(options: PrepareOptions): Promise<PgError> {
  return failure(() => prepare(options));
}

async function grantCaller(user = repA, number = "+18165550100"): Promise<string> {
  const result = await service(() =>
    pg.query<{ v: { grantId: string } }>("select public.fn_grant_dialpad_caller($1,$2,$3,'Office','5555',$4) as v", [orgId, user, number, ownerId]),
  );
  return result.rows[0]!.v.grantId;
}

function eventPayload(overrides: Record<string, unknown> = {}, raw?: string): string {
  if (raw) return raw;
  return JSON.stringify({
    call_id: 1234567890,
    state: "calling",
    event_timestamp: NOW_MS,
    external_number: "+18165550142",
    internal_number: "+18165550100",
    target: { type: "user", id: Number(DIALPAD_REP_A), name: "Rep A" },
    ...overrides,
  });
}

async function ingest(payload: string, org = orgId, connection = connectionId, version = 1): Promise<Record<string, string | boolean>> {
  const result = await service(() =>
    pg.query<{ v: Record<string, string | boolean> }>("select public.fn_ingest_dialpad_call_event($1,$2,$3,$4) as v", [org, connection, version, payload]),
  );
  return result.rows[0]!.v;
}

async function match(eventId: string): Promise<Record<string, string | boolean | null>> {
  const result = await service(() =>
    pg.query<{ v: Record<string, string | boolean | null> }>("select public.fn_match_dialpad_call_event($1) as v", [eventId]),
  );
  return result.rows[0]!.v;
}

async function ingestAndMatch(payload: string): Promise<Record<string, string | boolean | null>> {
  const ingested = await ingest(payload);
  return match(String(ingested.eventId));
}

describe("20260929034021 Dialpad CTI foundation migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl) });
    await pg.connect();
    await pg.query(migrationSql);
    await pg.query(migrationSql);
  });

  afterAll(async () => {
    await pg.end();
  });

  beforeEach(async () => {
    await pg.query("begin");
    NOW_MS = Date.now();
    await seedFixture();
  });

  afterEach(async () => {
    await pg.query("rollback");
    await pg.query("reset role");
  });

  describe("schema, RLS and grants", () => {
    it("enables RLS on every CTI table and stores no raw secret in the connection table", async () => {
      const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(
        "select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname like 'dialpad\\_%' and relkind='r' order by relname",
      );
      expect(rls.rows.map((row) => row.relname)).toEqual([
        "dialpad_call_events",
        "dialpad_call_intents",
        "dialpad_member_bindings",
        "dialpad_number_grants",
        "dialpad_org_connections",
      ]);
      expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
      const columns = await pg.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema='public' and table_name='dialpad_org_connections'",
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).toContain("webhook_secret_ref");
      expect(names.filter((name) => /secret|token|password|key/i.test(name) && name !== "webhook_secret_ref" && name !== "webhook_secret_version" && name !== "directory_api_key_ref")).toEqual([]);
    });

    it("lets active members read only non-secret connection columns", async () => {
      const visible = await authenticated(repA, () =>
        pg.query("select id, org_id, status, cti_client_id, allowed_origins from public.dialpad_org_connections"),
      );
      expect(visible.rows).toHaveLength(1);
      expect(visible.rows[0]).toMatchObject({ cti_client_id: "client_abc", allowed_origins: ["https://dialpad.com"] });
      expect((await failure(() => authenticated(repA, () => pg.query("select webhook_secret_ref from public.dialpad_org_connections")))).code).toBe("42501");
      expect((await failure(() => authenticated(repA, () => pg.query("select * from public.dialpad_org_connections")))).code).toBe("42501");
      const foreign = await authenticated(otherRep, () => pg.query("select id from public.dialpad_org_connections"));
      expect(foreign.rows).toHaveLength(0);
      await service(() => pg.query("update public.dialpad_org_connections set status='disabled' where id=$1", [connectionId]));
      const disabled = await authenticated(repA, () => pg.query("select id from public.dialpad_org_connections"));
      expect(disabled.rows).toHaveLength(0);
    });

    it("denies anon every CTI table and gives authenticated no write path", async () => {
      for (const table of ["dialpad_org_connections", "dialpad_member_bindings", "dialpad_number_grants", "dialpad_call_intents", "dialpad_call_events"]) {
        expect((await failure(() => anonymous(() => pg.query(`select 1 from public.${table}`)))).code).toBe("42501");
        expect((await failure(() => authenticated(repA, () => pg.query(`delete from public.${table}`)))).code).toBe("42501");
      }
      expect((await failure(() => authenticated(repA, () => pg.query("select 1 from public.dialpad_call_events")))).code).toBe("42501");
      expect(
        (
          await failure(() =>
            authenticated(repA, () =>
              pg.query("insert into public.dialpad_member_bindings(org_id,user_id,dialpad_user_id) values ($1,$2,'1')", [orgId, repA]),
            ),
          )
        ).code,
      ).toBe("42501");
      expect(
        (await failure(() => authenticated(repA, () => pg.query("update public.dialpad_call_intents set status='cancelled'")))).code,
      ).toBe("42501");
    });

    it("lets a rep read only their own bindings, grants and intents", async () => {
      await verifiedBinding(orgId, repB, DIALPAD_REP_B);
      const grant = await grantCaller(repA);
      await grantCaller(repB, "+18165550101");
      const intent = await prepare({ grant });
      const bindings = await authenticated(repA, () => pg.query<{ user_id: string }>("select user_id from public.dialpad_member_bindings"));
      expect(bindings.rows.map((row) => row.user_id)).toEqual([repA]);
      const grants = await authenticated(repA, () => pg.query<{ user_id: string }>("select user_id from public.dialpad_number_grants"));
      expect(grants.rows.map((row) => row.user_id)).toEqual([repA]);
      const own = await authenticated(repA, () => pg.query<{ id: string }>("select id from public.dialpad_call_intents"));
      expect(own.rows.map((row) => row.id)).toEqual([intent.intentId]);
      expect((await authenticated(repB, () => pg.query("select id from public.dialpad_call_intents"))).rows).toHaveLength(0);
      expect((await authenticated(otherRep, () => pg.query("select id from public.dialpad_member_bindings"))).rows).toHaveLength(0);
      expect((await authenticated(ownerId, () => pg.query("select id from public.dialpad_call_intents"))).rows).toHaveLength(0);
    });

    it("drops own-row access once the member is no longer active in the org, keeping historical rows intact", async () => {
      const grant = await grantCaller(repA);
      const intent = await prepare({ grant });
      const visible = () =>
        authenticated(repA, async () => ({
          bindings: (await pg.query("select id from public.dialpad_member_bindings")).rowCount,
          grants: (await pg.query("select id from public.dialpad_number_grants")).rowCount,
          intents: (await pg.query("select id, custom_data from public.dialpad_call_intents")).rowCount,
        }));
      expect(await visible()).toEqual({ bindings: 1, grants: 1, intents: 1 });
      const none = { bindings: 0, grants: 0, intents: 0 };
      const setMembership = (assignment: string) =>
        service(() => pg.query(`update public.memberships set ${assignment} where user_id=$1 and org_id=$2`, [repA, orgId]));

      await setMembership("access_status='suspended'");
      expect(await visible()).toEqual(none);
      await setMembership("access_status='active'");
      expect(await visible()).toEqual({ bindings: 1, grants: 1, intents: 1 });

      await setMembership("access_expires_at = now() - interval '1 minute'");
      expect(await visible()).toEqual(none);
      await setMembership("access_expires_at = now() + interval '1 day'");
      expect(await visible()).toEqual({ bindings: 1, grants: 1, intents: 1 });
      await setMembership("access_expires_at = null");

      await setMembership("deletion_prepared_at = now()");
      expect(await visible()).toEqual(none);
      await setMembership("deletion_prepared_at = null");
      expect(await visible()).toEqual({ bindings: 1, grants: 1, intents: 1 });

      await service(() => pg.query("delete from public.memberships where user_id=$1 and org_id=$2", [repA, orgId]));
      expect(await visible()).toEqual(none);

      const historical = await service(() =>
        pg.query("select rep_user_id, binding_id, dialpad_user_id, status from public.dialpad_call_intents where id=$1", [intent.intentId]),
      );
      expect(historical.rows[0]).toEqual({ rep_user_id: repA, binding_id: bindingA, dialpad_user_id: DIALPAD_REP_A, status: "prepared" });
    });

    it("does not let active membership in another org open this org's own rows", async () => {
      await prepare();
      await service(() => pg.query("delete from public.memberships where user_id=$1 and org_id=$2", [repA, orgId]));
      await service(() => pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [repA, otherOrgId]));
      const rows = await authenticated(repA, async () => ({
        bindings: (await pg.query("select id from public.dialpad_member_bindings")).rowCount,
        intents: (await pg.query("select id from public.dialpad_call_intents")).rowCount,
      }));
      expect(rows).toEqual({ bindings: 0, intents: 0 });
    });

    it("keeps every privileged function service-role only", async () => {
      const functions = [
        "fn_claim_dialpad_member_binding(uuid,uuid,text)",
        "fn_verify_dialpad_member_binding(uuid,text,text)",
        "fn_revoke_dialpad_member_binding(uuid,text)",
        "fn_grant_dialpad_caller(uuid,uuid,text,text,text,uuid)",
        "fn_revoke_dialpad_caller_grant(uuid,uuid)",
        "fn_prepare_dialpad_call_intent(uuid,uuid,uuid,uuid,smallint,uuid,uuid,integer)",
        "fn_cancel_dialpad_call_intent(uuid,uuid,uuid)",
        "fn_ingest_dialpad_call_event(uuid,uuid,integer,text)",
        "fn_match_dialpad_call_event(uuid)",
      ];
      for (const signature of functions) {
        const result = await pg.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
          "select has_function_privilege('anon',$1,'execute') as anon, has_function_privilege('authenticated',$1,'execute') as authenticated, has_function_privilege('service_role',$1,'execute') as service",
          [`public.${signature}`],
        );
        expect(result.rows[0], signature).toEqual({ anon: false, authenticated: false, service: true });
      }
      const helpers = await pg.query<{ fn: string; authenticated: boolean }>(
        `select 'member_is_active' as fn, has_function_privilege('authenticated','public.dialpad_cti_member_is_active(uuid,uuid)','execute') as authenticated
         union all select 'normalize', has_function_privilege('authenticated','public.dialpad_cti_normalize_us_phone(text)','execute')`,
      );
      expect(helpers.rows.every((row) => !row.authenticated)).toBe(true);
      expect((await failure(() => authenticated(repA, () => pg.query("select public.fn_match_dialpad_call_event($1)", [uuid()])))).code).toBe("42501");
      expect((await failure(() => anonymous(() => pg.query("select public.fn_ingest_dialpad_call_event($1,$2,1,'{}')", [orgId, connectionId])))).code).toBe("42501");
    });

    it("gives service_role no direct write path except through the connection table and functions", async () => {
      const intent = await prepare();
      for (const sql of [
        "update public.dialpad_call_intents set status='cancelled'",
        "delete from public.dialpad_call_intents",
        "update public.dialpad_member_bindings set status='revoked'",
        "delete from public.dialpad_number_grants",
        "update public.dialpad_call_events set disposition='matched'",
        "delete from public.dialpad_call_events",
      ]) {
        expect((await failure(() => service(() => pg.query(sql)))).code, sql).toBe("42501");
      }
      expect((await failure(() => service(() => pg.query("insert into public.dialpad_call_events(org_id,connection_id,provider_call_id,event_state,event_timestamp_ms,payload,payload_sha256,secret_version) values ($1,$2,'1','x',1700000000000,'{}',repeat('a',64),1)", [orgId, connectionId])))).code).toBe("42501");
      expect(intent.status).toBe("prepared");
    });

    it("re-applies the migration without changing grants or data", async () => {
      await prepare();
      const before = await count("dialpad_call_intents");
      await pg.query("savepoint reapply");
      await pg.query(migrationSql.replace(/^begin;/m, "").replace(/^commit;/m, ""));
      await pg.query("release savepoint reapply");
      expect(await count("dialpad_call_intents")).toBe(before);
      expect((await authenticated(repA, () => pg.query("select id from public.dialpad_call_intents"))).rows).toHaveLength(1);
    });
  });

  describe("connection and identity", () => {
    it("validates origins and connection shape", async () => {
      const insert = (origins: string[], clientId = "ok_1", org = otherOrgId) =>
        service(() =>
          pg.query("insert into public.dialpad_org_connections(org_id,cti_client_id,webhook_secret_ref,allowed_origins) values ($1,$2,'ref',$3)", [org, clientId, origins]),
        );
      expect((await failure(() => insert(["http://dialpad.com"]))).code).toBe("23514");
      expect((await failure(() => insert(["https://dialpad.com/path"]))).code).toBe("23514");
      expect((await failure(() => insert([]))).code).toBe("23514");
      expect((await failure(() => insert(["https://dialpad.com"], "bad client id"))).code).toBe("23514");
      expect((await failure(() => insert(["https://dialpad.com"], "ok_1", orgId))).code).toBe("23505");
      await insert(["https://dialpad.com", "https://preview.example.com:8443"]);
    });

    it("refuses connection deletion, identity rewrites and secret version rollback", async () => {
      expect((await failure(() => pg.query("delete from public.dialpad_org_connections where id=$1", [connectionId]))).message).toMatch(/cannot be deleted/);
      expect((await failure(() => service(() => pg.query("update public.dialpad_org_connections set org_id=$1 where id=$2", [otherOrgId, connectionId])))).message).toMatch(/immutable/);
      await service(() => pg.query("update public.dialpad_org_connections set webhook_secret_version=2 where id=$1", [connectionId]));
      expect((await failure(() => service(() => pg.query("update public.dialpad_org_connections set webhook_secret_version=1 where id=$1", [connectionId])))).message).toMatch(/cannot decrease/);
    });

    it("treats a claimed Dialpad id as untrusted until verified, and prepare requires verification", async () => {
      const claim = await service(() =>
        pg.query<{ v: { bindingId: string; status: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [orgId, repB, DIALPAD_REP_B]),
      );
      expect(claim.rows[0]!.v.status).toBe("pending");
      expect((await prepareFailure({ rep: repB, property: await propertyFor(repB) })).detail).toBe("binding_not_verified");
    });

    it("enforces one live binding per rep and one verified binding per Dialpad user", async () => {
      const replay = await service(() =>
        pg.query<{ v: { replayed: boolean } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [orgId, repA, DIALPAD_REP_A]),
      );
      expect(replay.rows[0]!.v.replayed).toBe(true);
      const conflict = await failure(() => service(() => pg.query("select public.fn_claim_dialpad_member_binding($1,$2,$3)", [orgId, repA, DIALPAD_REP_B])));
      expect(conflict.detail).toBe("binding_exists");
      const claimB = await service(() =>
        pg.query<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [orgId, repB, DIALPAD_REP_A]),
      );
      const squatted = await failure(() =>
        service(() => pg.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','x')", [claimB.rows[0]!.v.bindingId])),
      );
      expect(squatted.detail).toBe("dialpad_user_already_bound");
    });

    it("supersedes an unverified claim and keeps a superseded id from being verified", async () => {
      const first = await service(() =>
        pg.query<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,'111') as v", [orgId, repB]),
      );
      await service(() => pg.query("select public.fn_claim_dialpad_member_binding($1,$2,'222')", [orgId, repB]));
      const stale = await failure(() =>
        service(() => pg.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','x')", [first.rows[0]!.v.bindingId])),
      );
      expect(stale.detail).toBe("binding_not_pending");
    });

    it("refuses claims for foreign-org, inactive or non-acquisition users and inactive connections", async () => {
      expect((await failure(() => service(() => pg.query("select public.fn_claim_dialpad_member_binding($1,$2,'9')", [orgId, otherRep])))).detail).toBe("rep_not_active");
      expect((await failure(() => service(() => pg.query("select public.fn_claim_dialpad_member_binding($1,$2,'9')", [otherOrgId, repA])))).detail).toBe("connection_inactive");
      expect((await failure(() => service(() => pg.query("select public.fn_claim_dialpad_member_binding($1,$2,'not-a-number')", [orgId, repB])))).code).toBe("22023");
    });

    it("makes bindings append-only evidence with forward-only status", async () => {
      const guarded = (sql: string) => failure(() => pg.query(sql, [bindingA]));
      expect((await guarded("update public.dialpad_member_bindings set dialpad_user_id='999' where id=$1")).message).toMatch(/immutable/);
      expect((await guarded("update public.dialpad_member_bindings set user_id=gen_random_uuid() where id=$1")).message).toMatch(/immutable|foreign key/);
      expect((await guarded("update public.dialpad_member_bindings set status='pending', verified_at=null, verification_kind=null, verification_ref=null where id=$1")).message).toMatch(/pending/);
      expect((await guarded("update public.dialpad_member_bindings set verification_ref='rewritten' where id=$1")).message).toMatch(/evidence is immutable/);
      expect((await guarded("delete from public.dialpad_member_bindings where id=$1")).message).toMatch(/append-only/);
      await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'left the company')", [bindingA]));
      expect((await guarded("update public.dialpad_member_bindings set status='pending', revoked_at=null, revoked_reason=null where id=$1")).message).toMatch(/terminal/);
    });

    it("requires an owner to grant callers and freezes grant identity", async () => {
      expect(
        (await failure(() => service(() => pg.query("select public.fn_grant_dialpad_caller($1,$2,'+18165550100',null,null,$3)", [orgId, repA, repB])))).detail,
      ).toBe("granter_not_owner");
      const grant = await grantCaller();
      const replay = await service(() =>
        pg.query<{ v: { grantId: string; replayed: boolean } }>("select public.fn_grant_dialpad_caller($1,$2,'+18165550100','Office','5555',$3) as v", [orgId, repA, ownerId]),
      );
      expect(replay.rows[0]!.v).toEqual({ grantId: grant, replayed: true });
      expect((await failure(() => pg.query("update public.dialpad_number_grants set caller_number_e164='+18165559999' where id=$1", [grant]))).message).toMatch(/immutable/);
      expect((await failure(() => pg.query("delete from public.dialpad_number_grants where id=$1", [grant]))).message).toMatch(/append-only/);
      expect((await failure(() => service(() => pg.query("select public.fn_grant_dialpad_caller($1,$2,'12345',null,null,$3)", [orgId, repA, ownerId])))).code).toBe("23514");
    });
  });

  async function propertyFor(rep: string): Promise<string> {
    const contact = uuid();
    const property = uuid();
    await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Other','816-555-0177','mobile')", [contact, orgId]);
    await pg.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'2 CTI Way','MO',$3,$4)",
      [property, orgId, contact, rep],
    );
    return property;
  }

  describe("prepared call intents", () => {
    it("freezes the authorized rep, lead, assignment, number and caller, with an opaque token", async () => {
      const grant = await grantCaller();
      const intent = await prepare({ grant, slot: 1 });
      expect(intent).toMatchObject({
        status: "prepared",
        destinationE164: "+18165550142",
        phoneSlot: 1,
        callerNumberE164: "+18165550100",
        callerIdentityType: "Office",
        callerIdentityId: "5555",
        dialpadUserId: DIALPAD_REP_A,
        propertyId,
        contactId,
        replayed: false,
      });
      expect(String(intent.customData)).toMatch(/^sandra\.dialpad\.v1\.[0-9a-f]{48}$/);
      const stored = await service(() =>
        pg.query("select rep_user_id, binding_id, assignment_episode_id, connection_id from public.dialpad_call_intents where id=$1", [intent.intentId]),
      );
      const episode = await pg.query("select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null and assignee_user_id=$2", [propertyId, repA]);
      expect(stored.rows[0]).toMatchObject({ rep_user_id: repA, binding_id: bindingA, assignment_episode_id: episode.rows[0].id, connection_id: connectionId });
      const second = await prepare({ slot: 2 });
      expect(second.destinationE164).toBe("+18165550143");
      expect(second.callerNumberE164).toBeNull();
      expect(second.customData).not.toBe(intent.customData);
    });

    it("is idempotent on replay and rejects a conflicting replay", async () => {
      const key = uuid();
      const first = await prepare({ key });
      const replay = await prepare({ key });
      expect(replay).toMatchObject({ intentId: first.intentId, customData: first.customData, replayed: true });
      expect(await count("dialpad_call_intents")).toBe(1);
      for (const change of [{ slot: 2 }, { ttl: 900 }, { contact: (await otherContactOnProperty()) }] as PrepareOptions[]) {
        const error = await prepareFailure({ key, ...change });
        expect(error.code, JSON.stringify(change)).toBe("40001");
        expect(error.message).toBe("IDEMPOTENCY_CONFLICT");
      }
      expect(await count("dialpad_call_intents")).toBe(1);
    });

    async function otherContactOnProperty(): Promise<string> {
      const contact = uuid();
      await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Relative','816-555-0188','mobile')", [contact, orgId]);
      await pg.query("insert into public.property_contacts(property_id,contact_id,org_id,relationship,source_identity,source_position) values ($1,$2,$3,'owner','cti-test',2)", [propertyId, contact, orgId]);
      return contact;
    }

    it("allows an additional contact linked to the property and rejects an unlinked or foreign contact", async () => {
      const linked = await otherContactOnProperty();
      expect((await prepare({ contact: linked })).destinationE164).toBe("+18165550188");
      const unlinked = uuid();
      await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Stranger','816-555-0199','mobile')", [unlinked, orgId]);
      expect((await prepareFailure({ contact: unlinked })).detail).toBe("contact_not_on_property");
      const foreign = uuid();
      await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Foreign','816-555-0166','mobile')", [foreign, otherOrgId]);
      expect((await prepareFailure({ contact: foreign })).code).toBe("P0002");
    });

    it("denies a foreign rep, foreign org and unassigned rep", async () => {
      await verifiedBinding(orgId, repB, DIALPAD_REP_B);
      expect((await prepareFailure({ rep: repB })).detail).toBe("not_assigned_rep");
      expect((await prepareFailure({ rep: otherRep })).detail).toBe("rep_not_active");
      expect((await prepareFailure({ org: otherOrgId })).detail).toBe("connection_inactive");
      const foreignProperty = uuid();
      const foreignContact = uuid();
      await pg.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'X','816-555-0155','mobile')", [foreignContact, otherOrgId]);
      await pg.query("insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'9 Elsewhere','MO',$3,$4)", [foreignProperty, otherOrgId, foreignContact, otherRep]);
      expect((await prepareFailure({ property: foreignProperty, contact: foreignContact })).code).toBe("P0002");
      expect(await count("dialpad_call_intents")).toBe(0);
    });

    it("rejects invalid input before touching data", async () => {
      for (const options of [{ slot: 4 }, { slot: 0 }, { ttl: 10 }, { ttl: 99999 }] as PrepareOptions[]) {
        expect((await prepareFailure(options)).code, JSON.stringify(options)).toBe("22023");
      }
      await pg.query("update public.contacts set phone_3=null where id=$1", [contactId]);
      expect((await prepareFailure({ slot: 3 })).detail).toBe("phone_unavailable");
      await pg.query("update public.contacts set phone_3='12345', phone_3_type='mobile' where id=$1", [contactId]);
      expect((await prepareFailure({ slot: 3 })).detail).toBe("phone_unavailable");
    });

    it("rejects revoked, foreign and cross-org caller grants", async () => {
      const grant = await grantCaller();
      const foreignGrant = await grantCaller(repB, "+18165550101").catch(async () => {
        await verifiedBinding(orgId, repB, DIALPAD_REP_B);
        return grantCaller(repB, "+18165550101");
      });
      expect((await prepareFailure({ grant: foreignGrant })).detail).toBe("caller_grant_unavailable");
      expect((await prepareFailure({ grant: uuid() })).detail).toBe("caller_grant_unavailable");
      const ok = await prepare({ grant });
      const revoked = await service(() =>
        pg.query<{ v: { cancelledIntents: number } }>("select public.fn_revoke_dialpad_caller_grant($1,$2) as v", [grant, ownerId]),
      );
      expect(revoked.rows[0]!.v.cancelledIntents).toBe(1);
      expect((await prepareFailure({ grant })).detail).toBe("caller_grant_unavailable");
      const stored = await service(() => pg.query("select status from public.dialpad_call_intents where id=$1", [ok.intentId]));
      expect(stored.rows[0].status).toBe("cancelled");
    });

    it("re-proves authorization on replay: a revoked binding cannot retrieve a live token", async () => {
      const key = uuid();
      const first = await prepare({ key });
      await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'rep offboarded')", [bindingA]));
      expect((await prepareFailure({ key })).detail).toBe("binding_not_verified");
      const stored = await service(() => pg.query("select status, rep_user_id, dialpad_user_id from public.dialpad_call_intents where id=$1", [first.intentId]));
      expect(stored.rows[0]).toEqual({ status: "cancelled", rep_user_id: repA, dialpad_user_id: DIALPAD_REP_A });
    });

    it("keeps a revoked intent terminal when a replacement binding exists and the old key is replayed", async () => {
      const key = uuid();
      const first = await prepare({ key });
      await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'device replaced')", [bindingA]));
      const replacement = await verifiedBinding(orgId, repA, "5150000000000009");
      expect(replacement).not.toBe(bindingA);

      const replay = await prepare({ key });
      expect(replay).toMatchObject({
        intentId: first.intentId,
        customData: first.customData,
        status: "cancelled",
        replayed: true,
        dialpadUserId: DIALPAD_REP_A,
        expiresAt: first.expiresAt,
      });
      const stored = await service(() =>
        pg.query("select status, binding_id, dialpad_user_id, cancelled_at from public.dialpad_call_intents where id=$1", [first.intentId]),
      );
      expect(stored.rows[0]).toMatchObject({ status: "cancelled", binding_id: bindingA, dialpad_user_id: DIALPAD_REP_A });
      expect(stored.rows[0].cancelled_at).not.toBeNull();
      expect(await count("dialpad_call_intents")).toBe(1);

      const fresh = await prepare({ key: uuid() });
      expect(fresh).toMatchObject({ status: "prepared", replayed: false, dialpadUserId: "5150000000000009" });
      expect(fresh.intentId).not.toBe(first.intentId);
      expect(fresh.customData).not.toBe(first.customData);
    });

    it("replays an expired or matched intent as its stored state, never as newly prepared", async () => {
      const expiredKey = uuid();
      const expired = await prepare({ key: expiredKey, ttl: 60, slot: 2 });
      await pg.query("alter table public.dialpad_call_intents disable trigger user");
      await pg.query("update public.dialpad_call_intents set prepared_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' where id=$1", [expired.intentId]);
      await pg.query("alter table public.dialpad_call_intents enable trigger user");
      const expiredReplay = await prepare({ key: expiredKey, ttl: 60, slot: 2 });
      expect(expiredReplay).toMatchObject({ intentId: expired.intentId, status: "prepared", replayed: true });
      expect(new Date(String(expiredReplay.expiresAt)).getTime()).toBeLessThan(Date.now());

      const matchedKey = uuid();
      const matchedIntent = await prepare({ key: matchedKey });
      const result = await ingestAndMatch(eventPayload({ custom_data: String(matchedIntent.customData) }));
      expect(result).toMatchObject({ disposition: "matched", intentId: matchedIntent.intentId });
      expect(await prepare({ key: matchedKey })).toMatchObject({ intentId: matchedIntent.intentId, status: "matched", replayed: true });
    });

    it("denies stale and revoked bindings, membership loss and disabled features", async () => {
      await service(() => pg.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [repA, orgId]));
      expect((await prepareFailure({})).detail).toBe("rep_not_active");
      await service(() => pg.query("update public.memberships set access_status='active', access_expires_at=now() - interval '1 minute' where user_id=$1 and org_id=$2", [repA, orgId]));
      expect((await prepareFailure({})).detail).toMatch(/rep_not_active|not_assigned_rep/);
      await service(() => pg.query("update public.memberships set access_expires_at=null where user_id=$1 and org_id=$2", [repA, orgId]));
      await setDesignation(repA, orgId, false);
      expect((await prepareFailure({})).detail).toMatch(/rep_not_active|not_assigned_rep/);
    });

    it("denies a disabled connection and disabled My Leads", async () => {
      await pg.query("update public.acquisition_org_settings set my_leads_enabled=false where org_id=$1", [orgId]);
      expect((await prepareFailure({})).detail).toMatch(/my_leads_disabled|not_assigned_rep/);
      await pg.query("update public.acquisition_org_settings set my_leads_enabled=true where org_id=$1", [orgId]);
      await service(() => pg.query("update public.dialpad_org_connections set status='disabled' where id=$1", [connectionId]));
      expect((await prepareFailure({})).detail).toBe("connection_inactive");
    });

    it("denies reassigned, unassigned and deleted leads", async () => {
      await pg.query("update public.properties set assigned_user_id=$1 where id=$2", [repB, propertyId]);
      expect((await prepareFailure({})).detail).toBe("not_assigned_rep");
      await pg.query("update public.properties set assigned_user_id=null where id=$1", [propertyId]);
      expect((await prepareFailure({})).detail).toBe("not_assigned_rep");
      await pg.query("update public.properties set assigned_user_id=$1 where id=$2", [repA, propertyId]);
      expect((await prepare({})).status).toBe("prepared");
      await pg.query("update public.properties set deleted_at=now() where id=$1", [propertyId]);
      expect((await prepareFailure({})).detail).toBe("property_unavailable");
    });

    it("keeps frozen attribution when the lead is later reassigned or the binding revoked", async () => {
      const intent = await prepare({});
      await pg.query("update public.properties set assigned_user_id=$1 where id=$2", [repB, propertyId]);
      const stored = await service(() =>
        pg.query("select rep_user_id, assignment_episode_id, destination_e164, dialpad_user_id, status from public.dialpad_call_intents where id=$1", [intent.intentId]),
      );
      expect(stored.rows[0]).toMatchObject({ rep_user_id: repA, destination_e164: "+18165550142", dialpad_user_id: DIALPAD_REP_A, status: "prepared" });
      expect((await failure(() => service(() => pg.query("delete from public.acquisition_assignment_episodes where id=$1", [stored.rows[0].assignment_episode_id])))).code).toBeDefined();
      const ended = await pg.query("select ended_at from public.acquisition_assignment_episodes where id=$1", [stored.rows[0].assignment_episode_id]);
      expect(ended.rows[0].ended_at).not.toBeNull();
    });

    it("denies globally registered numbers and do-not-contact contacts (which lock the property)", async () => {
      await service(() =>
        pg.query(
          "insert into public.global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256) values ($1,'+18165550142',gen_random_uuid(),gen_random_uuid(),repeat('a',64))",
          [orgId],
        ),
      );
      expect((await prepareFailure({})).detail).toBe("phone_dnc");
      expect((await prepare({ slot: 2 })).destinationE164).toBe("+18165550143");
      await pg.query("update public.contacts set do_not_contact=true where id=$1", [contactId]);
      expect((await prepareFailure({ slot: 2 })).detail).toBe("property_dnc_locked");
    });

    it("makes intents immutable evidence with forward-only status", async () => {
      const intent = await prepare({});
      const id = intent.intentId;
      const attempt = (sql: string) => failure(() => pg.query(sql, [id]));
      for (const column of ["rep_user_id=gen_random_uuid()", "destination_e164='+18165559999'", "property_id=gen_random_uuid()", "dialpad_user_id='1'", "custom_data='sandra.dialpad.v1.' || repeat('0',48)", "assignment_episode_id=gen_random_uuid()", "expires_at=expires_at + interval '1 day'", "contact_id=gen_random_uuid()", "idempotency_key=gen_random_uuid()", "phone_slot=2", "org_id=gen_random_uuid()"]) {
        const error = await attempt(`update public.dialpad_call_intents set ${column} where id=$1`);
        expect(error.message, column).toMatch(/immutable|foreign key|check constraint/);
      }
      expect((await attempt("delete from public.dialpad_call_intents where id=$1")).message).toMatch(/immutable evidence/);
      await service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repA, id]));
      expect((await attempt("update public.dialpad_call_intents set status='prepared', cancelled_at=null where id=$1")).message).toMatch(/terminal/);
      const replayed = await service(() =>
        pg.query<{ v: { replayed: boolean } }>("select public.fn_cancel_dialpad_call_intent($1,$2,$3) as v", [orgId, repA, id]),
      );
      expect(replayed.rows[0]!.v.replayed).toBe(true);
      expect((await failure(() => service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repB, id])))).code).toBe("P0002");
    });

    it("blocks inserting an intent with forged state or an unauthorized composite reference", async () => {
      const intent = await prepare({});
      const copyIntent = (tokenDigit: string, overrides: { status?: string; rep?: string }) =>
        pg.query(
          `insert into public.dialpad_call_intents(org_id,connection_id,rep_user_id,binding_id,dialpad_user_id,property_id,contact_id,phone_slot,destination_e164,assignment_episode_id,custom_data,idempotency_key,request_hash,expires_at,status)
           select org_id,connection_id,coalesce($3::uuid,rep_user_id),binding_id,dialpad_user_id,property_id,contact_id,phone_slot,destination_e164,assignment_episode_id,'sandra.dialpad.v1.' || repeat($2,48),gen_random_uuid(),request_hash,expires_at,coalesce($4,'prepared')
           from public.dialpad_call_intents where id=$1`,
          [intent.intentId, tokenDigit, overrides.rep ?? null, overrides.status ?? null],
        );
      expect((await failure(() => copyIntent("1", { status: "matched" }))).message).toMatch(/created prepared|check constraint/);
      expect((await failure(() => copyIntent("2", { rep: repB }))).code).toBe("23503");
      await copyIntent("3", {});
    });

    it("causes no dispatch side effects", async () => {
      const tables = ["call_activities", "acquisition_attempts", "acquisition_commands"];
      const before = await Promise.all(tables.map(count));
      const grant = await grantCaller();
      const intent = await prepare({ grant });
      await ingestAndMatch(eventPayload({ custom_data: String(intent.customData), event_timestamp: NOW_MS }));
      expect(await Promise.all(tables.map(count))).toEqual(before);
      const messaging = await pg.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public' and table_name ~ '(outbox|sms_messages|message_queue)' and table_type='BASE TABLE'",
      );
      for (const row of messaging.rows) {
        const rows = await pg.query(`select count(*)::int as n from public.${row.table_name}`);
        expect(rows.rows[0].n, row.table_name).toBe(0);
      }
    });
  });

  describe("signed-event inbox", () => {
    it("stores exact replays once and preserves 64-bit call ids", async () => {
      const raw = `{"call_id": ${BIG_CALL_ID}, "state": "calling", "event_timestamp": ${NOW_MS}, "external_number": "+18165550142"}`;
      const first = await ingest(raw);
      expect(first).toMatchObject({ disposition: "received", replayed: false, conflict: false });
      const replay = await ingest(raw);
      expect(replay).toMatchObject({ eventId: first.eventId, replayed: true });
      const spaced = await ingest(`{"external_number":"+18165550142","event_timestamp":${NOW_MS},"state":"calling","call_id":${BIG_CALL_ID}}`);
      expect(spaced).toMatchObject({ eventId: first.eventId, replayed: true });
      const stored = await service(() => pg.query("select provider_call_id, event_timestamp_ms::text as ts, payload_sha256 from public.dialpad_call_events"));
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].provider_call_id).toBe(BIG_CALL_ID);
      expect(stored.rows[0].ts).toBe(String(NOW_MS));
      expect(stored.rows[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("records a different payload under the same event key as a conflict that is never credited", async () => {
      const first = await ingest(eventPayload());
      const conflict = await ingest(eventPayload({ external_number: "+18165559999" }));
      expect(conflict).toMatchObject({ disposition: "conflict", conflict: true, replayed: false });
      expect(conflict.eventId).not.toBe(first.eventId);
      const replayOfConflict = await ingest(eventPayload({ external_number: "+18165559999" }));
      expect(replayOfConflict).toMatchObject({ eventId: conflict.eventId, replayed: true, conflict: true });
      const matched = await match(String(conflict.eventId));
      expect(matched).toMatchObject({ disposition: "conflict", replayed: true });
      const stored = await service(() => pg.query("select payload ->> 'external_number' as n from public.dialpad_call_events where id=$1", [first.eventId]));
      expect(stored.rows[0].n).toBe("+18165550142");
    });

    it("keeps out-of-order events for one call as distinct events", async () => {
      const later = await ingest(eventPayload({ state: "connected", event_timestamp: NOW_MS + 5000 }));
      const earlier = await ingest(eventPayload({ state: "ringing", event_timestamp: NOW_MS + 1000 }));
      const hangup = await ingest(eventPayload({ state: "hangup", event_timestamp: NOW_MS + 9000 }));
      expect(new Set([later.eventId, earlier.eventId, hangup.eventId]).size).toBe(3);
      expect(await count("dialpad_call_events")).toBe(3);
    });

    it("rejects malformed, identity-less, foreign-connection and future-secret deliveries without storing", async () => {
      expect((await failure(() => ingest("not json"))).detail).toBe("payload_not_json");
      expect((await failure(() => ingest("[1]"))).detail).toBe("payload_not_object");
      expect((await failure(() => ingest(JSON.stringify({ state: "calling", event_timestamp: NOW_MS })))).detail).toBe("missing_event_identity");
      expect((await failure(() => ingest(JSON.stringify({ call_id: "abc", state: "calling", event_timestamp: NOW_MS })))).detail).toBe("missing_event_identity");
      expect((await failure(() => ingest(JSON.stringify({ call_id: 1, state: "calling", event_timestamp: 5 })))).detail).toBe("missing_event_identity");
      expect((await failure(() => ingest(eventPayload(), otherOrgId))).detail).toBe("connection_inactive");
      expect((await failure(() => ingest(eventPayload(), orgId, uuid()))).detail).toBe("connection_inactive");
      expect((await failure(() => ingest(eventPayload(), orgId, connectionId, 2))).detail).toBe("secret_version");
      expect((await failure(() => ingest(eventPayload(), orgId, connectionId, 0))).detail).toBe("secret_version");
      await service(() => pg.query("update public.dialpad_org_connections set status='disabled' where id=$1", [connectionId]));
      expect((await failure(() => ingest(eventPayload()))).detail).toBe("connection_inactive");
      expect(await count("dialpad_call_events")).toBe(0);
    });

    it("makes events immutable with a forward-only disposition", async () => {
      const event = String((await ingest(eventPayload())).eventId);
      const attempt = (sql: string) => failure(() => pg.query(sql, [event]));
      for (const column of ["payload='{}'::jsonb", "provider_call_id='1'", "payload_sha256=repeat('b',64)", "event_timestamp_ms=event_timestamp_ms+1", "org_id=gen_random_uuid()"]) {
        expect((await attempt(`update public.dialpad_call_events set ${column} where id=$1`)).message, column).toMatch(/immutable|foreign key|check constraint/);
      }
      expect((await attempt("delete from public.dialpad_call_events where id=$1")).message).toMatch(/cannot be deleted/);
      expect((await attempt("update public.dialpad_call_events set disposition='matched' where id=$1")).code).toBe("23514");
      await match(event);
      expect((await attempt("update public.dialpad_call_events set disposition='received', disposition_reason=null where id=$1")).message).toMatch(/return to received|terminal|quarantined/);
    });
  });

  describe("matching", () => {
    async function preparedIntent(options: PrepareOptions = {}): Promise<Intent> {
      return prepare(options);
    }

    it("matches on custom_data, the verified Dialpad user and the frozen number, once", async () => {
      const intent = await preparedIntent();
      const result = await ingestAndMatch(eventPayload({ custom_data: String(intent.customData), }));
      expect(result).toMatchObject({ disposition: "matched", intentId: intent.intentId, reason: null, replayed: false });
      const stored = await service(() =>
        pg.query("select status, matched_provider_call_id, matched_event_id from public.dialpad_call_intents where id=$1", [intent.intentId]),
      );
      expect(stored.rows[0]).toMatchObject({ status: "matched", matched_provider_call_id: "1234567890" });
      const again = await match(String(result.eventId));
      expect(again).toMatchObject({ disposition: "matched", replayed: true });
    });

    it("matches later events for the same call through the recorded provider call id", async () => {
      const intent = await preparedIntent();
      const first = await ingestAndMatch(eventPayload({ custom_data: String(intent.customData), state: "calling" }));
      expect(first.disposition).toBe("matched");
      const connected = await ingestAndMatch(eventPayload({ state: "connected", event_timestamp: NOW_MS + 4000 }));
      expect(connected).toMatchObject({ disposition: "matched", intentId: intent.intentId });
      const hangup = await ingestAndMatch(eventPayload({ state: "hangup", event_timestamp: NOW_MS + 60000, target: { type: "user", id: Number(DIALPAD_REP_B) } }));
      expect(hangup).toMatchObject({ disposition: "quarantined", reason: "target_mismatch" });
    });

    it("quarantines without credit on unknown custom data, wrong user, wrong number and wrong target type", async () => {
      const intent = await preparedIntent();
      const custom = String(intent.customData);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ custom_data: `sandra.dialpad.v1.${"f".repeat(48)}` }, "unknown_custom_data"],
        [{ custom_data: custom, target: { type: "user", id: Number(DIALPAD_REP_B) }, state: "s1" }, "target_mismatch"],
        [{ custom_data: custom, target: { type: "callcenter", id: Number(DIALPAD_REP_A) }, state: "s2" }, "target_mismatch"],
        [{ custom_data: custom, target: undefined, state: "s3" }, "target_mismatch"],
        [{ custom_data: custom, external_number: "+18165559999", state: "s4" }, "number_mismatch"],
        [{ custom_data: custom, event_timestamp: NOW_MS + 3_600_000, state: "s5" }, "outside_intent_window"],
        [{ custom_data: custom, event_timestamp: NOW_MS - 60_000, state: "s6" }, "outside_intent_window"],
      ];
      for (const [overrides, reason] of cases) {
        const result = await ingestAndMatch(eventPayload(overrides));
        expect(result, reason).toMatchObject({ disposition: "quarantined", reason, intentId: null });
      }
      const stored = await service(() => pg.query("select status, matched_provider_call_id from public.dialpad_call_intents where id=$1", [intent.intentId]));
      expect(stored.rows[0]).toEqual({ status: "prepared", matched_provider_call_id: null });
    });

    it("quarantines an event without custom_data and no known call, then links it after the call is matched", async () => {
      const intent = await preparedIntent();
      const early = await ingest(eventPayload({ state: "ringing", event_timestamp: NOW_MS + 500 }));
      expect(await match(String(early.eventId))).toMatchObject({ disposition: "quarantined", reason: "no_custom_data" });
      const first = await ingestAndMatch(eventPayload({ custom_data: String(intent.customData), state: "calling" }));
      expect(first.disposition).toBe("matched");
      expect(await match(String(early.eventId))).toMatchObject({ disposition: "matched", intentId: intent.intentId, replayed: false });
    });

    it("uses each intent for one provider call only", async () => {
      const intent = await preparedIntent();
      const custom = String(intent.customData);
      expect((await ingestAndMatch(eventPayload({ custom_data: custom, call_id: 111 }))).disposition).toBe("matched");
      const second = await ingestAndMatch(eventPayload({ custom_data: custom, call_id: 222, state: "calling" }));
      expect(second).toMatchObject({ disposition: "quarantined", reason: "intent_already_matched" });
      const single = await service(() => pg.query("select count(*)::int as n from public.dialpad_call_intents where matched_provider_call_id is not null"));
      expect(single.rows[0].n).toBe(1);
    });

    it("never matches a cancelled intent or one whose binding was revoked before use", async () => {
      const cancelled = await preparedIntent();
      await service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repA, cancelled.intentId]));
      expect(await ingestAndMatch(eventPayload({ custom_data: String(cancelled.customData) }))).toMatchObject({ reason: "intent_cancelled" });
      const other = await preparedIntent({ slot: 2 });
      await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded')", [bindingA]));
      expect(await ingestAndMatch(eventPayload({ custom_data: String(other.customData), call_id: 777, external_number: "+18165550143" }))).toMatchObject({
        disposition: "quarantined",
        reason: "intent_cancelled",
      });
    });

    it("keeps credit with the frozen rep after the lead is reassigned mid-call", async () => {
      const intent = await preparedIntent();
      const first = await ingestAndMatch(eventPayload({ custom_data: String(intent.customData) }));
      expect(first.disposition).toBe("matched");
      await pg.query("update public.properties set assigned_user_id=$1 where id=$2", [repB, propertyId]);
      const later = await ingestAndMatch(eventPayload({ state: "hangup", event_timestamp: NOW_MS + 30_000 }));
      expect(later).toMatchObject({ disposition: "matched", intentId: intent.intentId });
      const stored = await service(() => pg.query("select rep_user_id from public.dialpad_call_intents where id=$1", [intent.intentId]));
      expect(stored.rows[0].rep_user_id).toBe(repA);
    });

    it("never leaks a match across organizations", async () => {
      const intent = await preparedIntent();
      const otherConnection = await service(() =>
        pg.query<{ id: string }>(
          "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','other','ref') returning id",
          [otherOrgId],
        ),
      );
      const foreign = await ingest(eventPayload({ custom_data: String(intent.customData) }), otherOrgId, otherConnection.rows[0]!.id);
      expect(await match(String(foreign.eventId))).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data" });
      const stored = await service(() => pg.query("select status from public.dialpad_call_intents where id=$1", [intent.intentId]));
      expect(stored.rows[0].status).toBe("prepared");
    });
  });
});

/**
 * Two-client interleavings need committed rows, so this block seeds real data,
 * runs the revoke and prepare transactions on separate connections, and removes
 * its org, users and rows afterwards (replica role: the CTI tables are
 * append-only by trigger). Scratch database only.
 */
describe("20260929034021 prepare versus revoke serialization", () => {
  let c1: Client;
  let c2: Client;
  let admin: Client;
  const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
  let grantId = "";

  const url = () => requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);

  async function begin(client: Client): Promise<void> {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  }

  const callPrepare = (client: Client, key: string, grant: string | null) =>
    client.query("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,$6,600) as v", [orgId, repA, propertyId, contactId, key, grant]);

  async function waitUntilBlocked(client: Client, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await client.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never blocked on a lock`);
  }

  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: PgError) => ({ ok: false as const, error }),
    );

  async function preparedCount(): Promise<number> {
    const result = await admin.query("select count(*)::int as n from public.dialpad_call_intents where org_id=$1 and status='prepared'", [orgId]);
    return result.rows[0].n as number;
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: url() });
    c1 = new Client({ connectionString: url() });
    c2 = new Client({ connectionString: url() });
    await Promise.all([pg.connect(), c1.connect(), c2.connect()]);
    admin = pg;
    await pg.query(migrationSql);
  });

  afterAll(async () => {
    await Promise.all([c1.query("rollback"), c2.query("rollback")]).catch(() => undefined);
    await pg.query("rollback").catch(() => undefined);
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    const tables = await pg.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema='public' and c.column_name='org_id' and t.table_type='BASE TABLE'`,
    );
    for (const org of created.orgs) {
      for (const { table_name } of tables.rows) await pg.query(`delete from public.${table_name} where org_id=$1`, [org]);
      await pg.query("delete from public.organizations where id=$1", [org]);
    }
    for (const user of created.users) await pg.query("delete from auth.users where id=$1", [user]);
    await pg.query("commit");
    await Promise.all([c1.end(), c2.end(), pg.end()]);
  });

  beforeEach(async () => {
    NOW_MS = Date.now();
    await pg.query("begin");
    await seedFixture();
    grantId = await grantCaller(repA);
    await pg.query("commit");
    created.orgs.push(orgId, otherOrgId);
    created.users.push(ownerId, repA, repB, otherRep);
  });

  afterEach(async () => {
    await Promise.all([c1.query("rollback"), c2.query("rollback")]);
  });

  it("makes a binding revoke wait for an in-flight prepare, then cancels that new intent", async () => {
    const revokerPid = (await c2.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c1);
    await callPrepare(c1, uuid(), grantId);
    await begin(c2);
    const revoke = settle(c2.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded') as v", [bindingA]));
    await waitUntilBlocked(admin, revokerPid);
    await c1.query("commit");
    const outcome = await revoke;
    expect(outcome.ok && outcome.value.rows[0].v).toMatchObject({ status: "revoked", cancelledIntents: 1 });
    await c2.query("commit");
    expect(await preparedCount()).toBe(0);
  });

  it("makes a prepare that races a committed binding revoke fail instead of creating a prepared intent", async () => {
    const preparerPid = (await c1.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c2);
    await c2.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded')", [bindingA]);
    await begin(c1);
    const preparing = settle(callPrepare(c1, uuid(), grantId));
    await waitUntilBlocked(admin, preparerPid);
    await c2.query("commit");
    const outcome = await preparing;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "42501", detail: "binding_not_verified" });
    await c1.query("rollback");
    expect(await preparedCount()).toBe(0);
  });

  it("makes a grant revoke wait for an in-flight prepare, then cancels that new intent", async () => {
    const revokerPid = (await c2.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c1);
    await callPrepare(c1, uuid(), grantId);
    await begin(c2);
    const revoke = settle(c2.query("select public.fn_revoke_dialpad_caller_grant($1,$2) as v", [grantId, ownerId]));
    await waitUntilBlocked(admin, revokerPid);
    await c1.query("commit");
    const outcome = await revoke;
    expect(outcome.ok && outcome.value.rows[0].v).toMatchObject({ cancelledIntents: 1, replayed: false });
    await c2.query("commit");
    expect(await preparedCount()).toBe(0);
  });

  it("makes a prepare that races a committed grant revoke fail instead of creating a prepared intent", async () => {
    const preparerPid = (await c1.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c2);
    await c2.query("select public.fn_revoke_dialpad_caller_grant($1,$2)", [grantId, ownerId]);
    await begin(c1);
    const preparing = settle(callPrepare(c1, uuid(), grantId));
    await waitUntilBlocked(admin, preparerPid);
    await c2.query("commit");
    const outcome = await preparing;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "42501", detail: "caller_grant_unavailable" });
    await c1.query("rollback");
    expect(await preparedCount()).toBe(0);
  });
});
