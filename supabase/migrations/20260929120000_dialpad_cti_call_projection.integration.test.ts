import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyDialpadRpcError } from "../../src/lib/dialpad-cti/contracts";
import {
  DialpadDbError,
  handleDialpadVoiceWebhook,
  sweepDialpadCallEvents,
  type DialpadCtiDb,
} from "../../src/lib/dialpad-cti/event-processing";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));

/**
 * Local-only migration test for the Dialpad CTI call projection (A3). Run with
 * `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch db> npm run test:integration:local`.
 * It rejects non-loopback URLs and is excluded from `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const foundationSql = readFileSync(path.resolve(__dirname, "20260929034021_dialpad_cti_foundation.sql"), "utf8");
const projectionSql = readFileSync(path.resolve(__dirname, "20260929120000_dialpad_cti_call_projection.sql"), "utf8");

const trainingSql = readFileSync(path.resolve(__dirname, "20260930036000_dialpad_training_projection.sql"), "utf8");

const uuid = () => crypto.randomUUID();
const DIALPAD_REP_A = "5150000000000001";
const DIALPAD_TRANSFEREE = "5150000000000009";
const ROOT_CALL = "6543210987654321098";
const LEG_CALL = "6543210987654321099";
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
let otherConnectionId = "";
let bindingA = "";

const url = () => requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);

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

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const result = await pg.query<{ n: string }>(`select count(*)::text as n from public.${table} where ${where}`, params);
  return Number(result.rows[0]!.n);
}

async function setDesignation(user: string, org: string, enabled: boolean): Promise<void> {
  await service(async () => {
    await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [org, user]);
    await pg.query("update public.memberships set acquisitions_enabled=$3 where org_id=$1 and user_id=$2", [org, user, enabled]);
    await pg.query("select set_config('my_leads.designation_update', '', true)");
  });
}

async function seedFixture(training = false): Promise<void> {
  orgId = uuid();
  otherOrgId = uuid();
  ownerId = uuid();
  repA = uuid();
  repB = uuid();
  otherRep = uuid();
  contactId = uuid();
  propertyId = uuid();
  for (const id of [ownerId, repA, repB, otherRep]) await pg.query("insert into auth.users(id) values ($1)", [id]);
  await pg.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `CTI3 ${orgId}`, otherOrgId, `CTI3 ${otherOrgId}`]);
  await service(async () => {
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member'),($3,$2,'member')", [repA, orgId, repB]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, otherOrgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [otherRep, otherOrgId]);
  });
  for (const [user, org] of [[repA, orgId], [repB, orgId], [otherRep, otherOrgId]] as const) await setDesignation(user, org, true);
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true),($2,true)", [orgId, otherOrgId]);
  await pg.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller','(816) 555-0142','mobile')",
    [contactId, orgId],
  );
  if (training) {
    await service(() => pg.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id,is_training,status) values ($1,$2,'1 CTI Way','MO',$3,$4,true,'new_lead')",
      [propertyId, orgId, contactId, repA],
    ));
  } else {
    await pg.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 CTI Way','MO',$3,$4)",
      [propertyId, orgId, contactId, repA],
    );
  }
  await service(async () => {
    const a = await pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','client_abc','env:DIALPAD_CTI_WEBHOOK_SECRET_A') returning id",
      [orgId],
    );
    connectionId = a.rows[0]!.id;
    const b = await pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','client_xyz','env:DIALPAD_CTI_WEBHOOK_SECRET_B') returning id",
      [otherOrgId],
    );
    otherConnectionId = b.rows[0]!.id;
  });
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

type Intent = Record<string, string | number | null | boolean>;

async function prepare(): Promise<Intent> {
  const result = await service(() =>
    pg.query<{ v: Intent }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v", [
      orgId,
      repA,
      propertyId,
      contactId,
      uuid(),
    ]),
  );
  return result.rows[0]!.v;
}

interface CallEvent {
  callId?: string;
  state: string;
  at: number;
  custom?: string | null;
  target?: { type: string; id: string } | null;
  external?: string | null;
  master?: string;
  extra?: Record<string, unknown>;
}

function payload(event: CallEvent): string {
  const body: Record<string, unknown> = {
    state: event.state,
    event_timestamp: event.at,
    ...(event.external === null ? {} : { external_number: event.external ?? "+18165550142" }),
    internal_number: "+18165550100",
    direction: "outbound",
    ...(event.target === null ? {} : { target: { type: event.target?.type ?? "user", id: "__TARGET__" } }),
    ...(event.custom ? { custom_data: event.custom } : {}),
    ...(event.extra ?? {}),
  };
  let text = JSON.stringify(body);
  text = text.replace('"__TARGET__"', event.target?.id ?? DIALPAD_REP_A);
  text = text.replace(/^\{/, `{"call_id":${event.callId ?? ROOT_CALL},${event.master ? `"master_call_id":${event.master},` : ""}`);
  return text;
}

async function ingest(text: string, org = orgId, connection = connectionId): Promise<Record<string, string | boolean>> {
  const result = await service(() =>
    pg.query<{ v: Record<string, string | boolean> }>("select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v", [org, connection, text]),
  );
  return result.rows[0]!.v;
}

type Processed = {
  eventId: string;
  disposition: string;
  intentId: string | null;
  reason: string | null;
  projected: boolean;
  callActivityId: string | null;
  attemptId: string | null;
  replayed: boolean;
};

async function processEvent(eventId: string): Promise<Processed> {
  const result = await service(() => pg.query<{ v: Processed }>("select public.fn_process_dialpad_call_event($1) as v", [eventId]));
  return result.rows[0]!.v;
}

async function deliver(event: CallEvent, org = orgId, connection = connectionId): Promise<Processed> {
  const ingested = await ingest(payload(event), org, connection);
  return processEvent(String(ingested.eventId));
}

// The three lifecycle events of one simple, answered, recorded call.
function answeredCall(custom: string | null, o: { callId?: string; talkMs?: number } = {}): CallEvent[] {
  const start = NOW_MS + 1000;
  const common = { callId: o.callId, custom, extra: { date_started: start } };
  return [
    { ...common, state: "calling", at: start },
    { ...common, state: "connected", at: start + 4000, extra: { date_started: start, date_connected: start + 4000 } },
    {
      ...common,
      state: "hangup",
      at: start + 64_000,
      extra: { date_started: start, date_connected: start + 4000, date_ended: start + 64_000, talk_time: o.talkMs ?? 60_000, was_recorded: true },
    },
  ];
}

interface Ledger {
  activities: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
}

async function ledger(): Promise<Ledger> {
  const activities = await pg.query("select * from public.call_activities where org_id=$1 order by created_at", [orgId]);
  const attempts = await pg.query("select * from public.acquisition_attempts where org_id=$1 order by created_at", [orgId]);
  return { activities: activities.rows, attempts: attempts.rows };
}

async function kpis(user = repA): Promise<Record<string, unknown>> {
  const result = await authenticated(user, () =>
    pg.query<{ v: Record<string, unknown> }>(
      "select public.fn_get_acquisition_kpis($1,$2,now() - interval '1 day', now() + interval '1 day') as v",
      [orgId, user],
    ),
  );
  return result.rows[0]!.v;
}

async function eventRow(eventId: string): Promise<Record<string, unknown>> {
  return (await pg.query("select * from public.dialpad_call_events where id=$1", [eventId])).rows[0];
}

async function rpc<T>(sql: string, params: unknown[]): Promise<T> {
  try {
    return (await service(() => pg.query<{ v: T }>(sql, params))).rows[0]!.v;
  } catch (error) {
    const e = error as PgError;
    throw new DialpadDbError(classifyDialpadRpcError({ code: e.code, details: e.detail }), e.code ?? null);
  }
}

function pgDb(overrides: Partial<DialpadCtiDb> = {}): DialpadCtiDb {
  return {
    async loadConnection(id) {
      const r = await service(() =>
        pg.query("select id, org_id, status, webhook_secret_ref, webhook_secret_version from public.dialpad_org_connections where id=$1", [id]),
      );
      const row = r.rows[0];
      return row
        ? { id: row.id, orgId: row.org_id, status: row.status, webhookSecretRef: row.webhook_secret_ref, webhookSecretVersion: row.webhook_secret_version }
        : null;
    },
    ingest: (org, conn, version, text) => rpc("select public.fn_ingest_dialpad_call_event($1,$2,$3,$4) as v", [org, conn, version, text]),
    process: (eventId) => rpc("select public.fn_process_dialpad_call_event($1) as v", [eventId]),
    async recordProcessFailure(eventId, sqlstate) {
      await rpc("select public.fn_record_dialpad_event_process_failure($1,$2)::text as v", [eventId, sqlstate]);
    },
    listPending: (limit) => rpc("select public.fn_list_dialpad_call_events_for_processing($1) as v", [limit]),
    ...overrides,
  };
}

describe("20260929120000 Dialpad CTI call projection migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: url() });
    await pg.connect();
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(trainingSql);
    await pg.query(projectionSql);
    await pg.query(trainingSql);
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

  describe("permanent training isolation", () => {
    it("audits and repairs only the known legacy training projection with the guard restored", async () => {
      await pg.query("rollback");
      await pg.query("begin");
      await seedFixture(true);
      const intent = await prepare();
      // The legacy ledger can succeed when the queue/disposition branch is
      // skipped, as happened after production assignment cleanup.
      await pg.query("update public.acquisition_org_settings set my_leads_enabled=false where org_id=$1", [orgId]);
      const start = projectionSql.indexOf("create or replace function public.dialpad_cti_project_intent");
      await pg.query(projectionSql.slice(start, projectionSql.indexOf("\n$$;", start) + 4));
      const events = answeredCall(String(intent.customData));
      for (const event of events) await deliver(event);
      const bad = await ledger();
      expect(bad.activities[0]).toMatchObject({ call_purpose: "customer", property_id: propertyId });
      expect(bad.attempts).toHaveLength(1);
      const repair = trainingSql.slice(trainingSql.indexOf("-- BEGIN OWNED CANARY CORRECTION"), trainingSql.indexOf("-- END OWNED CANARY CORRECTION"))
        .replaceAll("724dd72e-2cc8-4103-b73f-99be89cee32a", String(intent.intentId))
        .replaceAll("db5422e7-5501-47b2-8781-2eda58524dbe", String(bad.activities[0]!.id))
        .replaceAll("f1092591-95d6-43e7-b93c-cd96fc3f0c58", String(bad.attempts[0]!.id))
        .replaceAll("00000000-0000-0000-0000-000000000bbb", orgId)
        .replaceAll("b4b8d7cb-d51e-4af8-888a-a15e07001962", propertyId)
        .replaceAll("b480bc44-8ee6-4ab4-a8c9-f88373cf7fe5", repA)
        .replaceAll("4732592345882624", ROOT_CALL);
      await pg.query("savepoint changed_repair_precondition");
      await pg.query("update public.acquisition_attempts set outcome='wrong_number' where id=$1", [bad.attempts[0]!.id]);
      expect((await failure(() => pg.query(repair))).message).toContain("preconditions changed");
      expect(await count("dialpad_training_projection_repairs", "intent_id=$1", [intent.intentId])).toBe(0);
      await pg.query("rollback to savepoint changed_repair_precondition");
      await pg.query(repair);
      await pg.query(repair);
      const fixed = await ledger();
      expect(fixed.activities).toHaveLength(1);
      expect(fixed.activities[0]).toMatchObject({ id: bad.activities[0]!.id, call_purpose: "internal_training", property_id: null, contact_id: null, ended_at: bad.activities[0]!.ended_at });
      expect(fixed.attempts).toHaveLength(0);
      const audit = (await pg.query("select * from public.dialpad_training_projection_repairs where intent_id=$1", [intent.intentId])).rows[0];
      expect(audit.activity_snapshot.call_purpose).toBe("customer");
      expect(audit.attempt_snapshot.id).toBe(bad.attempts[0]!.id);
      expect(audit.episode_snapshot).toHaveLength(1);
      expect(await count("acquisition_assignment_episodes", "org_id=$1 and first_call_provider_key is not null", [orgId])).toBe(0);
      expect((await pg.query("select tgenabled from pg_trigger where tgname='guard_homeowner_training_call' and tgrelid='public.call_activities'::regclass")).rows[0].tgenabled).toBe("O");
      expect((await failure(() => service(() => pg.query("update public.call_activities set call_purpose='customer' where id=$1", [bad.activities[0]!.id])))).code).toBe("23514");
      const patchedStart = trainingSql.indexOf("create or replace function public.dialpad_cti_project_intent");
      await pg.query(trainingSql.slice(patchedStart, trainingSql.indexOf("\n$$;", patchedStart) + 4));
      for (const event of events) await deliver(event);
      expect((await ledger()).attempts).toHaveLength(0);
    });

    it("commits training events, opens recording, and replays without customer ledger effects", async () => {
      await pg.query("rollback");
      await pg.query("begin");
      await seedFixture(true);
      const snapshot = async () => ({
        property: (await pg.query("select to_jsonb(p) as v from public.properties p where id=$1", [propertyId])).rows,
        queue: (await pg.query("select * from public.acquisition_queue_states where property_id=$1", [propertyId])).rows,
        episodes: (await pg.query("select * from public.acquisition_assignment_episodes where property_id=$1", [propertyId])).rows,
      });
      const before = await snapshot();
      const intent = await prepare();
      const events = answeredCall(String(intent.customData));
      // Reproduce the production rollback using the old function, then restore
      // the patched function in the same isolated transaction.
      await pg.query("savepoint legacy_projection");
      const legacyStart = projectionSql.indexOf("create or replace function public.dialpad_cti_project_intent");
      const legacyEnd = projectionSql.indexOf("\n$$;", legacyStart) + 4;
      await pg.query(projectionSql.slice(legacyStart, legacyEnd));
      expect((await failure(() => deliver(events[0]!))).message).toContain("TRAINING_PROTECTED");
      await pg.query("rollback to savepoint legacy_projection");
      for (const event of events.slice(0, 2)) {
        expect(await deliver(event)).toMatchObject({ disposition: "matched", projected: true, attemptId: null });
      }
      const callStatus = () => service(() => pg.query("select public.fn_get_dialpad_call_status($1,$2,$3) as v", [orgId, repA, intent.intentId]));
      expect((await callStatus()).rows[0].v).toMatchObject({ state: "connected", attemptId: null, propertyId });
      const open = () => service(() => pg.query("select public.fn_open_dialpad_recording_capture($1,$2,$3) as v", [orgId, repA, intent.intentId]));
      const opened = (await open()).rows[0].v;
      expect(opened.status).toBe("opened");
      expect((await open()).rows[0].v).toMatchObject({ status: "replayed", capture: { captureId: opened.capture.captureId } });
      expect(await deliver(events[2]!)).toMatchObject({ disposition: "matched", projected: true, attemptId: null });
      for (const event of events) await deliver(event);
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ call_purpose: "internal_training", provider: "dialpad", property_id: null, contact_id: null, operator_user_id: repA, duration_seconds: 64 });
      expect(activities[0]!.ended_at).not.toBeNull();
      expect(attempts).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
      expect((await callStatus()).rows[0].v).toMatchObject({ state: "ended", attemptId: null, callActivityId: activities[0]!.id });
      expect(await count("dialpad_recording_captures", "org_id=$1", [orgId])).toBe(1);
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='matched' and projected_at is not null", [orgId])).toBe(3);

      expect((await failure(() => service(() => pg.query("update public.properties set status='contacted' where id=$1", [propertyId])))).code).toBe("23514");
      expect((await failure(() => service(() => pg.query("update public.properties set is_training=false where id=$1", [propertyId])))).code).toBe("23514");
      expect((await failure(() => service(() => pg.query("update public.contacts set phone_1='8165559999' where id=$1", [contactId])))).code).toBe("23514");
      expect((await failure(() => service(() => pg.query("update public.call_activities set property_id=$1 where id=$2", [propertyId, activities[0]!.id])))).code).toBe("23514");
      expect((await failure(() => service(() => pg.query("update public.call_activities set call_purpose='customer' where id=$1", [activities[0]!.id])))).code).toBe("23514");
      expect((await failure(() => authenticated(repA, () => pg.query("insert into public.call_activities(org_id,provider,call_purpose,operator_user_id) values ($1,'dialpad','internal_training',$2)", [orgId, repA])))).code).toBe("42501");
    });
  });

  describe("attribution and lifecycle projection", () => {
    it("projects an answered call into one call_activity and one pending attempt from frozen intent attribution", async () => {
      const intent = await prepare();
      const results: Processed[] = [];
      for (const event of answeredCall(String(intent.customData))) results.push(await deliver(event));
      expect(results.map((r) => r.disposition)).toEqual(["matched", "matched", "matched"]);
      expect(results.every((r) => r.intentId === intent.intentId && r.projected)).toBe(true);

      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        provider: "dialpad",
        provider_call_id: ROOT_CALL,
        operator_user_id: repA,
        property_id: propertyId,
        contact_id: contactId,
        phone_e164: "+18165550142",
        direction: "outbound",
        jitter_attempt_id: `dialpad-cti:${intent.intentId}`,
        jitter_session_id: null,
        outcome: "unknown",
        talk_duration_seconds: 60,
        duration_seconds: 64,
        recording_expected: true,
        raw_event_count: 3,
      });
      expect(activities[0]!.provider_ended_at).not.toBeNull();
      expect(attempts[0]).toMatchObject({
        source: "dialpad",
        attempt_kind: "call",
        actor_user_id: repA,
        property_id: propertyId,
        assignment_episode_id: intent.assignmentEpisodeId,
        call_activity_id: activities[0]!.id,
        provider_attempt_key: `dialpad-cti:${intent.intentId}`,
        outcome: null,
      });
      const started = new Date(NOW_MS + 1000).toISOString();
      expect(new Date(activities[0]!.started_at as string).toISOString()).toBe(started);
      expect(new Date(attempts[0]!.occurred_at as string).toISOString()).toBe(started);
      const episode = (await pg.query("select * from public.acquisition_assignment_episodes where id=$1", [intent.assignmentEpisodeId])).rows[0];
      expect(episode).toMatchObject({ first_call_actor_user_id: repA, first_call_provider_key: `dialpad-cti:${intent.intentId}` });
      expect(new Date(episode.first_call_started_at).toISOString()).toBe(started);
      expect((await pg.query("select stage from public.acquisition_queue_states where property_id=$1", [propertyId])).rows[0]).toMatchObject({ stage: "contacted" });
      expect((await pg.query("select status from public.properties where id=$1", [propertyId])).rows[0].status).toBe("contacted");
      expect(await count("dialpad_call_events", "org_id=$1 and projected_at is not null", [orgId])).toBe(3);
    });

    it("keeps 64-bit call ids exact through ingest, matching and the ledger", async () => {
      const intent = await prepare();
      await deliver(answeredCall(String(intent.customData))[0]!);
      expect((await pg.query("select provider_call_id from public.dialpad_call_events where org_id=$1", [orgId])).rows[0].provider_call_id).toBe(ROOT_CALL);
      expect((await ledger()).activities[0]!.provider_call_id).toBe(ROOT_CALL);
      expect((await pg.query("select matched_provider_call_id from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0].matched_provider_call_id).toBe(ROOT_CALL);
    });

    it("produces the same ledger regardless of arrival order", async () => {
      const inOrder = await prepare();
      for (const event of answeredCall(String(inOrder.customData))) await deliver(event);
      const expected = (await ledger()).activities[0]!;

      await pg.query("rollback");
      await pg.query("begin");
      await seedFixture();
      const intent = await prepare();
      const [calling, connected, hangup] = answeredCall(String(intent.customData), { callId: ROOT_CALL });
      // Later lifecycle states arrive first and carry no custom_data at all.
      const early = await deliver({ ...hangup!, custom: null });
      const middle = await deliver({ ...connected!, custom: null });
      expect([early.disposition, early.reason]).toEqual(["quarantined", "no_custom_data"]);
      expect(middle.disposition).toBe("quarantined");
      expect(await count("call_activities", "org_id=$1", [orgId])).toBe(0);
      const last = await deliver(calling!);
      expect(last).toMatchObject({ disposition: "matched", projected: true });

      const after = await ledger();
      expect(after.activities).toHaveLength(1);
      expect(after.attempts).toHaveLength(1);
      const actual = after.activities[0]!;
      for (const column of ["started_at", "ended_at", "provider_ended_at", "duration_seconds", "talk_duration_seconds", "outcome", "raw_event_count", "recording_expected", "provider_call_id"]) {
        expect(actual[column], column).toEqual(expected[column]);
      }
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='matched' and projected_at is not null", [orgId])).toBe(3);
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='quarantined'", [orgId])).toBe(0);
    });

    it("treats an exact redelivery as a replay and a same-key different payload as a never-projected conflict", async () => {
      const intent = await prepare();
      const [calling] = answeredCall(String(intent.customData));
      const first = await ingest(payload(calling!));
      expect((await processEvent(String(first.eventId))).projected).toBe(true);
      const again = await ingest(payload(calling!));
      expect(again).toMatchObject({ eventId: first.eventId, replayed: true });
      expect(await processEvent(String(again.eventId))).toMatchObject({ disposition: "matched", projected: false, replayed: true });

      const conflicting = await ingest(payload({ ...calling!, extra: { ...calling!.extra, date_started: NOW_MS + 2 } }));
      expect(conflicting).toMatchObject({ disposition: "conflict", conflict: true });
      expect(await processEvent(String(conflicting.eventId))).toMatchObject({ disposition: "conflict", projected: false });

      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]!.raw_event_count).toBe(1);
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='conflict' and projected_at is null", [orgId])).toBe(1);
    });

    it("does not let a replay undo a rep's later change to property status or the rep-selected outcome", async () => {
      const intent = await prepare();
      const [calling, connected, hangup] = answeredCall(String(intent.customData));
      await deliver(calling!);
      const activityId = String((await ledger()).activities[0]!.id);
      await authenticated(repA, () =>
        pg.query("select public.fn_finalize_acquisition_attempt($1::jsonb)", [
          JSON.stringify({ orgId, propertyId, callActivityId: activityId, idempotencyKey: uuid(), outcome: "reached", note: "spoke to seller" }),
        ]),
      );
      await pg.query("update public.properties set status='new_lead' where id=$1", [propertyId]);
      await deliver(connected!);
      await deliver(hangup!);
      expect((await pg.query("select status from public.properties where id=$1", [propertyId])).rows[0].status).toBe("new_lead");
      const { attempts } = await ledger();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: "reached", note: "spoke to seller" });
    });
  });

  describe("durable processing and replay", () => {
    it("rolls a failed projection back completely and completes it exactly once on replay", async () => {
      const intent = await prepare();
      const [calling] = answeredCall(String(intent.customData));
      const ingested = await ingest(payload(calling!));
      await pg.query(
        `create or replace function public.dialpad_cti_test_interrupt() returns trigger language plpgsql as $$
         begin raise exception 'simulated interruption' using errcode = 'XX000'; end; $$`,
      );
      await pg.query("create trigger dialpad_cti_test_interrupt before insert on public.acquisition_attempts for each row execute function public.dialpad_cti_test_interrupt()");

      const error = await failure(() => processEvent(String(ingested.eventId)));
      expect(error.code).toBe("XX000");
      expect((await eventRow(String(ingested.eventId)))).toMatchObject({ disposition: "received", projected_at: null });
      expect((await pg.query("select status, matched_provider_call_id from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0]).toMatchObject({ status: "prepared", matched_provider_call_id: null });
      expect(await count("call_activities", "org_id=$1", [orgId])).toBe(0);
      const pending = await service(() => pg.query<{ v: string[] }>("select public.fn_list_dialpad_call_events_for_processing(50) as v"));
      expect(pending.rows[0]!.v).toContain(ingested.eventId);

      await pg.query("drop trigger dialpad_cti_test_interrupt on public.acquisition_attempts");
      expect(await processEvent(String(ingested.eventId))).toMatchObject({ disposition: "matched", projected: true });
      expect(await processEvent(String(ingested.eventId))).toMatchObject({ projected: false, replayed: true });
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      const after = await service(() => pg.query<{ v: string[] }>("select public.fn_list_dialpad_call_events_for_processing(50) as v"));
      expect(after.rows[0]!.v).not.toContain(ingested.eventId);
    });

    it("re-drives an event that A1 matched but never projected", async () => {
      const intent = await prepare();
      const [calling] = answeredCall(String(intent.customData));
      const ingested = await ingest(payload(calling!));
      await service(() => pg.query("select public.fn_match_dialpad_call_event($1)", [ingested.eventId]));
      expect((await eventRow(String(ingested.eventId)))).toMatchObject({ disposition: "matched", projected_at: null });
      const pending = await service(() => pg.query<{ v: string[] }>("select public.fn_list_dialpad_call_events_for_processing(50) as v"));
      expect(pending.rows[0]!.v).toContain(ingested.eventId);
      expect(await processEvent(String(ingested.eventId))).toMatchObject({ disposition: "matched", projected: true });
      expect(await count("acquisition_attempts", "org_id=$1", [orgId])).toBe(1);
    });

    it("stops re-listing an event after ten recorded failures and never lists projected or quarantined events", async () => {
      const ingested = await ingest(payload({ state: "calling", at: NOW_MS, custom: "sandra.dialpad.v1." + "0".repeat(48) }));
      for (let i = 0; i < 10; i += 1) {
        await service(() => pg.query("select public.fn_record_dialpad_event_process_failure($1,'XX000')", [ingested.eventId]));
      }
      expect(await eventRow(String(ingested.eventId))).toMatchObject({ process_attempts: 10, last_process_error: "XX000" });
      const pending = await service(() => pg.query<{ v: string[] }>("select public.fn_list_dialpad_call_events_for_processing(50) as v"));
      expect(pending.rows[0]!.v).not.toContain(ingested.eventId);

      const quarantined = await ingest(payload({ state: "calling", at: NOW_MS + 1, callId: "777", custom: "sandra.dialpad.v1." + "1".repeat(48) }));
      await processEvent(String(quarantined.eventId));
      const list = await service(() => pg.query<{ v: string[] }>("select public.fn_list_dialpad_call_events_for_processing(50) as v"));
      expect(list.rows[0]!.v).not.toContain(quarantined.eventId);
    });

    it("guards inbox evidence: bookkeeping may move forward on a matched event, evidence and projected_at reset may not", async () => {
      const intent = await prepare();
      const ingested = await ingest(payload(answeredCall(String(intent.customData))[0]!));
      await processEvent(String(ingested.eventId));
      await service(() => pg.query("select public.fn_record_dialpad_event_process_failure($1,'40001')", [ingested.eventId]));
      expect(await eventRow(String(ingested.eventId))).toMatchObject({ process_attempts: 1, disposition: "matched" });
      expect((await failure(() => service(() => pg.query("update public.dialpad_call_events set projected_at = null where id=$1", [ingested.eventId])))).code).toBe("42501");
      expect((await failure(() => service(() => pg.query("update public.dialpad_call_events set payload = '{}'::jsonb where id=$1", [ingested.eventId])))).code).toBe("42501");
      expect((await failure(() => service(() => pg.query("update public.dialpad_call_events set disposition='quarantined', disposition_reason='x' where id=$1", [ingested.eventId])))).code).toBe("42501");
    });
  });

  describe("quarantine and no phone-only fallback", () => {
    it("quarantines an unknown custom_data token without touching the ledger", async () => {
      const result = await deliver({ state: "calling", at: NOW_MS, custom: "sandra.dialpad.v1." + "a".repeat(48) });
      expect(result).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      expect(await ledger()).toEqual({ activities: [], attempts: [] });
    });

    it("never matches on phone number and rep alone: right rep and right number with no custom_data creates nothing", async () => {
      const intent = await prepare();
      const result = await deliver({ state: "calling", at: NOW_MS + 500, custom: null });
      expect(result).toMatchObject({ disposition: "quarantined", reason: "no_custom_data" });
      expect(await ledger()).toEqual({ activities: [], attempts: [] });
      expect((await pg.query("select status from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0].status).toBe("prepared");
    });

    it("quarantines a wrong target user and a wrong destination number for a valid token", async () => {
      const intent = await prepare();
      const wrongUser = await deliver({ state: "calling", at: NOW_MS + 500, custom: String(intent.customData), target: { type: "user", id: "5150000000000077" } });
      expect(wrongUser).toMatchObject({ disposition: "quarantined", reason: "target_mismatch" });
      const wrongNumber = await deliver({ state: "calling", at: NOW_MS + 501, custom: String(intent.customData), external: "+18165550999" });
      expect(wrongNumber).toMatchObject({ disposition: "quarantined", reason: "number_mismatch" });
      const wrongType = await deliver({ state: "calling", at: NOW_MS + 502, custom: String(intent.customData), target: { type: "office", id: DIALPAD_REP_A } });
      expect(wrongType).toMatchObject({ disposition: "quarantined", reason: "target_mismatch" });
      expect(await ledger()).toEqual({ activities: [], attempts: [] });
      expect((await pg.query("select status from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0].status).toBe("prepared");
    });

    it("rejects a token replayed on a different call once the intent has matched", async () => {
      const intent = await prepare();
      await deliver(answeredCall(String(intent.customData))[0]!);
      const second = await deliver({ callId: "999000111222333444", state: "calling", at: NOW_MS + 2000, custom: String(intent.customData) });
      expect(second).toMatchObject({ disposition: "quarantined", reason: "intent_already_matched" });
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
    });

    it("keeps the frozen rep as operator after their binding is revoked", async () => {
      const intent = await prepare();
      const [calling, , hangup] = answeredCall(String(intent.customData));
      await deliver(calling!);
      await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded')", [bindingA]));
      await deliver(hangup!);
      const { activities, attempts } = await ledger();
      expect(activities[0]).toMatchObject({ operator_user_id: repA, ended_at: expect.anything() });
      expect(attempts[0]).toMatchObject({ actor_user_id: repA });
    });
  });

  describe("cross-organization isolation", () => {
    it("never matches another organization's token and never projects into the wrong org", async () => {
      const intent = await prepare();
      const foreign = await deliver({ state: "calling", at: NOW_MS + 500, custom: String(intent.customData) }, otherOrgId, otherConnectionId);
      expect(foreign).toMatchObject({ disposition: "quarantined", reason: "unknown_custom_data", projected: false });
      expect(await ledger()).toEqual({ activities: [], attempts: [] });
      expect(await count("call_activities", "org_id=$1", [otherOrgId])).toBe(0);
      expect(await count("acquisition_attempts", "org_id=$1", [otherOrgId])).toBe(0);
      expect((await pg.query("select status from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0].status).toBe("prepared");
    });

    it("refuses to ingest an org's event on another org's connection", async () => {
      const error = await failure(() => ingest(payload({ state: "calling", at: NOW_MS }), orgId, otherConnectionId));
      expect(error).toMatchObject({ code: "42501", detail: "connection_inactive" });
      expect(await count("dialpad_call_events")).toBe(0);
    });

    it("does not link another org's transfer leg to this org's originating call", async () => {
      const intent = await prepare();
      await deliver(answeredCall(String(intent.customData))[0]!);
      const leg = await deliver({ callId: LEG_CALL, master: ROOT_CALL, state: "calling", at: NOW_MS + 3000, custom: null, target: { type: "user", id: DIALPAD_TRANSFEREE } }, otherOrgId, otherConnectionId);
      expect(leg).toMatchObject({ disposition: "quarantined", projected: false });
      expect(await count("call_activities", "org_id=$1", [otherOrgId])).toBe(0);
      expect((await ledger()).activities[0]!.raw_event_count).toBe(1);
    });
  });

  describe("transfers link legs to the one originating attempt", () => {
    const rootEvents = (custom: string): CallEvent[] => {
      const start = NOW_MS + 1000;
      return [
        { callId: ROOT_CALL, state: "calling", at: start, custom, extra: { date_started: start } },
        { callId: ROOT_CALL, state: "connected", at: start + 3000, custom, extra: { date_started: start, date_connected: start + 3000 } },
        {
          callId: ROOT_CALL,
          state: "hangup",
          at: start + 33_000,
          custom,
          extra: { date_started: start, date_connected: start + 3000, date_ended: start + 33_000, talk_time: 30_000, is_transferred: true },
        },
      ];
    };
    const legEvents = (): CallEvent[] => {
      const start = NOW_MS + 34_000;
      const base = { callId: LEG_CALL, master: ROOT_CALL, custom: null, target: { type: "user", id: DIALPAD_TRANSFEREE } };
      return [
        { ...base, state: "connected", at: start + 2000, extra: { date_started: start, date_connected: start + 2000 } },
        { ...base, state: "hangup", at: start + 47_000, extra: { date_started: start, date_connected: start + 2000, date_ended: start + 47_000, talk_time: 45_000, was_recorded: true } },
      ];
    };

    it("links transferee legs to the originating intent without a second attempt, summing connected time and ending only when the last leg hangs up", async () => {
      const intent = await prepare();
      const [calling, connected, rootHangup] = rootEvents(String(intent.customData));
      await deliver(calling!);
      await deliver(connected!);
      await deliver(rootHangup!);
      expect((await ledger()).activities[0]).toMatchObject({ ended_at: null, provider_ended_at: null, outcome: null, talk_duration_seconds: null });

      const [legConnected, legHangup] = legEvents();
      expect(await deliver(legConnected!)).toMatchObject({ disposition: "matched", intentId: intent.intentId, projected: true });
      expect((await ledger()).activities[0]!.ended_at).toBeNull();
      await deliver(legHangup!);

      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({ provider_call_id: ROOT_CALL, talk_duration_seconds: 75, outcome: "unknown", raw_event_count: 5, recording_expected: true });
      expect(activities[0]!.ended_at).not.toBeNull();
      expect(attempts[0]).toMatchObject({ actor_user_id: repA, assignment_episode_id: intent.assignmentEpisodeId });
      const legRows = await pg.query("select disposition, matched_intent_id, provider_call_id from public.dialpad_call_events where org_id=$1 and provider_call_id=$2", [orgId, LEG_CALL]);
      expect(legRows.rows).toHaveLength(2);
      expect(legRows.rows.every((row) => row.disposition === "matched" && row.matched_intent_id === intent.intentId)).toBe(true);
      expect(await count("dialpad_call_intents", "org_id=$1 and matched_provider_call_id is not null", [orgId])).toBe(1);
    });

    it("holds leg events that arrive before the originating call and links them once it matches", async () => {
      const intent = await prepare();
      const [legConnected, legHangup] = legEvents();
      const earlyLeg = await deliver(legConnected!);
      expect(earlyLeg).toMatchObject({ disposition: "quarantined", reason: "no_custom_data" });
      await deliver(legHangup!);
      expect(await count("call_activities", "org_id=$1", [orgId])).toBe(0);

      const [calling, connected, rootHangup] = rootEvents(String(intent.customData));
      await deliver(rootHangup!);
      await deliver(connected!);
      const last = await deliver(calling!);
      expect(last).toMatchObject({ disposition: "matched", projected: true });
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({ talk_duration_seconds: 75, raw_event_count: 5 });
      expect(activities[0]!.ended_at).not.toBeNull();
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='quarantined'", [orgId])).toBe(0);
    });

    it("quarantines a leg to a third-party number instead of crediting it to the seller call", async () => {
      const intent = await prepare();
      await deliver(rootEvents(String(intent.customData))[0]!);
      const [legConnected] = legEvents();
      const result = await deliver({ ...legConnected!, external: "+18165550999" });
      expect(result).toMatchObject({ disposition: "quarantined", reason: "number_mismatch", projected: false });
      expect((await ledger()).activities[0]!.raw_event_count).toBe(1);
    });

    it("quarantines a leg whose custom_data names a different intent", async () => {
      const intent = await prepare();
      await deliver(rootEvents(String(intent.customData))[0]!);
      const [legConnected] = legEvents();
      const result = await deliver({ ...legConnected!, custom: "sandra.dialpad.v1." + "e".repeat(48) });
      expect(result).toMatchObject({ disposition: "quarantined", projected: false });
      expect((await ledger()).activities[0]!.raw_event_count).toBe(1);
    });
  });

  describe("KPI and ledger contracts", () => {
    it("never turns provider connected time into seller-speech credit", async () => {
      const intent = await prepare();
      for (const event of answeredCall(String(intent.customData), { talkMs: 400_000 })) await deliver(event);
      const activity = (await ledger()).activities[0]!;
      expect(activity).toMatchObject({ talk_duration_seconds: 400, seller_speech_seconds_measured: null, seller_speech_seconds_estimated: null, seller_speech_confidence: null });
      await authenticated(repA, () =>
        pg.query("select public.fn_finalize_acquisition_attempt($1::jsonb)", [
          JSON.stringify({ orgId, propertyId, callActivityId: activity.id, idempotencyKey: uuid(), outcome: "reached" }),
        ]),
      );
      const result = await kpis();
      expect(result).toMatchObject({
        attempts: 1,
        reached: 1,
        pendingOutcomes: 0,
        talkTimeSamples: 1,
        averageTalkSeconds: 400,
        conversationsOverFiveMinutes: 0,
        firstCallSamples: 1,
      });
    });

    it("reports a projected attempt as a pending outcome until the rep finalizes it", async () => {
      const intent = await prepare();
      await deliver(answeredCall(String(intent.customData))[0]!);
      expect(await kpis()).toMatchObject({ attempts: 1, reached: 0, pendingOutcomes: 1 });
      const refs = await authenticated(repA, () =>
        pg.query<{ v: Array<{ id: string }> }>("select public.fn_get_acquisition_call_references($1,$2,$3) as v", [orgId, propertyId, repA]),
      );
      expect(refs.rows[0]!.v).toHaveLength(1);
      expect(refs.rows[0]!.v[0]!.id).toBe((await ledger()).activities[0]!.id);
    });

    it("lets only the frozen rep finalize a CTI attempt, and only once evidence exists", async () => {
      const intent = await prepare();
      const input = (activityId: unknown, key = uuid()) =>
        JSON.stringify({ orgId, propertyId, callActivityId: activityId, idempotencyKey: key, outcome: "no_answer" });
      expect((await failure(() => authenticated(repA, () => pg.query("select public.fn_finalize_acquisition_attempt($1::jsonb)", [input(uuid())])))).code).toBe("42501");
      await deliver(answeredCall(String(intent.customData))[0]!);
      const activityId = (await ledger()).activities[0]!.id;
      expect((await failure(() => authenticated(repB, () => pg.query("select public.fn_finalize_acquisition_attempt($1::jsonb)", [input(activityId)])))).code).toBe("42501");
      const key = uuid();
      const done = await authenticated(repA, () => pg.query<{ v: Record<string, unknown> }>("select public.fn_finalize_acquisition_attempt($1::jsonb) as v", [input(activityId, key)]));
      expect(done.rows[0]!.v).toMatchObject({ ok: true, duplicate: false });
      const replay = await authenticated(repA, () => pg.query<{ v: Record<string, unknown> }>("select public.fn_finalize_acquisition_attempt($1::jsonb) as v", [input(activityId, key)]));
      expect(replay.rows[0]!.v).toMatchObject({ duplicate: true });
      expect((await ledger()).attempts[0]!.outcome).toBe("no_answer");
    });

    it("keeps the pending-outcome rule for everything except softphone and CTI dialpad attempts", async () => {
      const attempt = (source: string, key: string | null) =>
        pg.query(
          `insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,provider_attempt_key,idempotency_key)
           values ($1,$2,$3,'call',$4,now(),$5,$6)`,
          [orgId, propertyId, repA, source, key, uuid()],
        );
      await attempt("sandra", "softphone-key");
      await attempt("dialpad", "dialpad-cti:test");
      expect((await failure(() => attempt("dialpad", null))).code).toBe("23514");
      expect((await failure(() => attempt("dialpad", "other-key"))).code).toBe("23514");
    });

    it("leaves non-Dialpad call_activities behavior untouched", async () => {
      await pg.query(
        `insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,provider)
         values ($1,$2,$3,'j1','s1','jitter'),($1,$2,$3,'sandra-x',null,'sandra_softphone')`,
        [orgId, propertyId, contactId],
      );
      expect(await count("call_activities", "org_id=$1", [orgId])).toBe(2);
      const conflict = await failure(() =>
        pg.query(
          `insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,provider)
           values ($1,$2,$3,'sandra-x','sandra_softphone')`,
          [orgId, propertyId, contactId],
        ),
      );
      expect(conflict.code).toBe("23505");
    });
  });

  describe("privileges", () => {
    it("exposes the new entry points to the service role only", async () => {
      const ingested = await ingest(payload({ state: "calling", at: NOW_MS }));
      const calls: Array<[string, unknown[]]> = [
        ["select public.fn_process_dialpad_call_event($1)", [ingested.eventId]],
        ["select public.fn_list_dialpad_call_events_for_processing(10)", []],
        ["select public.fn_record_dialpad_event_process_failure($1,'x')", [ingested.eventId]],
        ["select public.dialpad_cti_project_intent($1)", [uuid()]],
        ["select public.dialpad_cti_resolve_event($1)", [ingested.eventId]],
      ];
      for (const [sql, params] of calls) {
        expect((await failure(() => authenticated(repA, () => pg.query(sql, params)))).code, sql).toBe("42501");
        expect((await failure(() => anonymous(() => pg.query(sql, params)))).code, sql).toBe("42501");
      }
    });
  });

  describe("call longer than the intent TTL (hangup outside the prepare window)", () => {
    // prepare() uses a 600 s TTL; this call starts inside it and lasts 20 minutes.
    function longCall(custom: string, o: { callId?: string } = {}): { calling: CallEvent; connected: CallEvent; hangup: CallEvent } {
      const start = NOW_MS + 1000;
      const common = { callId: o.callId, custom, extra: { date_started: start } };
      return {
        calling: { ...common, state: "calling", at: start },
        connected: { ...common, state: "connected", at: start + 4000, extra: { date_started: start, date_connected: start + 4000 } },
        hangup: {
          ...common,
          state: "hangup",
          at: start + 1_200_000,
          extra: { date_started: start, date_connected: start + 4000, date_ended: start + 1_200_000, talk_time: 1_150_000, was_recorded: true },
        },
      };
    }

    async function expectFullyProjected(intentId: string): Promise<void> {
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        provider_call_id: ROOT_CALL,
        operator_user_id: repA,
        jitter_attempt_id: `dialpad-cti:${intentId}`,
        talk_duration_seconds: 1150,
        duration_seconds: 1200,
        raw_event_count: 3,
        outcome: "unknown",
      });
      expect(activities[0]!.ended_at).not.toBeNull();
      expect(attempts[0]).toMatchObject({ source: "dialpad", outcome: null });
      const states = await pg.query("select disposition, disposition_reason, projected_at is not null as projected from public.dialpad_call_events where provider_call_id=$1", [ROOT_CALL]);
      expect(states.rows.every((r) => r.disposition === "matched" && r.disposition_reason === null && r.projected)).toBe(true);
      expect(await kpis()).toMatchObject({ conversationsOverFiveMinutes: 0 });
    }

    it("in order: the hangup after the window is accepted because the same call is already bound", async () => {
      const intent = await prepare();
      const { calling, connected, hangup } = longCall(String(intent.customData));
      for (const event of [calling, connected, hangup]) expect((await deliver(event)).disposition).toBe("matched");
      await expectFullyProjected(String(intent.intentId));
    });

    it("hangup first: quarantined outside the window, then recovered by the in-window event with no redelivery", async () => {
      const intent = await prepare();
      const { calling, connected, hangup } = longCall(String(intent.customData));
      const early = await deliver(hangup);
      expect(early).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window", projected: false });
      expect((await ledger()).activities).toHaveLength(0);

      const bound = await deliver(calling);
      expect(bound).toMatchObject({ disposition: "matched", projected: true });
      expect(await eventRow(early.eventId)).toMatchObject({ disposition: "matched", disposition_reason: null, matched_intent_id: intent.intentId });
      expect((await ledger()).activities[0]!.ended_at).not.toBeNull();

      await deliver(connected);
      await expectFullyProjected(String(intent.intentId));
    });

    it("hangup, connected, calling: every order converges on the same projection", async () => {
      const intent = await prepare();
      const { calling, connected, hangup } = longCall(String(intent.customData));
      await deliver(hangup);
      await deliver(connected);
      const partial = (await ledger()).activities[0]!;
      expect(partial).toMatchObject({ talk_duration_seconds: 1150, duration_seconds: 1200, raw_event_count: 2 });
      expect(partial.ended_at).not.toBeNull();
      await deliver(calling);
      await expectFullyProjected(String(intent.intentId));
    });

    it("stays strict: a lone late hangup with no in-window event is never attributed and never falls back to the phone number", async () => {
      const intent = await prepare();
      const { hangup } = longCall(String(intent.customData));
      const lone = await deliver(hangup);
      expect(lone).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window" });
      expect((await ledger()).activities).toHaveLength(0);
      expect((await ledger()).attempts).toHaveLength(0);
      const noToken = await deliver({ ...hangup, custom: null, at: hangup.at + 1000 });
      expect(noToken).toMatchObject({ disposition: "quarantined", reason: "no_custom_data" });
    });

    it("stays strict: late events with the token on a different call, a wrong number or a wrong target are not recovered", async () => {
      const intent = await prepare();
      const { calling, connected, hangup } = longCall(String(intent.customData));
      const otherCall = await deliver({ ...hangup, callId: LEG_CALL });
      expect(otherCall).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window" });
      const wrongNumber = await deliver({ ...hangup, external: "+18165550199", at: hangup.at + 1 });
      expect(wrongNumber).toMatchObject({ disposition: "quarantined", reason: "number_mismatch" });
      const wrongTarget = await deliver({ ...hangup, target: { type: "user", id: DIALPAD_TRANSFEREE }, at: hangup.at + 2 });
      expect(wrongTarget).toMatchObject({ disposition: "quarantined", reason: "target_mismatch" });

      await deliver(calling);
      await deliver(connected);
      for (const rejected of [otherCall, wrongNumber, wrongTarget]) {
        expect(await eventRow(rejected.eventId)).toMatchObject({ disposition: "quarantined", matched_intent_id: null });
      }
      const { activities } = await ledger();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ ended_at: null, talk_duration_seconds: null, raw_event_count: 2 });
    });

    it("does not extend the intent window: a late token-bearing event for a second, unbound intent call is still outside it", async () => {
      const intent = await prepare();
      const { calling } = longCall(String(intent.customData));
      const expiresMs = Date.parse(String(intent.expiresAt));
      const late = await deliver({ ...calling, at: expiresMs + 60_000 });
      expect(late).toMatchObject({ disposition: "quarantined", reason: "outside_intent_window" });
      expect((await ledger()).activities).toHaveLength(0);
    });

    it("recovers a stranded hangup when the binding event was matched but its projection was interrupted, via the sweep", async () => {
      const intent = await prepare();
      const { calling, hangup } = longCall(String(intent.customData));
      const early = await deliver(hangup);
      const ingested = await ingest(payload(calling));
      // A1 matched the binding event but the run died before projection.
      await service(() => pg.query("select public.fn_match_dialpad_call_event($1)", [ingested.eventId]));
      expect(await eventRow(early.eventId)).toMatchObject({ disposition: "quarantined" });
      expect(await sweepDialpadCallEvents(pgDb(), 50)).toMatchObject({ processed: 1, failed: 0 });
      expect(await eventRow(early.eventId)).toMatchObject({ disposition: "matched" });
      expect((await ledger()).activities[0]!.ended_at).not.toBeNull();
    });
  });

  describe("signed webhook receiver against the database", () => {
    const SECRET_A = "receiver-secret-org-a-0000000001";
    const SECRET_B = "receiver-secret-org-b-0000000002";
    const env = { DIALPAD_CTI_WEBHOOK_SECRET_A: SECRET_A, DIALPAD_CTI_WEBHOOK_SECRET_B: SECRET_B };
    const b64 = (value: string) => Buffer.from(value).toString("base64url");

    function sign(text: string, secret = SECRET_A, header: object = { alg: "HS256", typ: "JWT" }): string {
      const input = `${b64(JSON.stringify(header))}.${b64(text)}`;
      return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
    }

    const post = (event: CallEvent, opts: { secret?: string; connection?: string; db?: DialpadCtiDb; header?: object } = {}) =>
      handleDialpadVoiceWebhook({
        connectionId: opts.connection ?? connectionId,
        rawBody: sign(payload(event), opts.secret ?? SECRET_A, opts.header),
        db: opts.db ?? pgDb(),
        env,
      });

    it("projects a signed lifecycle end to end with 64-bit call ids intact and no seller credit from connected time", async () => {
      const intent = await prepare();
      for (const event of answeredCall(String(intent.customData), { talkMs: 400_000 })) expect((await post(event)).status).toBe(200);
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({ provider: "dialpad", operator_user_id: repA, provider_call_id: ROOT_CALL, talk_duration_seconds: 400 });
      expect(attempts[0]).toMatchObject({ source: "dialpad", outcome: null });
      expect(await count("dialpad_call_events", "provider_call_id=$1", [ROOT_CALL])).toBe(3);
      expect(await kpis()).toMatchObject({ conversationsOverFiveMinutes: 0 });
    });

    it("rejects invalid, unsigned, alg-none and wrong-secret bodies with 401 and stores nothing", async () => {
      const intent = await prepare();
      const [calling] = answeredCall(String(intent.customData));
      const rawBodies = [
        sign(payload(calling!), "not-the-configured-secret-000"),
        payload(calling!),
        sign(payload(calling!), SECRET_A, { alg: "none" }),
        sign(payload(calling!), SECRET_A, { alg: "HS512" }),
      ];
      for (const rawBody of rawBodies) {
        expect(await handleDialpadVoiceWebhook({ connectionId, rawBody, db: pgDb(), env })).toEqual({ status: 401, body: { error: "unauthorized" } });
      }
      expect(await count("dialpad_call_events")).toBe(0);
      expect((await ledger()).activities).toHaveLength(0);
    });

    it("gives the same projection for reordered and duplicated signed deliveries", async () => {
      const intent = await prepare();
      const [calling, connected, hangup] = answeredCall(String(intent.customData));
      for (const event of [hangup!, calling!, hangup!, connected!, calling!]) expect((await post(event)).status).toBe(200);
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(await count("dialpad_call_events")).toBe(3);
      expect(activities[0]).toMatchObject({ talk_duration_seconds: 60, duration_seconds: 64, raw_event_count: 3 });
    });

    it("keeps org B out of org A: cross-org secret and cross-org token both project nothing", async () => {
      const intent = await prepare();
      const [calling] = answeredCall(String(intent.customData));
      const wrongSecret = await post(calling!, { secret: SECRET_B });
      expect(wrongSecret.status).toBe(401);
      const otherConnection = await post(calling!, { secret: SECRET_B, connection: otherConnectionId });
      expect(otherConnection.status).toBe(200);
      expect(otherConnection.body).toMatchObject({ disposition: "quarantined" });
      expect((await ledger()).activities).toHaveLength(0);
      expect(await count("dialpad_call_events", "org_id=$1 and disposition='quarantined'", [otherOrgId])).toBe(1);
      expect(await count("dialpad_call_events", "org_id=$1", [orgId])).toBe(0);
    });

    it("acknowledges after persistence when projection is interrupted and the sweep completes it exactly once", async () => {
      const intent = await prepare();
      const [calling, connected, hangup] = answeredCall(String(intent.customData));
      expect((await post(calling!)).status).toBe(200);
      const failing = pgDb({ process: async () => { throw new DialpadDbError({ kind: "unknown" }, "40P01"); } });
      for (const event of [connected!, hangup!]) {
        expect(await post(event, { db: failing })).toMatchObject({ status: 200, body: { ok: true, pendingProjection: true } });
      }
      const stalled = await pg.query("select disposition, process_attempts, last_process_error, projected_at from public.dialpad_call_events where provider_call_id=$1 order by event_timestamp_ms", [ROOT_CALL]);
      expect(stalled.rows.map((r) => [r.disposition, r.process_attempts, r.last_process_error])).toEqual([
        ["matched", 0, null],
        ["received", 1, "40P01"],
        ["received", 1, "40P01"],
      ]);
      expect((await ledger()).activities[0]).toMatchObject({ ended_at: null, talk_duration_seconds: null });

      expect(await sweepDialpadCallEvents(pgDb(), 50)).toEqual({ candidates: 2, processed: 2, failed: 0 });
      const { activities, attempts } = await ledger();
      expect(activities).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(activities[0]).toMatchObject({ talk_duration_seconds: 60, duration_seconds: 64, raw_event_count: 3 });
      expect(await sweepDialpadCallEvents(pgDb(), 50)).toEqual({ candidates: 0, processed: 0, failed: 0 });
    });

    it("keeps a signed event with no matching intent in quarantine with no phone-only fallback", async () => {
      const result = await post({ state: "calling", at: NOW_MS + 1000, custom: null });
      expect(result).toMatchObject({ status: 200, body: { disposition: "quarantined" } });
      expect((await ledger()).activities).toHaveLength(0);
      expect((await ledger()).attempts).toHaveLength(0);
    });
  });
});

describe("20260929120000 Dialpad CTI call projection concurrency", () => {
  const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
  let c1: Client;
  let c2: Client;

  async function begin(client: Client): Promise<void> {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  }

  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: PgError) => ({ ok: false as const, error }),
    );

  async function waitUntilBlocked(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pg.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never blocked on a lock`);
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: url() });
    c1 = new Client({ connectionString: url() });
    c2 = new Client({ connectionString: url() });
    await Promise.all([pg.connect(), c1.connect(), c2.connect()]);
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(trainingSql);
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
    await pg.query("commit");
    created.orgs.push(orgId, otherOrgId);
    created.users.push(ownerId, repA, repB, otherRep);
  });

  afterEach(async () => {
    await Promise.all([c1.query("rollback"), c2.query("rollback")]);
  });

  it("serializes two deliveries of the same call chain on one lock and projects a single attempt", async () => {
    await pg.query("begin");
    const intent = await prepare();
    await pg.query("commit");
    const [calling, connected] = answeredCall(String(intent.customData));
    const first = await ingest(payload(calling!));
    const second = await ingest(payload(connected!));

    const blockedPid = (await c2.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c1);
    await c1.query("select public.fn_process_dialpad_call_event($1)", [first.eventId]);
    await begin(c2);
    const racing = settle(c2.query("select public.fn_process_dialpad_call_event($1) as v", [second.eventId]));
    await waitUntilBlocked(blockedPid);
    await c1.query("commit");
    const outcome = await racing;
    expect(outcome.ok && outcome.value.rows[0].v).toMatchObject({ disposition: "matched", projected: true });
    await c2.query("commit");

    expect(await count("call_activities", "org_id=$1", [orgId])).toBe(1);
    expect(await count("acquisition_attempts", "org_id=$1", [orgId])).toBe(1);
    expect((await ledger()).activities[0]!.raw_event_count).toBe(2);
  });
});
