import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Local-only migration test for the Dialpad CTI custom_data normalizer. Run with
 * `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch db> npm run test:integration:local`.
 * It rejects non-loopback URLs and is excluded from `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const readSql = (name: string) => readFileSync(path.resolve(__dirname, name), "utf8");
const foundationSql = readSql("20260929034021_dialpad_cti_foundation.sql");
const projectionSql = readSql("20260929120000_dialpad_cti_call_projection.sql");
const dispatchSql = readSql("20260929180000_dialpad_cti_dispatch.sql");
const customDataSql = readSql("20260929200000_dialpad_cti_custom_data.sql");

const uuid = () => crypto.randomUUID();
const DIALPAD_REP_A = "5150000000000001";
const DIALPAD_TRANSFEREE = "5150000000000009";
const ROOT_CALL = "6543210987654321098";
const LEG_CALL = "6543210987654321099";
const OTHER_CALL = "6543210987654321100";
let NOW_MS = Date.now();

let pg: Client;
let orgId = "";
let otherOrgId = "";
let ownerId = "";
let repA = "";
let otherRep = "";
let contactId = "";
let propertyId = "";
let connectionId = "";
let otherConnectionId = "";

interface PgError extends Error {
  code?: string;
}

type Json = Record<string, unknown>;

async function service<T>(run: () => Promise<T>): Promise<T> {
  await pg.query("set local role service_role");
  await pg.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return await run();
  } finally {
    await pg.query("reset role").catch(() => undefined);
  }
}

async function asRole<T>(role: "anon" | "authenticated", run: () => Promise<T>): Promise<T> {
  await pg.query(`set local role ${role}`);
  try {
    return await run();
  } finally {
    await pg.query("reset role").catch(() => undefined);
  }
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

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const result = await pg.query<{ n: string }>(`select count(*)::text as n from public.${table} where ${where}`, params);
  return Number(result.rows[0]!.n);
}

async function seedFixture(): Promise<void> {
  orgId = uuid();
  otherOrgId = uuid();
  ownerId = uuid();
  repA = uuid();
  otherRep = uuid();
  contactId = uuid();
  propertyId = uuid();
  for (const id of [ownerId, repA, otherRep]) await pg.query("insert into auth.users(id) values ($1)", [id]);
  await pg.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `CTI ${orgId}`, otherOrgId, `CTI ${otherOrgId}`]);
  await service(async () => {
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [repA, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, otherOrgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [otherRep, otherOrgId]);
  });
  await service(async () => {
    await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [orgId, repA]);
    await pg.query("update public.memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2", [orgId, repA]);
    await pg.query("select set_config('my_leads.designation_update', '', true)");
  });
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true),($2,true)", [orgId, otherOrgId]);
  await pg.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller','(816) 555-0142','mobile')",
    [contactId, orgId],
  );
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 CTI Way','MO',$3,$4)",
    [propertyId, orgId, contactId, repA],
  );
  await service(async () => {
    const connection = await pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref) values ($1,'active','client_abc','env:DIALPAD_CTI_WEBHOOK_SECRET_A','4040404040404040','env:DIALPAD_CTI_DIRECTORY_KEY_A') returning id",
      [orgId],
    );
    connectionId = connection.rows[0]!.id;
    const other = await pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref) values ($1,'active','client_def','env:DIALPAD_CTI_WEBHOOK_SECRET_B','4040404040404041','env:DIALPAD_CTI_DIRECTORY_KEY_B') returning id",
      [otherOrgId],
    );
    otherConnectionId = other.rows[0]!.id;
    const claim = await pg.query<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [orgId, repA, DIALPAD_REP_A]);
    await pg.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','test-attestation')", [claim.rows[0]!.v.bindingId]);
  });
}

async function prepare(ttl = 600): Promise<Json> {
  const result = await service(() =>
    pg.query<{ v: Json }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,$6) as v", [orgId, repA, propertyId, contactId, uuid(), ttl]),
  );
  return result.rows[0]!.v;
}

const wrap = (token: unknown): Json => ({ open_cti: token });

interface CallEvent {
  callId?: string;
  master?: string;
  state: string;
  at: number;
  /** undefined omits custom_data entirely; anything else is serialized as the raw JSON value. */
  custom?: unknown;
  target?: string;
  external?: string;
  extra?: Json;
}

function payload(event: CallEvent): string {
  const body: Json = {
    state: event.state,
    event_timestamp: event.at,
    external_number: event.external ?? "+18165550142",
    internal_number: "+18165550100",
    direction: "outbound",
    target: { type: "user", id: "__TARGET__" },
    ...(event.custom === undefined ? {} : { custom_data: event.custom }),
    ...(event.extra ?? {}),
  };
  return JSON.stringify(body)
    .replace('"__TARGET__"', event.target ?? DIALPAD_REP_A)
    .replace(/^\{/, `{"call_id":${event.callId ?? ROOT_CALL},${event.master ? `"master_call_id":${event.master},` : ""}`);
}

type Processed = { eventId: string; disposition: string; intentId: string | null; reason: string | null; projected: boolean; replayed: boolean };

async function deliver(event: CallEvent, org = orgId, connection = connectionId): Promise<Processed> {
  const ingested = await service(() =>
    pg.query<{ v: { eventId: string } }>("select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v", [org, connection, payload(event)]),
  );
  const processed = await service(() => pg.query<{ v: Processed }>("select public.fn_process_dialpad_call_event($1) as v", [ingested.rows[0]!.v.eventId]));
  return processed.rows[0]!.v;
}

function answeredCall(custom: unknown, callId = ROOT_CALL): CallEvent[] {
  const start = NOW_MS + 1000;
  const common = { callId, custom, extra: { date_started: start } };
  return [
    { ...common, state: "calling", at: start },
    { ...common, state: "connected", at: start + 4000, extra: { date_started: start, date_connected: start + 4000 } },
    {
      ...common,
      state: "hangup",
      at: start + 64_000,
      extra: { date_started: start, date_connected: start + 4000, date_ended: start + 64_000, talk_time: 60_000, was_recorded: true },
    },
  ];
}

function rootEvents(custom: unknown): CallEvent[] {
  const start = NOW_MS + 1000;
  return [
    { state: "calling", at: start, custom, extra: { date_started: start } },
    { state: "connected", at: start + 3000, custom, extra: { date_started: start, date_connected: start + 3000 } },
    {
      state: "hangup",
      at: start + 33_000,
      custom,
      extra: { date_started: start, date_connected: start + 3000, date_ended: start + 33_000, talk_time: 30_000, is_transferred: true },
    },
  ];
}

function legEvents(custom: unknown): CallEvent[] {
  const start = NOW_MS + 34_000;
  const base = { callId: LEG_CALL, master: ROOT_CALL, custom, target: DIALPAD_TRANSFEREE };
  return [
    { ...base, state: "connected", at: start + 2000, extra: { date_started: start, date_connected: start + 2000 } },
    { ...base, state: "hangup", at: start + 47_000, extra: { date_started: start, date_connected: start + 2000, date_ended: start + 47_000, talk_time: 45_000, was_recorded: true } },
  ];
}

async function summary(): Promise<Json> {
  const activities = await pg.query("select * from public.call_activities where org_id=$1 order by created_at", [orgId]);
  const attempts = await pg.query("select * from public.acquisition_attempts where org_id=$1 order by created_at", [orgId]);
  return {
    activities: activities.rows.map((row) => ({
      provider_call_id: row.provider_call_id,
      operator: row.operator_user_id === repA ? "repA" : row.operator_user_id,
      outcome: row.outcome,
      talk_duration_seconds: row.talk_duration_seconds,
      duration_seconds: row.duration_seconds,
      raw_event_count: row.raw_event_count,
      ended: row.ended_at !== null,
      recording_expected: row.recording_expected,
    })),
    attempts: attempts.rows.map((row) => ({ actor: row.actor_user_id === repA ? "repA" : row.actor_user_id, source: row.source, outcome: row.outcome })),
  };
}

async function noCredit(): Promise<void> {
  expect(await count("call_activities", "org_id=$1", [orgId])).toBe(0);
  expect(await count("acquisition_attempts", "org_id=$1", [orgId])).toBe(0);
  expect(await count("dialpad_call_intents", "org_id=$1 and matched_provider_call_id is not null", [orgId])).toBe(0);
}

const MALFORMED: Array<[string, unknown]> = [
  ["extra sibling key", { open_cti: "__TOKEN__", note: "x" }],
  ["extra key of the wrong type", { open_cti: "__TOKEN__", extra: null }],
  ["nested object value", { open_cti: { open_cti: "__TOKEN__" } }],
  ["doubly wrapped", { open_cti: { open_cti: { open_cti: "__TOKEN__" } } }],
  ["array value", { open_cti: ["__TOKEN__"] }],
  ["null value", { open_cti: null }],
  ["numeric value", { open_cti: 12345 }],
  ["boolean value", { open_cti: true }],
  ["empty string value", { open_cti: "" }],
  ["empty object", {}],
  ["array of the token", ["__TOKEN__"]],
  ["array of the wrapper", [{ open_cti: "__TOKEN__" }]],
  ["upper-case alias", { OPEN_CTI: "__TOKEN__" }],
  ["camel-case alias", { openCti: "__TOKEN__" }],
  ["snake alias for the field itself", { custom_data: "__TOKEN__" }],
  ["number", 42],
  ["boolean", true],
];

const resolveMalformed = (shape: unknown, token: unknown): unknown => JSON.parse(JSON.stringify(shape).replaceAll("__TOKEN__", String(token)));

describe("20260929200000 Dialpad CTI custom_data normalizer migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl) });
    await pg.connect();
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(dispatchSql);
    await pg.query(customDataSql);
    await pg.query(customDataSql);
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

  describe("dialpad_cti_custom_data", () => {
    const normalize = async (json: string | null) =>
      (await pg.query<{ present: boolean; value: string | null }>("select present, value from public.dialpad_cti_custom_data($1::jsonb)", [json])).rows[0]!;

    it("accepts a nonempty exact string and a single-key open_cti wrapper of a nonempty string", async () => {
      expect(await normalize('"sandra.dialpad.v1.abc"')).toEqual({ present: true, value: "sandra.dialpad.v1.abc" });
      expect(await normalize('{"open_cti":"sandra.dialpad.v1.abc"}')).toEqual({ present: true, value: "sandra.dialpad.v1.abc" });
      expect(await normalize('{"open_cti":" padded "}')).toEqual({ present: true, value: " padded " });
    });

    it("treats a missing, JSON null or empty-string custom_data as absent, as before", async () => {
      for (const absent of [null, "null", '""']) expect(await normalize(absent)).toEqual({ present: false, value: null });
    });

    it("marks every other shape present-but-malformed with no value", async () => {
      for (const [, shape] of MALFORMED) expect(await normalize(JSON.stringify(shape))).toEqual({ present: true, value: null });
      for (const raw of ["[]", "0", "false", '{"open_cti":"a","open_cti2":"b"}']) expect(await normalize(raw)).toEqual({ present: true, value: null });
    });

    it("is not reachable by anon or authenticated, and the matchers stay service_role only", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        expect((await failure(() => asRole(role, () => pg.query("select * from public.dialpad_cti_custom_data('\"x\"'::jsonb)")))).code).toBe("42501");
        expect((await failure(() => asRole(role, () => pg.query("select public.fn_match_dialpad_call_event($1)", [uuid()])))).code).toBe("42501");
        expect((await failure(() => asRole(role, () => pg.query("select public.dialpad_cti_resolve_event($1)", [uuid()])))).code).toBe("42501");
      }
      const grants = await pg.query<{ grantee: string }>(
        "select distinct grantee from information_schema.routine_privileges where routine_schema='public' and routine_name='fn_match_dialpad_call_event' and grantee <> 'postgres'",
      );
      expect(grants.rows.map((row) => row.grantee)).toEqual(["service_role"]);
    });
  });

  describe("a normal call with the observed wrapped signed shape", () => {
    it("matches, projects one activity and one pending attempt, and equals the plain-string projection", async () => {
      const wrapped = await prepare();
      const results: Processed[] = [];
      for (const event of answeredCall(wrap(wrapped.customData))) results.push(await deliver(event));
      expect(results.map((r) => r.disposition)).toEqual(["matched", "matched", "matched"]);
      expect(results.every((r) => r.intentId === wrapped.intentId && r.projected)).toBe(true);
      const wrappedSummary = await summary();
      expect(wrappedSummary).toMatchObject({
        activities: [{ provider_call_id: ROOT_CALL, operator: "repA", talk_duration_seconds: 60, duration_seconds: 64, raw_event_count: 3, ended: true, recording_expected: true }],
        attempts: [{ actor: "repA", source: "dialpad", outcome: null }],
      });
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='matched' and matched_intent_id=$2", [orgId, wrapped.intentId])).toBe(3);

      await pg.query("rollback");
      await pg.query("begin");
      await seedFixture();
      NOW_MS = Date.now();
      const plain = await prepare();
      for (const event of answeredCall(String(plain.customData))) expect((await deliver(event)).disposition).toBe("matched");
      expect(await summary()).toEqual(wrappedSummary);
    });

    it("handles mixed shapes on one call: wrapped, then plain string, then absent (call-id binding)", async () => {
      const intent = await prepare();
      const [calling, connected, hangup] = answeredCall(undefined);
      expect(await deliver({ ...calling!, custom: wrap(intent.customData) })).toMatchObject({ disposition: "matched", intentId: intent.intentId });
      expect(await deliver({ ...connected!, custom: String(intent.customData) })).toMatchObject({ disposition: "matched", intentId: intent.intentId });
      expect(await deliver({ ...hangup!, custom: null })).toMatchObject({ disposition: "matched", intentId: intent.intentId, projected: true });
      expect(await deliver({ ...hangup!, at: hangup!.at + 1, custom: "" })).toMatchObject({ disposition: "matched" });
      expect(await deliver({ ...hangup!, at: hangup!.at + 2 })).toMatchObject({ disposition: "matched" });
      expect(await count("call_activities", "org_id=$1", [orgId])).toBe(1);
    });

    it("keeps plain-string custom_data working unchanged and a bare wrong string unknown", async () => {
      const intent = await prepare();
      expect(await deliver({ ...answeredCall(String(intent.customData))[0]! })).toMatchObject({ disposition: "matched", intentId: intent.intentId });
      const other = answeredCall(undefined, OTHER_CALL)[0]!;
      const wrong = await deliver({ ...other, custom: "sandra.dialpad.v1." + "e".repeat(48) });
      expect(wrong).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      const wrappedWrong = await deliver({ ...other, at: other.at + 1, custom: wrap("sandra.dialpad.v1." + "e".repeat(48)) });
      expect(wrappedWrong).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
    });
  });

  describe("the transfer/master path with the wrapped shape", () => {
    it("links a transferee leg carrying the wrapped token, or no token, to the originating attempt", async () => {
      for (const legCustom of [wrap("__TOKEN__"), undefined, null]) {
        await pg.query("rollback");
        await pg.query("begin");
        await seedFixture();
        NOW_MS = Date.now();
        const intent = await prepare();
        const token = String(intent.customData);
        for (const event of rootEvents(wrap(token))) expect((await deliver(event)).disposition).toBe("matched");
        const custom = legCustom && typeof legCustom === "object" ? wrap(token) : legCustom;
        const [legConnected, legHangup] = legEvents(custom);
        expect(await deliver(legConnected!)).toMatchObject({ disposition: "matched", intentId: intent.intentId, projected: true });
        expect(await deliver(legHangup!)).toMatchObject({ disposition: "matched", intentId: intent.intentId });
        expect(await summary()).toMatchObject({
          activities: [{ provider_call_id: ROOT_CALL, talk_duration_seconds: 75, raw_event_count: 5, ended: true, recording_expected: true }],
          attempts: [{ actor: "repA" }],
        });
        const legRows = await pg.query("select disposition, matched_intent_id from public.dialpad_call_events where org_id=$1 and provider_call_id=$2", [orgId, LEG_CALL]);
        expect(legRows.rows).toHaveLength(2);
        expect(legRows.rows.every((row) => row.disposition === "matched" && row.matched_intent_id === intent.intentId)).toBe(true);
      }
    });

    it("converges to the same ledger whether the leg or the root arrives first, and in reverse root order", async () => {
      const orders: Array<(events: { root: CallEvent[]; leg: CallEvent[] }) => CallEvent[]> = [
        ({ root, leg }) => [...root, ...leg],
        ({ root, leg }) => [...leg, ...root],
        ({ root, leg }) => [...leg].reverse().concat([...root].reverse()),
        ({ root, leg }) => [leg[1]!, root[2]!, leg[0]!, root[1]!, root[0]!],
      ];
      let expected: Json | undefined;
      for (const order of orders) {
        await pg.query("rollback");
        await pg.query("begin");
        await seedFixture();
        NOW_MS = Date.now();
        const intent = await prepare();
        const token = String(intent.customData);
        for (const event of order({ root: rootEvents(wrap(token)), leg: legEvents(wrap(token)) })) await deliver(event);
        const actual = await summary();
        expect(actual).toMatchObject({ activities: [{ talk_duration_seconds: 75, raw_event_count: 5, ended: true }], attempts: [{ actor: "repA" }] });
        expected ??= actual;
        expect(actual).toEqual(expected);
        expect(await count("dialpad_call_events", "org_id=$1 and disposition='quarantined'", [orgId])).toBe(0);
      }
    });

    it("quarantines a wrapped leg to a third-party number, and a wrapped leg naming another intent", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      await deliver(rootEvents(wrap(token))[0]!);
      const [legConnected] = legEvents(wrap(token));
      expect(await deliver({ ...legConnected!, at: legConnected!.at + 1, external: "+18165550999" })).toMatchObject({ disposition: "quarantined", reason: "number_mismatch", projected: false });
      expect(await deliver({ ...legConnected!, at: legConnected!.at + 2, custom: wrap("sandra.dialpad.v1." + "e".repeat(48)) })).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 1 }] });
    });

    it("quarantines a malformed leg custom_data and never re-drives it once the root matches", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      const [legConnected] = legEvents(undefined);
      for (const [index, [, shape]] of MALFORMED.entries()) {
        const early = await deliver({ ...legConnected!, at: legConnected!.at + 10 + index, custom: resolveMalformed(shape, token) });
        expect(early).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      }
      await noCredit();
      for (const event of rootEvents(wrap(token))) expect((await deliver(event)).disposition).toBe("matched");
      expect(await count("dialpad_call_events", "org_id=$1 and provider_call_id=$2 and disposition='quarantined' and disposition_reason='unknown_custom_data'", [orgId, LEG_CALL])).toBe(MALFORMED.length);
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 3, talk_duration_seconds: null, ended: false }] });

      const afterRoot = await deliver({ ...legConnected!, at: legConnected!.at + 500, custom: resolveMalformed({ open_cti: "__TOKEN__", note: "x" }, token) });
      expect(afterRoot).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 3 }] });
    });
  });

  describe("malformed custom_data is quarantined and earns no credit", () => {
    it("never matches, never binds the intent, and never falls back to the phone number or the rep", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      for (const [index, [label, shape]] of MALFORMED.entries()) {
        const first = answeredCall(undefined)[0]!;
        const result = await deliver({ ...first, at: first.at + index, custom: resolveMalformed(shape, token) });
        expect(result, label).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", intentId: null, projected: false });
      }
      await noCredit();
      expect(await count("dialpad_call_intents", "id=$1 and status='prepared'", [intent.intentId])).toBe(1);
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='quarantined'", [orgId])).toBe(MALFORMED.length);
    });

    it("does not fall through to the provider call binding once the call is already matched", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      const [calling, connected, hangup] = answeredCall(wrap(token));
      await deliver(calling!);
      for (const [index, [, shape]] of MALFORMED.entries()) {
        const result = await deliver({ ...connected!, at: connected!.at + 10 + index, custom: resolveMalformed(shape, token) });
        expect(result).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      }
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 1, talk_duration_seconds: null }] });
      expect(await deliver(connected!)).toMatchObject({ disposition: "matched" });
      expect(await deliver(hangup!)).toMatchObject({ disposition: "matched", projected: true });
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 3, talk_duration_seconds: 60, ended: true }] });
    });

    it("keeps a malformed hangup from ending or crediting a real call", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      const [calling, connected, hangup] = answeredCall(wrap(token));
      await deliver(calling!);
      await deliver(connected!);
      const before = await summary();
      expect(await deliver({ ...hangup!, custom: { open_cti: token, extra: true } })).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data" });
      expect(await summary()).toEqual(before);
    });
  });

  describe("exact user, number, expiry and intent security stays intact with the wrapped shape", () => {
    it("quarantines a wrong target user, a wrong destination number, and an event after expiry", async () => {
      const intent = await prepare(60);
      const token = String(intent.customData);
      const [calling] = answeredCall(wrap(token));
      expect(await deliver({ ...calling!, target: DIALPAD_TRANSFEREE })).toMatchObject({ disposition: "quarantined", reason: "target_mismatch" });
      expect(await deliver({ ...calling!, at: calling!.at + 1, external: "+18165550999" })).toMatchObject({ disposition: "quarantined", reason: "number_mismatch" });
      expect(await deliver({ ...calling!, at: NOW_MS + 120_000 })).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window" });
      expect(await deliver({ ...calling!, at: NOW_MS - 60_000 })).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window" });
      await noCredit();
    });

    it("quarantines a cancelled intent and another organization's token", async () => {
      const cancelled = await prepare();
      await service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repA, cancelled.intentId]));
      expect(await deliver(answeredCall(wrap(cancelled.customData))[0]!)).toMatchObject({ disposition: "quarantined", reason: "intent_cancelled" });

      const live = await prepare();
      const crossOrg = await deliver(answeredCall(wrap(live.customData))[0]!, otherOrgId, otherConnectionId);
      expect(crossOrg).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      await noCredit();
    });

    it("rejects the wrapped token replayed on a different call once the intent has matched", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      await deliver(answeredCall(wrap(token))[0]!);
      const replayed = await deliver(answeredCall(wrap(token), OTHER_CALL)[0]!);
      expect(replayed).toMatchObject({ disposition: "quarantined", reason: "intent_already_matched", projected: false });
      expect(await summary()).toMatchObject({ activities: [{ provider_call_id: ROOT_CALL, raw_event_count: 1 }] });
    });

    it("never links a wrapped leg whose master call belongs to another organization", async () => {
      const intent = await prepare();
      const token = String(intent.customData);
      await deliver(rootEvents(wrap(token))[0]!);
      const [legConnected] = legEvents(wrap(token));
      const leg = await deliver(legConnected!, otherOrgId, otherConnectionId);
      expect(leg).toMatchObject({ disposition: "quarantined", projected: false });
      expect(await summary()).toMatchObject({ activities: [{ raw_event_count: 1 }] });
    });
  });

  describe("replay, idempotency and event order with the wrapped shape", () => {
    it("treats redelivery of every wrapped event as a no-op", async () => {
      const intent = await prepare();
      const events = answeredCall(wrap(intent.customData));
      for (const event of events) await deliver(event);
      const once = await summary();
      for (const event of events) {
        const again = await service(() =>
          pg.query<{ v: { eventId: string } }>("select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v", [orgId, connectionId, payload(event)]),
        );
        const processed = await service(() => pg.query<{ v: Processed }>("select public.fn_process_dialpad_call_event($1) as v", [again.rows[0]!.v.eventId]));
        expect(processed.rows[0]!.v).toMatchObject({ disposition: "matched", replayed: true });
      }
      expect(await summary()).toEqual(once);
      expect(await count("dialpad_call_events", "org_id=$1", [orgId])).toBe(3);
      expect(await count("dialpad_call_intents", "org_id=$1 and matched_provider_call_id is not null", [orgId])).toBe(1);
    });

    it("produces the same ledger in every arrival order", async () => {
      const permutations = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1], [1, 2, 0], [0, 2, 1]];
      let expected: Json | undefined;
      for (const permutation of permutations) {
        await pg.query("rollback");
        await pg.query("begin");
        await seedFixture();
        NOW_MS = Date.now();
        const intent = await prepare();
        const events = answeredCall(wrap(intent.customData));
        for (const index of permutation) expect((await deliver(events[index]!)).disposition).toBe("matched");
        const actual = await summary();
        expect(actual).toMatchObject({ activities: [{ raw_event_count: 3, talk_duration_seconds: 60, ended: true }], attempts: [{}] });
        expected ??= actual;
        expect(actual).toEqual(expected);
      }
    });
  });
});
