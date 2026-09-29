import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  parseDialpadRecordingCapture,
  parseDialpadRecordingChunkResult,
  parseDialpadRecordingClaimResult,
  parseDialpadRecordingConsumeResult,
  parseDialpadRecordingGrantResult,
  parseDialpadRecordingOpenResult,
  parseDialpadRecordingRegisterResult,
} from "../../src/lib/dialpad-recording/contracts";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Local-only migration test for the Dialpad recording foundation (R1). Run with
 * `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch db> npm run test:integration:local`.
 * It rejects non-loopback URLs and is excluded from `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const readSql = (name: string) => readFileSync(path.resolve(__dirname, name), "utf8");
const foundationSql = readSql("20260929034021_dialpad_cti_foundation.sql");
const projectionSql = readSql("20260929120000_dialpad_cti_call_projection.sql");
const dispatchSql = readSql("20260929180000_dialpad_cti_dispatch.sql");
const recordingSql = readSql("20260929210000_dialpad_recording_foundation.sql");

const uuid = () => crypto.randomUUID();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const DIALPAD_REP_A = "5150000000000001";
const ROOT_CALL = "6543210987654321098";
const HASH_A = "a".repeat(64);
let NOW_MS = Date.now();
let dbUrl = "";

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

interface PgError extends Error {
  code?: string;
  detail?: string;
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

async function withoutTriggers(sql: string, params: unknown[] = []): Promise<void> {
  await pg.query("set local session_replication_role = replica");
  await pg.query(sql, params);
  await pg.query("set local session_replication_role = origin");
}

async function setDesignation(user: string, org: string, enabled: boolean): Promise<void> {
  await service(async () => {
    await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [org, user]);
    await pg.query("update public.memberships set acquisitions_enabled=$3 where org_id=$1 and user_id=$2", [org, user, enabled]);
    await pg.query("select set_config('my_leads.designation_update', '', true)");
  });
}

async function verifiedBinding(org: string, user: string, dialpadUserId: string): Promise<string> {
  return service(async () => {
    const claim = await pg.query<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [org, user, dialpadUserId]);
    const bindingId = claim.rows[0]!.v.bindingId;
    await pg.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','test-attestation')", [bindingId]);
    return bindingId;
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
  await pg.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `REC ${orgId}`, otherOrgId, `REC ${otherOrgId}`]);
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
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 REC Way','MO',$3,$4)",
    [propertyId, orgId, contactId, repA],
  );
  const connection = await service(() =>
    pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref) values ($1,'active','client_abc','env:DIALPAD_CTI_WEBHOOK_SECRET_A','4040404040404040','env:DIALPAD_CTI_DIRECTORY_KEY_A') returning id",
      [orgId],
    ),
  );
  connectionId = connection.rows[0]!.id;
  await verifiedBinding(orgId, repA, DIALPAD_REP_A);
}

async function prepare(ttl = 600): Promise<Json> {
  const result = await service(() =>
    pg.query<{ v: Json }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,$6) as v", [orgId, repA, propertyId, contactId, uuid(), ttl]),
  );
  return result.rows[0]!.v;
}

async function authorize(intentId: unknown): Promise<Json> {
  const result = await service(() => pg.query<{ v: Json }>("select public.fn_authorize_dialpad_dispatch($1,$2,$3) as v", [orgId, repA, intentId]));
  return result.rows[0]!.v;
}

let callCounter = 0;
function payload(state: string, at: number, custom: string, extra: Record<string, unknown> = {}, callId = ROOT_CALL): string {
  const body = { state, event_timestamp: at, external_number: "+18165550142", internal_number: "+18165550100", direction: "outbound", target: { type: "user", id: "__T__" }, custom_data: custom, ...extra };
  return JSON.stringify(body).replace('"__T__"', DIALPAD_REP_A).replace(/^\{/, `{"call_id":${callId},`);
}

async function deliver(text: string): Promise<Json> {
  const ingested = await service(() => pg.query<{ v: { eventId: string } }>("select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v", [orgId, connectionId, text]));
  const processed = await service(() => pg.query<{ v: Json }>("select public.fn_process_dialpad_call_event($1) as v", [ingested.rows[0]!.v.eventId]));
  return processed.rows[0]!.v;
}

interface Call {
  intentId: string;
  custom: string;
  start: number;
  callId: string;
}

async function ringingCall(callId = ROOT_CALL): Promise<Call> {
  const intent = await prepare();
  await authorize(intent.intentId);
  const start = NOW_MS + 1000;
  const custom = String(intent.customData);
  await deliver(payload("calling", start, custom, { date_started: start }, callId));
  return { intentId: String(intent.intentId), custom, start, callId };
}

async function connectedCall(): Promise<Call> {
  callCounter += 1;
  const call = await ringingCall(callCounter === 1 ? ROOT_CALL : `65432109876543${String(callCounter).padStart(5, "0")}`);
  await deliver(payload("connected", call.start + 4000, call.custom, { date_started: call.start, date_connected: call.start + 4000 }, call.callId));
  return call;
}

async function endCall(call: Call, talkMs = 60_000): Promise<void> {
  await deliver(
    payload("hangup", call.start + 4000 + talkMs, call.custom, {
      date_started: call.start,
      date_connected: call.start + 4000,
      date_ended: call.start + 4000 + talkMs,
      talk_time: talkMs,
      was_recorded: true,
    }, call.callId),
  );
}

async function rpc(name: string, args: unknown[]): Promise<Json> {
  const marks = args.map((_, index) => `$${index + 1}`).join(",");
  const result = await service(() => pg.query<{ v: Json }>(`select public.${name}(${marks}) as v`, args));
  return result.rows[0]!.v;
}

const open = (intentId: unknown, org = orgId, rep = repA) => rpc("fn_open_dialpad_recording_capture", [org, rep, intentId]);
const mint = (captureId: unknown, hash: string, epoch = 1, ttl = 60, org = orgId, rep = repA) =>
  rpc("fn_mint_dialpad_recording_ingest_grant", [org, rep, captureId, epoch, hash, ttl]);
const consume = (hash: string, worker = "worker-1") => rpc("fn_consume_dialpad_recording_ingest_grant", [hash, worker]);
const chunk = (captureId: unknown, track: string, epoch: number, seq: number, opts: { size?: number; sha?: string; eof?: boolean } = {}) =>
  rpc("fn_record_dialpad_recording_chunk", [orgId, captureId, track, epoch, seq, opts.size ?? 1000, opts.sha ?? sha(`${track}-${epoch}-${seq}`), opts.eof ?? false]);
const claim = (worker = "worker-1", lease = 300) => rpc("fn_claim_dialpad_recording_seal_work", [worker, lease]);
const register = (captureId: unknown, token: unknown, tracks: unknown[], failureCode: string | null = null) =>
  rpc("fn_register_dialpad_recording_result", [captureId, token, JSON.stringify(tracks), failureCode]);

let tokenCounter = 0;
const nextHash = () => sha(`token-${Date.now()}-${(tokenCounter += 1)}-${uuid()}`);

async function openedCapture(): Promise<{ call: Call; captureId: string }> {
  const call = await connectedCall();
  const opened = await open(call.intentId);
  expect(opened.status).toBe("opened");
  return { call, captureId: String((opened.capture as Json).captureId) };
}

async function authorizedEpoch(captureId: string, epoch = 1): Promise<void> {
  const hash = nextHash();
  expect((await mint(captureId, hash, epoch)).status).toBe("minted");
  expect((await consume(hash)).status).toBe("consumed");
}

async function fullTrack(captureId: string, track: string, epoch = 1, chunks = 3): Promise<void> {
  for (let seq = 0; seq < chunks; seq += 1) await chunk(captureId, track, epoch, seq, { eof: seq === chunks - 1 });
}

const decoded = (track: string, epoch = 1, extra: Json = {}) => ({
  track,
  epoch,
  decodeOk: true,
  sizeBytes: 3000,
  sha256: sha(`final-${track}-${epoch}`),
  codec: "opus",
  sampleRateHz: 48000,
  channels: 1,
  decodedDurationMs: 61_000,
  ...extra,
});

async function sealedReady(): Promise<{ call: Call; captureId: string; token: string }> {
  const { call, captureId } = await openedCapture();
  await authorizedEpoch(captureId);
  await fullTrack(captureId, "tab");
  await fullTrack(captureId, "mic");
  // A complete seal requires the provider's signed hangup. A rep close while
  // the call is still connected is an explicit early stop and remains partial
  // even when both streams happen to have EOF.
  await endCall(call);
  const claimed = await claim();
  expect(claimed.status).toBe("claimed");
  return { call, captureId, token: String(claimed.claimToken) };
}

async function captureRow(captureId: unknown): Promise<Json> {
  return (await pg.query("select * from public.dialpad_recording_captures where id=$1", [captureId])).rows[0];
}

async function callRecording(activityId: unknown): Promise<Json | undefined> {
  return (await pg.query("select * from public.call_recordings where call_activity_id=$1", [activityId])).rows[0];
}

describe("20260929210000 Dialpad recording foundation migration", () => {
  beforeAll(async () => {
    dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);
    pg = new Client({ connectionString: dbUrl });
    await pg.connect();
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(dispatchSql);
    await pg.query(recordingSql);
    await pg.query(recordingSql);
  });

  afterAll(async () => {
    await pg.end();
  });

  beforeEach(async () => {
    await pg.query("begin");
    NOW_MS = Date.now();
    callCounter = 0;
    await seedFixture();
  });

  afterEach(async () => {
    await pg.query("rollback");
    await pg.query("reset role");
  });

  describe("privileges, bucket and browser access", () => {
    it("exposes every recording function to service_role only", async () => {
      const grants = await pg.query<{ grantee: string; routine_name: string }>(
        "select distinct grantee, routine_name from information_schema.routine_privileges where routine_schema='public' and routine_name like '%dialpad_recording%' and grantee <> 'postgres'",
      );
      expect(grants.rows.length).toBeGreaterThan(0);
      expect(new Set(grants.rows.map((row) => row.grantee))).toEqual(new Set(["service_role"]));
      expect(grants.rows.map((row) => row.routine_name).sort()).toEqual(
        [
          "dialpad_recording_capture_prefix",
          "dialpad_recording_chunk_path",
          "dialpad_recording_final_path",
          "fn_claim_dialpad_recording_seal_work",
          "fn_close_dialpad_recording_capture",
          "fn_consume_dialpad_recording_ingest_grant",
          "fn_get_dialpad_recording_capture",
          "fn_mint_dialpad_recording_ingest_grant",
          "fn_open_dialpad_recording_capture",
          "fn_record_dialpad_recording_chunk",
          "fn_register_dialpad_recording_result",
        ].sort(),
      );
      const { captureId } = await openedCapture();
      for (const wrap of [(run: () => Promise<unknown>) => authenticated(repA, run), (run: () => Promise<unknown>) => anonymous(run)]) {
        expect((await failure(() => wrap(() => pg.query("select public.fn_open_dialpad_recording_capture($1,$2,$3)", [orgId, repA, uuid()])))).code).toBe("42501");
        expect((await failure(() => wrap(() => pg.query("select public.fn_consume_dialpad_recording_ingest_grant($1,'w')", [HASH_A])))).code).toBe("42501");
        expect((await failure(() => wrap(() => pg.query("select public.fn_claim_dialpad_recording_seal_work('w',300)")))).code).toBe("42501");
        expect((await failure(() => wrap(() => pg.query("select public.dialpad_recording_publish_call_row($1,'available','x',1,null,null)", [captureId])))).code).toBe("42501");
      }
    });

    it("gives browser roles no table privilege or policy on any recording table", async () => {
      await openedCapture();
      for (const table of ["captures", "segments", "chunks", "track_finals", "ingest_grants"]) {
        for (const wrap of [(run: () => Promise<unknown>) => authenticated(repA, run), (run: () => Promise<unknown>) => anonymous(run)]) {
          expect((await failure(() => wrap(() => pg.query(`select * from public.dialpad_recording_${table}`)))).code).toBe("42501");
        }
        const rls = await pg.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = ('public.dialpad_recording_' || $1)::regclass", [table]);
        expect(rls.rows[0]!.relrowsecurity).toBe(true);
        const policies = await pg.query("select 1 from pg_policies where schemaname='public' and tablename = 'dialpad_recording_' || $1", [table]);
        expect(policies.rowCount).toBe(0);
      }
      const writes = await pg.query<{ grantee: string; privilege_type: string }>(
        "select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name like 'dialpad_recording_%' and grantee in ('service_role','authenticated','anon','public')",
      );
      expect(writes.rows.every((row) => row.grantee === "service_role" && row.privilege_type === "SELECT")).toBe(true);
    });

    it("provisions a private bucket with a bounded object size and no browser storage policy", async () => {
      const bucket = await pg.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='dialpad-recordings'");
      expect(bucket.rows[0]).toMatchObject({ public: false, file_size_limit: "536870912" });
      expect(bucket.rows[0]!.allowed_mime_types).not.toContain("text/html");
      const policies = await pg.query(
        "select 1 from pg_policies where schemaname='storage' and tablename='objects' and (coalesce(qual,'') like '%dialpad-recordings%' or coalesce(with_check,'') like '%dialpad-recordings%')",
      );
      expect(policies.rowCount).toBe(0);
      await pg.query("insert into storage.objects(bucket_id,name) values ('dialpad-recordings',$1)", [`${orgId}/probe`]);
      const seenByMember = await authenticated(repA, () => pg.query("select 1 from storage.objects where bucket_id='dialpad-recordings'"));
      const seenByAnon = await anonymous(() => pg.query("select 1 from storage.objects where bucket_id='dialpad-recordings'"));
      expect(seenByMember.rowCount).toBe(0);
      expect(seenByAnon.rowCount).toBe(0);
      expect(
        (await failure(() => authenticated(repA, () => pg.query("insert into storage.objects(bucket_id,name) values ('dialpad-recordings',$1)", [`${orgId}/forged`])))).code,
      ).toBe("42501");
    });

    it("re-applies without duplicating the bucket or resetting it public", async () => {
      await pg.query("update storage.buckets set public=true, file_size_limit=1 where id='dialpad-recordings'");
      await pg.query(recordingSql);
      const bucket = await pg.query("select public, file_size_limit from storage.buckets where id='dialpad-recordings'");
      expect(bucket.rowCount).toBe(1);
      expect(bucket.rows[0]).toMatchObject({ public: false, file_size_limit: "536870912" });
    });
  });

  describe("fn_open_dialpad_recording_capture", () => {
    it("denies a prepared, dispatched or dialing call and opens only once the call is signed connected", async () => {
      const intent = await prepare();
      expect(await open(intent.intentId)).toMatchObject({ status: "denied", reason: "call_not_connected", callState: "prepared" });
      await authorize(intent.intentId);
      expect(await open(intent.intentId)).toMatchObject({ status: "denied", reason: "call_not_connected", callState: "awaiting_provider" });
      const start = NOW_MS + 1000;
      await deliver(payload("calling", start, String(intent.customData), { date_started: start }));
      expect(await open(intent.intentId)).toMatchObject({ status: "denied", reason: "call_not_connected", callState: "dialing" });
      await deliver(payload("connected", start + 4000, String(intent.customData), { date_started: start, date_connected: start + 4000 }));
      const opened = await open(intent.intentId);
      expect(opened.status).toBe("opened");
      expect(opened.capture).toMatchObject({ status: "open", repUserId: repA, orgId, intentId: intent.intentId, providerCallId: ROOT_CALL, segments: [] });
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_captures")).rows[0]!.n).toBe(1);
      expect(await callRecording((opened.capture as Json).callActivityId)).toBeUndefined();
    });

    it("replays the same capture for the same intent", async () => {
      const call = await connectedCall();
      const first = await open(call.intentId);
      const second = await open(call.intentId);
      expect(second.status).toBe("replayed");
      expect((second.capture as Json).captureId).toBe((first.capture as Json).captureId);
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_captures")).rows[0]!.n).toBe(1);
    });

    it("denies an ended call and never opens a capture for it", async () => {
      const call = await connectedCall();
      await endCall(call);
      expect(await open(call.intentId)).toMatchObject({ status: "denied", reason: "call_ended" });
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_captures")).rows[0]!.n).toBe(0);
    });

    it("keeps a matched call valid after its dispatch intent TTL expires, but not an unmatched one", async () => {
      const call = await connectedCall();
      await withoutTriggers("update public.dialpad_call_intents set prepared_at = now() - interval '3 hours', expires_at = now() - interval '2 hours 50 minutes' where id=$1", [call.intentId]);
      expect((await open(call.intentId)).status).toBe("opened");

      const stale = await prepare(60);
      await authorize(stale.intentId);
      await withoutTriggers("update public.dialpad_call_intents set prepared_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' where id=$1", [stale.intentId]);
      expect(await open(stale.intentId)).toMatchObject({ status: "denied", reason: "call_not_connected", callState: "expired" });
    });

    it("scopes the intent to the caller org and rep", async () => {
      const call = await connectedCall();
      expect((await failure(() => open(call.intentId, otherOrgId, otherRep))).code).toBe("P0002");
      expect((await failure(() => open(call.intentId, orgId, repB))).code).toBe("P0002");
      expect((await failure(() => open(uuid()))).code).toBe("P0002");
      expect((await failure(() => open(null))).code).toBe("22023");
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_captures")).rows[0]!.n).toBe(0);
    });

    it("requires the rep to be an active acquisition member at open, and on replay", async () => {
      const call = await connectedCall();
      await setDesignation(repA, orgId, false);
      expect(await open(call.intentId)).toMatchObject({ status: "denied", reason: "rep_not_active" });
      await setDesignation(repA, orgId, true);
      expect((await open(call.intentId)).status).toBe("opened");
      await service(() => pg.query("delete from public.memberships where org_id=$1 and user_id=$2", [orgId, repA]));
      expect(await open(call.intentId)).toMatchObject({ status: "denied", reason: "rep_not_active" });
    });

    it("binds the frozen intent, org, rep, activity and provider call id", async () => {
      const call = await connectedCall();
      const captureId = String(((await open(call.intentId)).capture as Json).captureId);
      const activity = (await pg.query("select id, operator_user_id from public.call_activities where jitter_attempt_id=$1", [`dialpad-cti:${call.intentId}`])).rows[0];
      expect(await captureRow(captureId)).toMatchObject({
        org_id: orgId,
        rep_user_id: repA,
        intent_id: call.intentId,
        call_activity_id: activity.id,
        provider_call_id: ROOT_CALL,
        status: "open",
      });
      await pg.query("update public.contacts set phone_1='(816) 555-0999' where id=$1", [contactId]);
      expect((await captureRow(captureId)).provider_call_id).toBe(ROOT_CALL);
    });
  });

  describe("capture immutability and transitions", () => {
    it("rejects any change to frozen attribution, deletes, and illegal transitions for every role", async () => {
      const { captureId } = await openedCapture();
      for (const [column, value] of [
        ["org_id", otherOrgId],
        ["rep_user_id", repB],
        ["intent_id", uuid()],
        ["provider_call_id", "999"],
        ["opened_at", new Date(0).toISOString()],
      ] as const) {
        expect((await failure(() => pg.query(`update public.dialpad_recording_captures set ${column}=$2 where id=$1`, [captureId, value]))).code).toBe("42501");
      }
      expect((await failure(() => pg.query("delete from public.dialpad_recording_captures where id=$1", [captureId]))).code).toBe("42501");
      expect((await failure(() => pg.query("update public.dialpad_recording_captures set status='sealed', result_at=now() where id=$1", [captureId]))).code).toBe("42501");
      expect((await failure(() => pg.query("update public.dialpad_recording_captures set status='sealing' where id=$1", [captureId]))).code).toBe("42501");
      expect((await failure(() => service(() => pg.query("update public.dialpad_recording_captures set status='closing' where id=$1", [captureId])))).code).toBe("42501");
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      expect((await failure(() => pg.query("update public.dialpad_recording_captures set status='open', closed_at=null, close_reason=null where id=$1", [captureId]))).code).toBe("42501");
    });

    it("rejects a capture inserted outside the open state or with a foreign intent org", async () => {
      await openedCapture();
      const second = await connectedCall();
      const activity = (await pg.query("select id from public.call_activities where jitter_attempt_id=$1", [`dialpad-cti:${second.intentId}`])).rows[0];
      expect(
        (await failure(() =>
          pg.query(
            "insert into public.dialpad_recording_captures(org_id,intent_id,rep_user_id,call_activity_id,provider_call_id,status,closed_at,close_reason) values ($1,$2,$3,$4,'1','closing',now(),'rep_closed')",
            [orgId, second.intentId, repA, activity.id],
          ),
        )).code,
      ).toBe("42501");
      expect(
        (await failure(() =>
          pg.query("insert into public.dialpad_recording_captures(org_id,intent_id,rep_user_id,call_activity_id,provider_call_id) values ($1,$2,$3,$4,'1')", [otherOrgId, second.intentId, repA, activity.id]),
        )).code,
      ).toBe("23503");
    });
  });

  describe("close", () => {
    it("closes idempotently, only for the owning rep, and stops new grants", async () => {
      const { captureId } = await openedCapture();
      expect((await failure(() => rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repB, null]))).code).toBe("P0002");
      expect((await failure(() => rpc("fn_close_dialpad_recording_capture", [otherOrgId, captureId, otherRep, null]))).code).toBe("P0002");
      const closed = await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      expect(closed).toMatchObject({ status: "closed", capture: { status: "closing", closeReason: "rep_closed" } });
      expect(await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null])).toMatchObject({ status: "replayed", capture: { status: "closing" } });
      expect(await mint(captureId, nextHash())).toMatchObject({ status: "denied", reason: "capture_not_open" });
      expect((await failure(() => rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, "call_ended"]))).code).toBe("22023");
    });

    it("lets the trusted service close with a service reason", async () => {
      const { captureId } = await openedCapture();
      expect(await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "call_ended"])).toMatchObject({ capture: { status: "closing", closeReason: "call_ended" } });
    });
  });

  describe("ingest grants", () => {
    it("stores only the hash and mints, replays and rejects conflicting reuse", async () => {
      const { captureId } = await openedCapture();
      const hash = nextHash();
      const minted = await mint(captureId, hash);
      expect(minted).toMatchObject({ status: "minted", captureId, epoch: 1 });
      const replay = await mint(captureId, hash);
      expect(replay).toMatchObject({ status: "replayed", grantId: minted.grantId });
      expect((await failure(() => mint(captureId, hash, 2))).code).toBe("40001");
      const stored = await pg.query("select token_hash, expires_at - created_at as ttl from public.dialpad_recording_ingest_grants");
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]!.token_hash).toBe(hash);
      expect(JSON.stringify(stored.rows)).not.toMatch(/token"/);
    });

    it("validates hash format, ttl bounds and ownership", async () => {
      const { captureId } = await openedCapture();
      for (const bad of ["", "ABC", "g".repeat(64), "a".repeat(63)]) expect((await failure(() => mint(captureId, bad))).code).toBe("22023");
      expect((await failure(() => mint(captureId, nextHash(), 1, 9))).code).toBe("22023");
      expect((await failure(() => mint(captureId, nextHash(), 1, 301))).code).toBe("22023");
      expect((await failure(() => mint(captureId, nextHash(), 0))).code).toBe("22023");
      expect((await failure(() => mint(captureId, nextHash(), 17))).code).toBe("22023");
      expect((await failure(() => mint(captureId, nextHash(), 1, 60, orgId, repB))).code).toBe("P0002");
      expect((await failure(() => mint(captureId, nextHash(), 1, 60, otherOrgId, otherRep))).code).toBe("P0002");
      expect((await failure(() => mint(uuid(), nextHash()))).code).toBe("P0002");
    });

    it("denies minting for an inactive rep or an ended call", async () => {
      const { call, captureId } = await openedCapture();
      await setDesignation(repA, orgId, false);
      expect(await mint(captureId, nextHash())).toMatchObject({ status: "denied", reason: "rep_not_active" });
      await setDesignation(repA, orgId, true);
      await endCall(call);
      expect(await mint(captureId, nextHash())).toMatchObject({ status: "denied", reason: "call_ended" });
    });

    it("consumes a grant once, binding the worker, and reports later use as consumed", async () => {
      const { captureId } = await openedCapture();
      const hash = nextHash();
      await mint(captureId, hash);
      const first = await consume(hash, "worker-a");
      expect(first).toMatchObject({ status: "consumed", captureId, orgId, repUserId: repA, epoch: 1, providerCallId: ROOT_CALL });
      expect(await consume(hash, "worker-b")).toMatchObject({ status: "denied", reason: "consumed" });
      const row = (await pg.query("select consumed_by from public.dialpad_recording_ingest_grants where token_hash=$1", [hash])).rows[0];
      expect(row.consumed_by).toBe("worker-a");
      expect(await consume(sha("never minted"))).toMatchObject({ status: "denied", reason: "unknown" });
      expect((await failure(() => consume("nope"))).code).toBe("22023");
      expect((await failure(() => rpc("fn_consume_dialpad_recording_ingest_grant", [hash, ""]))).code).toBe("22023");
    });

    it("expires grants in the database and does not consume an expired grant", async () => {
      const { captureId } = await openedCapture();
      const hash = nextHash();
      await mint(captureId, hash);
      await withoutTriggers("update public.dialpad_recording_ingest_grants set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where token_hash=$1", [hash]);
      expect(await consume(hash)).toMatchObject({ status: "denied", reason: "expired" });
      expect((await pg.query("select consumed_at from public.dialpad_recording_ingest_grants where token_hash=$1", [hash])).rows[0].consumed_at).toBeNull();
      expect(
        (await failure(() =>
          pg.query("insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,expires_at) values ($1,$2,$3,1,$4, now() + interval '6 minutes')", [orgId, captureId, repA, nextHash()]),
        )).code,
      ).toBe("23514");
    });

    it("supersedes an older unconsumed grant when a new one is minted", async () => {
      const { captureId } = await openedCapture();
      const first = nextHash();
      const second = nextHash();
      await mint(captureId, first);
      await mint(captureId, second);
      expect(await consume(first)).toMatchObject({ status: "denied", reason: "revoked" });
      expect((await consume(second)).status).toBe("consumed");
    });

    it("authorizes each epoch in order and at most once", async () => {
      const { captureId } = await openedCapture();
      expect(await mint(captureId, nextHash(), 2)).toMatchObject({ status: "denied", reason: "epoch_out_of_order" });
      await authorizedEpoch(captureId, 1);
      expect(await mint(captureId, nextHash(), 1)).toMatchObject({ status: "denied", reason: "epoch_already_authorized" });
      expect(await mint(captureId, nextHash(), 3)).toMatchObject({ status: "denied", reason: "epoch_out_of_order" });
      await authorizedEpoch(captureId, 2);
      expect(await mint(captureId, nextHash(), 2)).toMatchObject({ status: "denied", reason: "epoch_already_authorized" });
    });

    it("does not consume for a closed capture, an inactive rep, or an ended call", async () => {
      const closed = await openedCapture();
      const closedHash = nextHash();
      await mint(closed.captureId, closedHash);
      await rpc("fn_close_dialpad_recording_capture", [orgId, closed.captureId, repA, null]);
      expect(await consume(closedHash)).toMatchObject({ status: "denied", reason: "capture_not_open" });

      const inactive = await openedCapture();
      const inactiveHash = nextHash();
      await mint(inactive.captureId, inactiveHash);
      await setDesignation(repA, orgId, false);
      expect(await consume(inactiveHash)).toMatchObject({ status: "denied", reason: "rep_not_active" });
      await setDesignation(repA, orgId, true);
      await endCall(inactive.call);
      expect(await consume(inactiveHash)).toMatchObject({ status: "denied", reason: "call_ended" });
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_ingest_grants where consumed_at is not null")).rows[0]!.n).toBe(0);
    });

    it("keeps grants immutable evidence at the table level", async () => {
      const { captureId } = await openedCapture();
      const hash = nextHash();
      await mint(captureId, hash);
      expect((await failure(() => pg.query("update public.dialpad_recording_ingest_grants set token_hash=$1 where token_hash=$2", [nextHash(), hash]))).code).toBe("42501");
      expect((await failure(() => pg.query("update public.dialpad_recording_ingest_grants set expires_at = expires_at + interval '1 minute' where token_hash=$1", [hash]))).code).toBe("42501");
      expect((await failure(() => pg.query("delete from public.dialpad_recording_ingest_grants where token_hash=$1", [hash]))).code).toBe("42501");
      expect((await failure(() => pg.query("insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,expires_at,consumed_at,consumed_by) values ($1,$2,$3,1,$4,now()+interval '1 minute',now(),'x')", [orgId, captureId, repA, nextHash()]))).code).toBe("42501");
      expect((await failure(() => pg.query("insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,expires_at) values ($1,$2,$3,1,$4,now()+interval '1 minute')", [orgId, captureId, repB, nextHash()]))).code).toBe("23503");
      await consume(hash);
      expect((await failure(() => pg.query("update public.dialpad_recording_ingest_grants set consumed_at=null, consumed_by=null where token_hash=$1", [hash]))).code).toBe("42501");
    });
  });

  describe("chunk ledger", () => {
    it("requires a consumed grant for the epoch and derives the storage path server-side", async () => {
      const { captureId } = await openedCapture();
      expect((await failure(() => chunk(captureId, "tab", 1, 0))).code).toBe("42501");
      await authorizedEpoch(captureId);
      const recorded = await chunk(captureId, "tab", 1, 0);
      expect(recorded).toEqual({ status: "recorded", storagePath: `${orgId}/${captureId}/chunks/1/tab/00000000` });
      expect((await failure(() => chunk(captureId, "tab", 2, 0))).code).toBe("42501");
    });

    it("is idempotent for identical metadata and rejects any differing replay", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await chunk(captureId, "mic", 1, 0, { size: 500, sha: sha("x") });
      expect(await chunk(captureId, "mic", 1, 0, { size: 500, sha: sha("x") })).toMatchObject({ status: "replayed" });
      expect((await failure(() => chunk(captureId, "mic", 1, 0, { size: 501, sha: sha("x") }))).code).toBe("40001");
      expect((await failure(() => chunk(captureId, "mic", 1, 0, { size: 500, sha: sha("y") }))).code).toBe("40001");
      expect((await failure(() => chunk(captureId, "mic", 1, 0, { size: 500, sha: sha("x"), eof: true }))).code).toBe("40001");
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_chunks")).rows[0]!.n).toBe(1);
      expect((await pg.query("select chunk_count, total_bytes from public.dialpad_recording_segments")).rows[0]).toMatchObject({ chunk_count: 1, total_bytes: "500" });
    });

    it("bounds chunks to 1 MiB and validates inputs", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      expect((await chunk(captureId, "tab", 1, 0, { size: 1_048_576 })).status).toBe("recorded");
      expect((await failure(() => chunk(captureId, "tab", 1, 1, { size: 1_048_577 }))).code).toBe("22023");
      expect((await failure(() => chunk(captureId, "tab", 1, 1, { size: 0 }))).code).toBe("22023");
      expect((await failure(() => chunk(captureId, "video", 1, 1))).code).toBe("22023");
      expect((await failure(() => chunk(captureId, "tab", 1, -1))).code).toBe("22023");
      expect((await failure(() => chunk(captureId, "tab", 1, 100_000))).code).toBe("22023");
      expect((await failure(() => chunk(captureId, "tab", 1, 1, { sha: "ABC" }))).code).toBe("22023");
      expect((await failure(() => pg.query("update public.dialpad_recording_chunks set size_bytes=2 where seq=0"))).code).toBe("42501");
      expect((await failure(() => pg.query("delete from public.dialpad_recording_chunks"))).code).toBe("42501");
      expect(
        (await failure(() =>
          pg.query("insert into public.dialpad_recording_chunks(capture_id,org_id,track,epoch,seq,size_bytes,sha256,storage_path) values ($1,$2,'tab',1,7,10,$3,'somewhere/else')", [captureId, orgId, sha("z")]),
        )).code,
      ).toBe("23514");
    });

    it("caps one track segment at 512 MiB", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await service(() =>
        pg.query(
          "select public.fn_record_dialpad_recording_chunk($1,$2,'tab',1,g,1048576,repeat('a',64),false) from generate_series(0,511) g",
          [orgId, captureId],
        ),
      );
      expect((await pg.query("select total_bytes from public.dialpad_recording_segments")).rows[0]!.total_bytes).toBe("536870912");
      expect((await failure(() => chunk(captureId, "tab", 1, 512, { size: 1 }))).code).toBe("22023");
      expect((await chunk(captureId, "mic", 1, 0, { size: 1 })).status).toBe("recorded");
    });

    it("orders end of file: one EOF, none after it, and never before a later chunk", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await chunk(captureId, "tab", 1, 0);
      await chunk(captureId, "tab", 1, 2);
      expect((await failure(() => chunk(captureId, "tab", 1, 1, { eof: true }))).code).toBe("40001");
      await chunk(captureId, "tab", 1, 3, { eof: true });
      expect((await failure(() => chunk(captureId, "tab", 1, 4))).code).toBe("40001");
      expect((await failure(() => chunk(captureId, "tab", 1, 5, { eof: true }))).code).toBe("40001");
      await chunk(captureId, "tab", 1, 1);
      expect((await pg.query("select chunk_count, max_seq, eof_seq from public.dialpad_recording_segments where track='tab'")).rows[0]).toMatchObject({ chunk_count: 4, max_seq: 3, eof_seq: 3 });
      expect((await failure(() => pg.query("update public.dialpad_recording_segments set eof_seq=2"))).code).toBe("42501");
    });

    it("accepts chunks while closing and rejects them once sealing has started", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await chunk(captureId, "tab", 1, 0);
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      expect((await chunk(captureId, "tab", 1, 1, { eof: true })).status).toBe("recorded");
      expect((await chunk(captureId, "mic", 1, 0, { eof: true })).status).toBe("recorded");
      await claim();
      expect((await failure(() => chunk(captureId, "tab", 1, 2))).code).toBe("55000");
      expect(await chunk(captureId, "tab", 1, 1, { eof: true })).toMatchObject({ status: "replayed" });
    });

    it("keeps ledger tables service-read-only for direct writes", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      expect((await failure(() => service(() => pg.query("insert into public.dialpad_recording_segments(capture_id,org_id,track,epoch) values ($1,$2,'tab',1)", [captureId, orgId])))).code).toBe("42501");
      expect((await failure(() => service(() => pg.query("insert into public.dialpad_recording_captures(org_id,intent_id,rep_user_id,call_activity_id,provider_call_id) values ($1,$2,$3,$4,'1')", [orgId, uuid(), repA, uuid()])))).code).toBe("42501");
    });
  });

  describe("sealing: claim, recovery and result", () => {
    it("waits for final MediaRecorder chunks after signed hangup, then claims with a fenced lease", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await chunk(captureId, "tab", 1, 0);
      await chunk(captureId, "mic", 1, 0);
      await endCall(call);
      expect(await claim()).toEqual({ status: "none" });
      await chunk(captureId, "tab", 1, 1, { eof: true });
      await chunk(captureId, "mic", 1, 1, { eof: true });
      const claimed = await claim("worker-a", 120);
      expect(claimed).toMatchObject({ status: "claimed", attempt: 1, capture: { captureId, status: "sealing", closeReason: "call_ended" } });
      expect(await captureRow(captureId)).toMatchObject({ status: "sealing", claimed_by: "worker-a", seal_attempts: 1, close_reason: "call_ended" });
      expect(claimed.finalPaths).toEqual([
        { track: "mic", epoch: 1, finalPath: `${orgId}/${captureId}/final/1/mic` },
        { track: "tab", epoch: 1, finalPath: `${orgId}/${captureId}/final/1/tab` },
      ]);
      expect(await claim("worker-b")).toEqual({ status: "none" });
      expect((await failure(() => rpc("fn_claim_dialpad_recording_seal_work", ["", 300]))).code).toBe("22023");
      expect((await failure(() => rpc("fn_claim_dialpad_recording_seal_work", ["w", 5]))).code).toBe("22023");
    });

    it("uses the bounded drain deadline to classify incomplete signed-call evidence as partial", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await endCall(call);
      expect(await claim()).toEqual({ status: "none" });
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const claimed = await claim("worker-drain");
      expect(claimed).toMatchObject({ status: "claimed", capture: { captureId, closeReason: "call_ended" } });
      const result = await register(captureId, claimed.claimToken, [decoded("tab")]);
      expect(result).toMatchObject({ status: "registered", outcome: "partial", capture: { status: "partial" } });
      expect((await captureRow(captureId)).failure_code).toBeNull();
    });

    it("stays partial when a consumed reconnect epoch has no chunks, even if epoch one is complete", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId, 1);
      await fullTrack(captureId, "tab", 1);
      await fullTrack(captureId, "mic", 1);
      await authorizedEpoch(captureId, 2);
      await endCall(call);
      expect(await claim()).toEqual({ status: "none" });
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const claimed = await claim("worker-missing-epoch");
      expect(claimed.status).toBe("claimed");
      const result = await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
      expect(result).toMatchObject({ outcome: "partial", capture: { status: "partial", closeReason: "call_ended" } });
      expect(await callRecording((await captureRow(captureId)).call_activity_id)).toMatchObject({ status: "failed", error_code: "partial_capture" });
    });

    it("keeps an early rep close partial even when both streams have EOF, and later hangup cannot upgrade it", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      const claimed = await claim("worker-early");
      expect(claimed.status).toBe("claimed");
      const result = await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
      expect(result).toMatchObject({ outcome: "partial", capture: { status: "partial", closeReason: "rep_closed", failureCode: "capture_stopped_before_call_end" } });
      const activity = (await captureRow(captureId)).call_activity_id;
      expect(await callRecording(activity)).toMatchObject({ status: "failed", error_code: "partial_capture" });
      await endCall(call);
      expect(await captureRow(captureId)).toMatchObject({ status: "partial", failure_code: "capture_stopped_before_call_end" });
    });

    it("derives call-ended close when the rep closes after the signed hangup", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      await endCall(call);
      const closed = await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      expect(closed).toMatchObject({ capture: { status: "closing", closeReason: "call_ended" } });
      const claimed = await claim("worker-after-end");
      expect(claimed.status).toBe("claimed");
      expect(await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")])).toMatchObject({
        outcome: "sealed",
        capture: { status: "sealed", closeReason: "call_ended" },
      });
    });

    it("keeps a trusted service close partial before the signed call end", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "service_closed"]);
      const claimed = await claim("worker-service-close");
      const result = await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
      expect(result).toMatchObject({ outcome: "partial", capture: { status: "partial", closeReason: "service_closed", failureCode: "capture_stopped_before_call_end" } });
    });

    it("recovers an expired lease with a new token, fences the old holder and exhausts after five attempts", async () => {
      const { captureId } = await sealedReady();
      let token = String((await captureRow(captureId)).claim_token);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        await withoutTriggers("update public.dialpad_recording_captures set lease_expires_at = now() - interval '1 second' where id=$1", [captureId]);
        const reclaimed = await claim(`worker-${attempt}`);
        expect(reclaimed).toMatchObject({ status: "claimed", attempt });
        expect(reclaimed.claimToken).not.toBe(token);
        expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("mic")]))).code).toBe("42501");
        token = String(reclaimed.claimToken);
      }
      await withoutTriggers("update public.dialpad_recording_captures set lease_expires_at = now() - interval '1 second' where id=$1", [captureId]);
      expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("mic")]))).code).toBe("42501");
      expect(await claim("worker-6")).toEqual({ status: "none" });
      expect(await captureRow(captureId)).toMatchObject({ status: "failed", failure_code: "seal_attempts_exhausted" });
      const activity = (await captureRow(captureId)).call_activity_id;
      expect(await callRecording(activity)).toMatchObject({ status: "failed", storage_path: null, error_code: "seal_attempts_exhausted" });
    });

    it("seals only when both tracks have complete EOF, contiguous and decode evidence", async () => {
      const { call, captureId, token } = await sealedReady();
      const result = await register(captureId, token, [decoded("tab"), decoded("mic", 1, { decodedDurationMs: 60_400 })]);
      expect(result).toMatchObject({ status: "registered", outcome: "sealed", capture: { status: "sealed" } });
      const finals = await pg.query("select track, completeness, eof_verified, contiguous, source_chunk_count, source_bytes, source_last_seq, storage_path from public.dialpad_recording_track_finals order by track");
      expect(finals.rows).toEqual([
        { track: "mic", completeness: "complete", eof_verified: true, contiguous: true, source_chunk_count: 3, source_bytes: "3000", source_last_seq: 2, storage_path: `${orgId}/${captureId}/final/1/mic` },
        { track: "tab", completeness: "complete", eof_verified: true, contiguous: true, source_chunk_count: 3, source_bytes: "3000", source_last_seq: 2, storage_path: `${orgId}/${captureId}/final/1/tab` },
      ]);
      const activity = (await captureRow(captureId)).call_activity_id;
      expect(await callRecording(activity)).toMatchObject({ status: "available", storage_path: `${orgId}/${captureId}`, duration_seconds: 61, error_code: null });
      expect((await pg.query("select recording_status from public.call_activities where id=$1", [activity])).rows[0]!.recording_status).toBe("available");
      expect(call.intentId).toBeTruthy();
    });

    it("returns JSON that the TypeScript contract parsers accept end to end", async () => {
      const call = await connectedCall();
      const opened = parseDialpadRecordingOpenResult((await open(call.intentId)) as never);
      if (opened.status === "denied") throw new Error("expected open");
      const captureId = opened.capture.captureId;
      const hash = nextHash();
      const minted = parseDialpadRecordingGrantResult((await mint(captureId, hash)) as never);
      expect(minted).toMatchObject({ status: "minted", captureId, epoch: 1 });
      expect(parseDialpadRecordingConsumeResult((await consume(hash)) as never)).toMatchObject({ status: "consumed", captureId, orgId, repUserId: repA });
      expect(parseDialpadRecordingChunkResult((await chunk(captureId, "tab", 1, 0)) as never)).toEqual({ status: "recorded", storagePath: `${orgId}/${captureId}/chunks/1/tab/00000000` });
      await fullTrack(captureId, "mic");
      for (let seq = 1; seq < 3; seq += 1) await chunk(captureId, "tab", 1, seq, { eof: seq === 2 });
      await endCall(call);
      expect(await captureRow(captureId)).toMatchObject({ status: "open" });
      const claimed = parseDialpadRecordingClaimResult((await claim()) as never);
      if (claimed.status !== "claimed") throw new Error("expected claim");
      expect(claimed.finalPaths).toHaveLength(2);
      const registered = parseDialpadRecordingRegisterResult((await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")])) as never);
      expect(registered).toMatchObject({ status: "registered", outcome: "sealed" });
      expect(registered.capture.segments.every((segment) => segment.final?.completeness === "complete")).toBe(true);
      const fetched = parseDialpadRecordingCapture((await rpc("fn_get_dialpad_recording_capture", [orgId, repA, captureId])) as never);
      expect(fetched.status).toBe("sealed");
    });

    it("replays an identical result and rejects a conflicting one", async () => {
      const { captureId, token } = await sealedReady();
      const tracks = [decoded("tab"), decoded("mic")];
      await register(captureId, token, tracks);
      expect(await register(captureId, token, tracks)).toMatchObject({ status: "replayed", outcome: "sealed" });
      expect(await register(captureId, token, [decoded("mic"), decoded("tab")])).toMatchObject({ status: "replayed", outcome: "sealed" });
      expect((await failure(() => register(captureId, token, tracks, "derived_elsewhere"))).code).toBe("40001");
      expect((await failure(() => register(captureId, token, [decoded("tab", 1, { sha256: sha("other") }), decoded("mic")]))).code).toBe("40001");
      expect((await failure(() => register(captureId, token, [decoded("tab")]))).code).toBe("40001");
      expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("tab")]))).code).toBe("22023");
      expect((await failure(() => register(captureId, uuid(), tracks))).code).toBe("42501");
    });

    it("cannot be forced to complete: completeness and evidence are constrained in the table", async () => {
      const { captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const insert = (columns: string, values: string) =>
        pg.query(
          `insert into public.dialpad_recording_track_finals(capture_id,org_id,track,epoch,source_chunk_count,source_bytes,source_last_seq,registered_by,${columns}) values ($1,$2,'tab',2,1,1,0,'w',${values})`,
          [captureId, orgId],
        );
      expect((await failure(() => insert("completeness,decode_ok,eof_verified,contiguous", "'complete',true,false,true"))).code).toBe("23514");
      expect((await failure(() => insert("completeness,decode_ok,eof_verified,contiguous", "'complete',false,true,true"))).code).toBe("23514");
      expect((await failure(() => insert("completeness,decode_ok,eof_verified,contiguous", "'complete',true,true,true"))).code).toBe("23514");
      expect((await failure(() => pg.query("update public.dialpad_recording_track_finals set completeness='partial'"))).code).toBe("42501");
    });

    it("rejects malformed decode evidence and unreported or unknown segments", async () => {
      const { captureId, token } = await sealedReady();
      for (const bad of [
        decoded("tab", 1, { sha256: "nope" }),
        decoded("tab", 1, { sizeBytes: 0 }),
        decoded("tab", 1, { sizeBytes: 536_870_913 }),
        decoded("tab", 1, { sampleRateHz: 100 }),
        decoded("tab", 1, { channels: 3 }),
        decoded("tab", 1, { decodedDurationMs: 0 }),
        decoded("tab", 1, { codec: "OPUS!" }),
        { track: "tab", epoch: 1 },
        { track: "video", epoch: 1, decodeOk: false },
        decoded("tab", 17),
      ]) {
        expect((await failure(() => register(captureId, token, [bad, decoded("mic")]))).code).toBe("22023");
      }
      expect((await failure(() => register(captureId, token, [decoded("tab")]))).code).toBe("22023");
      expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("mic"), decoded("mic", 2)]))).code).toBe("22023");
      expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("tab"), decoded("mic")]))).code).toBe("22023");
      expect((await failure(() => register(captureId, token, [decoded("tab"), decoded("tab")], "worker_gave_up"))).code).toBe("22023");
      expect((await failure(() => register(captureId, token, "not-an-array" as never))).code).toBe("22023");
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_track_finals")).rows[0]!.n).toBe(0);
      expect((await captureRow(captureId)).status).toBe("sealing");
    });

    it("records a track missing EOF as partial and never publishes the recording as available", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "mic");
      await chunk(captureId, "tab", 1, 0);
      await chunk(captureId, "tab", 1, 1);
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const token = String((await claim()).claimToken);
      const result = await register(captureId, token, [decoded("tab"), decoded("mic")]);
      expect(result).toMatchObject({ outcome: "partial", capture: { status: "partial", failureCode: "capture_stopped_before_call_end" } });
      const tab = (await pg.query("select completeness, partial_reason, eof_verified from public.dialpad_recording_track_finals where track='tab'")).rows[0];
      expect(tab).toEqual({ completeness: "partial", partial_reason: "missing_eof", eof_verified: false });
      const activity = (await captureRow(captureId)).call_activity_id;
      expect(await callRecording(activity)).toMatchObject({ status: "failed", storage_path: null, error_code: "partial_capture" });
    });

    it("records a chunk gap as partial", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "mic");
      await chunk(captureId, "tab", 1, 0);
      await chunk(captureId, "tab", 1, 2, { eof: true });
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const token = String((await claim()).claimToken);
      expect(await register(captureId, token, [decoded("tab"), decoded("mic")])).toMatchObject({ outcome: "partial" });
      expect((await pg.query("select completeness, partial_reason, contiguous from public.dialpad_recording_track_finals where track='tab'")).rows[0]).toEqual({
        completeness: "partial",
        partial_reason: "chunk_gap",
        contiguous: false,
      });
    });

    it("is partial, not sealed, when only one track was captured", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const token = String((await claim()).claimToken);
      expect(await register(captureId, token, [decoded("tab")])).toMatchObject({ outcome: "partial" });
      expect(await callRecording((await captureRow(captureId)).call_activity_id)).toMatchObject({ status: "failed", error_code: "partial_capture" });
    });

    it("keeps a later epoch as a separate partial segment and never upgrades the capture", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId, 1);
      await fullTrack(captureId, "tab", 1);
      await fullTrack(captureId, "mic", 1);
      await authorizedEpoch(captureId, 2);
      await fullTrack(captureId, "tab", 2, 2);
      await fullTrack(captureId, "mic", 2, 2);
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      const claimed = await claim();
      expect((claimed.capture as Json).segments).toHaveLength(4);
      const token = String(claimed.claimToken);
      const result = await register(captureId, token, [decoded("tab"), decoded("mic"), decoded("tab", 2), decoded("mic", 2)]);
      expect(result).toMatchObject({ outcome: "partial", capture: { status: "partial" } });
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_track_finals where completeness='complete'")).rows[0]!.n).toBe(4);
      expect(await callRecording((await captureRow(captureId)).call_activity_id)).toMatchObject({ status: "failed", error_code: "partial_capture" });
    });

    it("treats an undecodable track as unusable, partial when another decodes and failed when none do", async () => {
      const { captureId, token } = await sealedReady();
      const result = await register(captureId, token, [{ track: "tab", epoch: 1, decodeOk: false }, decoded("mic")]);
      expect(result).toMatchObject({ outcome: "partial" });
      expect((await pg.query("select completeness, storage_path, sha256 from public.dialpad_recording_track_finals where track='tab'")).rows[0]).toEqual({ completeness: "unusable", storage_path: null, sha256: null });

      const second = await sealedReady();
      const failed = await register(second.captureId, second.token, [
        { track: "tab", epoch: 1, decodeOk: false },
        { track: "mic", epoch: 1, decodeOk: false },
      ]);
      expect(failed).toMatchObject({ outcome: "failed", capture: { status: "failed", failureCode: "no_usable_audio" } });
      expect(await callRecording((await captureRow(second.captureId)).call_activity_id)).toMatchObject({ status: "failed", storage_path: null });
    });

    it("fails a capture that captured nothing, with the worker's or a derived code", async () => {
      const { call, captureId } = await openedCapture();
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, repA, null]);
      await endCall(call);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const token = String((await claim()).claimToken);
      expect((await failure(() => register(captureId, token, [], "BAD CODE"))).code).toBe("22023");
      expect(await register(captureId, token, [], "worker_gave_up")).toMatchObject({ outcome: "failed", capture: { failureCode: "worker_gave_up" } });

      const empty = await openedCapture();
      await rpc("fn_close_dialpad_recording_capture", [orgId, empty.captureId, repA, null]);
      await endCall(empty.call);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [empty.captureId]);
      const emptyToken = String((await claim()).claimToken);
      expect(await register(empty.captureId, emptyToken, [])).toMatchObject({ outcome: "failed", capture: { failureCode: "no_audio_captured" } });
      expect((await failure(() => register(empty.captureId, emptyToken, [], "no_audio_captured"))).code).toBe("40001");
      expect(await callRecording((await captureRow(empty.captureId)).call_activity_id)).toMatchObject({ status: "failed", storage_path: null, error_code: "no_audio_captured" });
    });

    it("rejects registering for a capture that is not sealing", async () => {
      const { captureId } = await openedCapture();
      expect((await failure(() => register(captureId, uuid(), []))).code).toBe("42501");
      expect((await failure(() => register(uuid(), uuid(), []))).code).toBe("P0002");
    });

    it("never releases a capture that reaches a terminal state back into work", async () => {
      const { captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      expect(await claim()).toEqual({ status: "none" });
      expect((await failure(() => pg.query("update public.dialpad_recording_captures set status='sealing', claim_token=$2, claimed_by='x', claimed_at=now(), lease_expires_at=now()+interval '1 minute' where id=$1", [captureId, uuid()]))).code).toBe("42501");
    });
  });

  describe("call_recordings write protection", () => {
    async function nonDialpadActivity(): Promise<string> {
      const id = uuid();
      await pg.query(
        "insert into public.call_activities(id,org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,provider,operator_user_id) values ($1,$2,$3,$4,$5,'legacy-session','jitter',$6)",
        [id, orgId, propertyId, contactId, `legacy-${id}`, repA],
      );
      return id;
    }

    it("rejects authenticated forging, updating and deleting of Dialpad rows", async () => {
      const { captureId } = await openedCapture();
      const activity = String((await captureRow(captureId)).call_activity_id);
      const forged = await failure(() =>
        authenticated(repA, () => pg.query("insert into public.call_recordings(call_activity_id,status,storage_path,duration_seconds) values ($1,'available','forged/path',99)", [activity])),
      );
      expect(forged.code).toBe("42501");
      expect(await callRecording(activity)).toBeUndefined();

      await service(() => pg.query("insert into public.call_recordings(call_activity_id,status,error_code) values ($1,'failed','seed')", [activity]));
      const updated = await authenticated(repA, () => pg.query("update public.call_recordings set status='available', storage_path='forged/path' where call_activity_id=$1", [activity]));
      expect(updated.rowCount).toBe(0);
      const deleted = await authenticated(repA, () => pg.query("delete from public.call_recordings where call_activity_id=$1", [activity]));
      expect(deleted.rowCount).toBe(0);
      expect(await callRecording(activity)).toMatchObject({ status: "failed", error_code: "seed", storage_path: null });
    });

    it("preserves authenticated org-member writes for other providers and still isolates orgs", async () => {
      const activity = await nonDialpadActivity();
      const inserted = await authenticated(repA, () => pg.query("insert into public.call_recordings(call_activity_id,status,storage_path) values ($1,'pending','legacy/path')", [activity]));
      expect(inserted.rowCount).toBe(1);
      const updated = await authenticated(repB, () => pg.query("update public.call_recordings set status='available' where call_activity_id=$1", [activity]));
      expect(updated.rowCount).toBe(1);
      const foreignUpdate = await authenticated(otherRep, () => pg.query("update public.call_recordings set status='failed' where call_activity_id=$1", [activity]));
      expect(foreignUpdate.rowCount).toBe(0);
      expect((await failure(() => authenticated(otherRep, () => pg.query("insert into public.call_recordings(call_activity_id,status) values ($1,'pending')", [activity])))).code).toBe("42501");
      const selected = await authenticated(repA, () => pg.query("select status from public.call_recordings where call_activity_id=$1", [activity]));
      expect(selected.rows).toEqual([{ status: "available" }]);
      const deleted = await authenticated(repA, () => pg.query("delete from public.call_recordings where call_activity_id=$1", [activity]));
      expect(deleted.rowCount).toBe(1);
    });

    it("cannot move a legacy row onto a Dialpad activity", async () => {
      const activity = await nonDialpadActivity();
      const { captureId } = await openedCapture();
      const dialpadActivity = String((await captureRow(captureId)).call_activity_id);
      await authenticated(repA, () => pg.query("insert into public.call_recordings(call_activity_id,status) values ($1,'pending')", [activity]));
      expect((await failure(() => authenticated(repA, () => pg.query("update public.call_recordings set call_activity_id=$2 where call_activity_id=$1", [activity, dialpadActivity])))).code).toBe("42501");
    });

    it("keeps one call-level row per activity across repeated seal results", async () => {
      const { captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const activity = String((await captureRow(captureId)).call_activity_id);
      expect((await pg.query("select count(*)::int as n from public.call_recordings where call_activity_id=$1", [activity])).rows[0]!.n).toBe(1);
      expect((await failure(() => service(() => pg.query("insert into public.call_recordings(call_activity_id,status) values ($1,'pending')", [activity])))).code).toBe("23505");
    });
  });
});

/**
 * Real concurrency needs committed rows visible to separate connections, so this
 * suite commits its own fixture and removes every row it created afterwards.
 */
describe("20260929210000 Dialpad recording foundation concurrency", () => {
  const clients: Client[] = [];
  let orgs: string[] = [];
  let users: string[] = [];
  let captureId = "";

  async function session(): Promise<Client> {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query("set role service_role");
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);
    pg = new Client({ connectionString: dbUrl });
    await pg.connect();
    NOW_MS = Date.now();
    await pg.query("begin");
    await seedFixture();
    orgs = [orgId, otherOrgId];
    users = [ownerId, repA, repB, otherRep];
    const call = await connectedCall();
    captureId = String(((await open(call.intentId)).capture as Json).captureId);
    await pg.query("commit");
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    await pg.query("rollback").catch(() => undefined);
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    const tables = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema='public' and column_name='org_id' and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')",
    );
    for (const { table_name } of tables.rows) {
      await pg.query(`delete from public."${table_name}" where org_id = any($1::uuid[])`, [orgs]);
    }
    await pg.query("delete from public.organizations where id = any($1::uuid[])", [orgs]);
    await pg.query("delete from auth.users where id = any($1::uuid[])", [users]);
    await pg.query("commit");
    await pg.end();
  });

  it("consumes a grant exactly once across concurrent workers", async () => {
    const hash = nextHash();
    await pg.query("begin");
    expect((await mint(captureId, hash)).status).toBe("minted");
    await pg.query("commit");
    const workers = await Promise.all(Array.from({ length: 8 }, () => session()));
    const results = await Promise.all(workers.map((client, index) => client.query<{ v: Json }>("select public.fn_consume_dialpad_recording_ingest_grant($1,$2) as v", [hash, `worker-${index}`])));
    const outcomes = results.map((result) => result.rows[0]!.v);
    expect(outcomes.filter((outcome) => outcome.status === "consumed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.reason === "consumed")).toHaveLength(7);
    const consumed = await pg.query("select count(*)::int as n from public.dialpad_recording_ingest_grants where consumed_at is not null");
    expect(consumed.rows[0]!.n).toBe(1);
  });

  it("blocks a second consumer behind an in-flight consume and denies it after commit", async () => {
    const hash = nextHash();
    await pg.query("begin");
    expect((await mint(captureId, hash, 2)).status).toBe("minted");
    await pg.query("commit");
    const [first, second] = await Promise.all([session(), session()]);
    await first.query("begin");
    const won = await first.query<{ v: Json }>("select public.fn_consume_dialpad_recording_ingest_grant($1,'w1') as v", [hash]);
    expect(won.rows[0]!.v.status).toBe("consumed");
    let settled = false;
    const pending = second
      .query<{ v: Json }>("select public.fn_consume_dialpad_recording_ingest_grant($1,'w2') as v", [hash])
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    await first.query("commit");
    expect((await pending).rows[0]!.v).toMatchObject({ status: "denied", reason: "consumed" });
  });

  it("records concurrent identical chunk metadata once and rejects a concurrent conflicting chunk", async () => {
    const workers = await Promise.all(Array.from({ length: 6 }, () => session()));
    const same = await Promise.all(
      workers.map((client) =>
        client.query<{ v: Json }>("select public.fn_record_dialpad_recording_chunk($1,$2,'tab',1,0,4096,$3,false) as v", [orgId, captureId, sha("same")]),
      ),
    );
    const statuses = same.map((result) => result.rows[0]!.v.status);
    expect(statuses.filter((status) => status === "recorded")).toHaveLength(1);
    expect(statuses.filter((status) => status === "replayed")).toHaveLength(5);

    const racing = await Promise.allSettled(
      workers.slice(0, 4).map((client, index) =>
        client.query("select public.fn_record_dialpad_recording_chunk($1,$2,'mic',1,0,100,$3,false)", [orgId, captureId, sha(`racing-${index}`)]),
      ),
    );
    expect(racing.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = racing.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(rejected).toHaveLength(3);
    expect(rejected.every((entry) => (entry.reason as PgError).code === "40001")).toBe(true);
    const ledger = await pg.query("select count(*)::int as n from public.dialpad_recording_chunks where track='mic'");
    expect(ledger.rows[0]!.n).toBe(1);
    const segment = await pg.query("select chunk_count, total_bytes from public.dialpad_recording_segments where track='mic'");
    expect(segment.rows[0]).toMatchObject({ chunk_count: 1, total_bytes: "100" });
  });
});
