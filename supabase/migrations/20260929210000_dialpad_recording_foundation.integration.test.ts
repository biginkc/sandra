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
  parseDialpadRecordingEofResult,
  parseDialpadRecordingLifecycle,
  parseDialpadRecordingSealInputs,
  parseDialpadRecordingVadResult,
  parseDialpadRecordingPcmProgressResult,
  parseDialpadRecordingVadSnapshot,
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
const transportSql = readSql("20260929220000_dialpad_recording_transport_contract.sql");
const playbackSql = readSql("20260929221000_dialpad_recording_playback.sql");
const browserSessionSql = readSql("20260930001000_dialpad_recording_browser_session.sql");
const shadowSql = readSql("20260930001100_dialpad_recording_shadow_measurements.sql");

const uuid = () => crypto.randomUUID();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const DIALPAD_REP_A = "5150000000000001";
const ROOT_CALL = "6543210987654321098";
const HASH_A = "a".repeat(64);
const SANDRA_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
let dialpadRepId = DIALPAD_REP_A;
let dialpadExternalNumber = "+18165550142";
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
  dialpadRepId = DIALPAD_REP_A;
  dialpadExternalNumber = "+18165550142";
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
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref,recording_ingest_endpoint) values ($1,'active','client_abc','env:DIALPAD_CTI_WEBHOOK_SECRET_A','4040404040404040','env:DIALPAD_CTI_DIRECTORY_KEY_A','wss://recording.example.test/dialpad-browser-ingest') returning id",
      [orgId],
    ),
  );
  connectionId = connection.rows[0]!.id;
  await verifiedBinding(orgId, repA, dialpadRepId);
}

async function seedSandraLibraryFixture(): Promise<void> {
  orgId = SANDRA_ORG_ID;
  contactId = uuid();
  propertyId = uuid();
  dialpadRepId = `9${BigInt(`0x${contactId.replaceAll("-", "").slice(-15)}`).toString().padStart(18, "0")}`;
  dialpadExternalNumber = `+1816${BigInt(`0x${contactId.replaceAll("-", "").slice(-15)}`).toString().padStart(7, "0").slice(-7)}`;
  await service(async () => {
    await pg.query("insert into public.organizations(id,name) values ($1,'Sandra playback test org') on conflict (id) do nothing", [orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner') on conflict (user_id,org_id) do update set role='owner', access_status='active', deletion_prepared_at=null, access_expires_at=null", [ownerId, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member') on conflict (user_id,org_id) do update set access_status='active', deletion_prepared_at=null, access_expires_at=null", [repA, orgId]);
  });
  // The projection test seeds its member directly inside the surrounding
  // transaction; the owner designation RPC is covered by the acquisition
  // migration tests. Disable only this fixture guard while setting the test
  // member, then restore it before any capture work runs.
  await pg.query("alter table public.memberships disable trigger trg_my_leads_designation_guard");
  try {
    await pg.query("update public.memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2", [orgId, repA]);
  } finally {
    await pg.query("alter table public.memberships enable trigger trg_my_leads_designation_guard");
  }
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true) on conflict (org_id) do update set my_leads_enabled=true", [orgId]);
  await pg.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Sandra playback seller',$3,'mobile')",
    [contactId, orgId, dialpadExternalNumber],
  );
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,concat('Sandra Playback Way ',right($1::uuid::text,8)),'MO',$3,$4)",
    [propertyId, orgId, contactId, repA],
  );
  const connection = await service(() =>
    pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref,recording_ingest_endpoint) values ($1,'active',$2,'env:DIALPAD_CTI_WEBHOOK_SECRET_SEARCH','4040404040404041','env:DIALPAD_CTI_DIRECTORY_KEY_SEARCH','wss://recording.example.test/dialpad-browser-ingest') on conflict (org_id) do update set status='active',cti_client_id=excluded.cti_client_id,webhook_secret_ref=excluded.webhook_secret_ref,dialpad_company_id=excluded.dialpad_company_id,directory_api_key_ref=excluded.directory_api_key_ref,recording_ingest_endpoint=excluded.recording_ingest_endpoint returning id",
      [orgId, `client_search_${uuid()}`],
    ),
  );
  connectionId = connection.rows[0]!.id;
  await verifiedBinding(orgId, repA, dialpadRepId);
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
  const body = { state, event_timestamp: at, external_number: dialpadExternalNumber, internal_number: "+18165550100", direction: "outbound", target: { type: "user", id: "__T__" }, custom_data: custom, ...extra };
  return JSON.stringify(body).replace('"__T__"', dialpadRepId).replace(/^\{/, `{"call_id":${callId},`);
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

async function connectedCall(providerCallId?: string): Promise<Call> {
  callCounter += 1;
  const call = await ringingCall(providerCallId ?? (callCounter === 1 ? ROOT_CALL : `65432109876543${String(callCounter).padStart(5, "0")}`));
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
async function publishPcmEofForClaim(): Promise<void> {
  const rows = await pg.query<{
    capture_id: string;
    org_id: string;
    epoch: number;
    track: "tab" | "mic";
    processed_through_sample: number;
    pcm_eof_sample: number | null;
    source_sample_rate_hz: number | null;
    source_channels: number | null;
    source_codec: string | null;
    degraded_reasons: unknown;
  }>(
    `select c.id as capture_id, c.org_id, g.epoch, s.track,
            coalesce(p.processed_through_sample, 0) as processed_through_sample,
            p.pcm_eof_sample, p.source_sample_rate_hz, p.source_channels, p.source_codec,
            coalesce(p.degraded_reasons, '[]'::jsonb) as degraded_reasons
       from public.dialpad_recording_captures c
       join public.dialpad_recording_ingest_grants g
         on g.capture_id = c.id and g.consumed_at is not null
       join public.dialpad_recording_segments s
         on s.capture_id = c.id and s.epoch = g.epoch
       left join public.dialpad_recording_pcm_progress p
         on p.capture_id = c.id and p.epoch = g.epoch and p.track = s.track
      where c.status = 'open'
         or (c.status = 'closing' and c.drain_deadline_at is not null and c.drain_deadline_at > now())
      group by c.id, c.org_id, g.epoch, s.track, p.processed_through_sample, p.pcm_eof_sample,
               p.source_sample_rate_hz, p.source_channels, p.source_codec, p.degraded_reasons
      order by c.opened_at, c.id, g.epoch, s.track`,
  );
  for (const row of rows.rows) {
    const processed = Number(row.processed_through_sample);
    const reasons = Array.isArray(row.degraded_reasons) ? row.degraded_reasons : [];
    await rpc("fn_record_dialpad_recording_pcm_progress", [
      row.org_id,
      row.capture_id,
      row.track,
      row.epoch,
      uuid(),
      processed,
      processed,
      row.source_sample_rate_hz,
      row.source_channels,
      row.source_codec,
      JSON.stringify(reasons),
    ]);
  }
}

const claim = async (worker = "worker-1", lease = 300) => {
  await publishPcmEofForClaim();
  return rpc("fn_claim_dialpad_recording_seal_work", [worker, lease]);
};
const register = (captureId: unknown, token: unknown, tracks: unknown[], failureCode: string | null = null) =>
  rpc("fn_register_dialpad_recording_result", [captureId, token, JSON.stringify(tracks), failureCode]);

let tokenCounter = 0;
const nextHash = () => sha(`token-${Date.now()}-${(tokenCounter += 1)}-${uuid()}`);
let playbackCallCounter = 0;
const nextPlaybackCallId = () => String(Date.now() * 1000 + (playbackCallCounter += 1));

async function openedCapture(providerCallId?: string): Promise<{ call: Call; captureId: string }> {
  const call = await connectedCall(providerCallId);
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

async function forceSealing(captureId: string): Promise<void> {
  await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "service_closed"]);
  await withoutTriggers(
    "update public.dialpad_recording_captures set status='sealing', claim_token=$2, claimed_by='test-sealer', claimed_at=now(), lease_expires_at=now()+interval '5 minutes' where id=$1",
    [captureId, uuid()],
  );
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

async function sealedReady(providerCallId?: string): Promise<{ call: Call; captureId: string; token: string }> {
  const { call, captureId } = await openedCapture(providerCallId);
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
    await pg.query(transportSql);
    await pg.query(transportSql);
    await pg.query(playbackSql);
    await pg.query(playbackSql);
    await pg.query(browserSessionSql);
    await pg.query(browserSessionSql);
    await pg.query(shadowSql);
    await pg.query(shadowSql);
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
          "fn_mark_dialpad_recording_eof",
          "fn_get_dialpad_recording_lifecycle",
          "fn_get_dialpad_recording_seal_inputs",
          "fn_get_dialpad_recording_vad_snapshot",
          "fn_record_dialpad_recording_vad_ranges",
          "fn_record_dialpad_recording_pcm_progress",
          "fn_register_dialpad_recording_result",
          "fn_dialpad_recording_library_sources",
          "fn_dialpad_recording_playback_file",
          "fn_get_dialpad_recording_browser_status",
          "fn_mint_dialpad_recording_next_epoch",
          "fn_get_dialpad_recording_shadow_input",
          "fn_finalize_dialpad_recording_shadow",
          "fn_get_dialpad_recording_shadow_measurement",
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
      for (const table of ["captures", "segments", "chunks", "track_finals", "ingest_grants", "vad_batches", "vad_ranges", "vad_totals", "vad_threshold_latches", "pcm_batches", "pcm_progress"]) {
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
      await pg.query(transportSql);
      await pg.query(playbackSql);
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
      expect(await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "call_ended"])).toMatchObject({ capture: { status: "closing", closeReason: "service_closed" } });
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

    it("does not let a requested service call-ended reason erase an early close after later hangup", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      const closed = await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "call_ended"]);
      expect(closed).toMatchObject({ capture: { status: "closing", closeReason: "service_closed" } });
      await endCall(call);
      const claimed = await claim("worker-service-early-end");
      expect(claimed.status).toBe("claimed");
      expect(await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")])).toMatchObject({
        outcome: "partial",
        capture: { status: "partial", closeReason: "service_closed", failureCode: "capture_stopped_before_call_end" },
      });
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

  describe("provider-window shadow evidence", () => {
    it("snapshots terminal evidence, preserves null eligibility, and replays finalization", async () => {
      const { captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const captureBefore = await captureRow(captureId);
      const vadBefore = await pg.query("select * from public.dialpad_recording_vad_totals where capture_id=$1", [captureId]);
      const latchBefore = await pg.query("select * from public.dialpad_recording_vad_threshold_latches where capture_id=$1", [captureId]);
      const activityBefore = await pg.query("select provider, provider_call_id, seller_speech_seconds_measured, seller_speech_seconds_estimated, seller_speech_confidence, recording_status from public.call_activities where id=(select call_activity_id from public.dialpad_recording_captures where id=$1)", [captureId]);

      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      expect(input).toMatchObject({
        algorithmVersion: "provider-window-shadow-v1",
        eligibleSamples: null,
        timingStatus: "unmapped",
        snapshotOnly: true,
      });
      expect(Array.isArray(input.reasons)).toBe(true);
      expect((input.manifest as Json).timingEvidence).toBeNull();
      expect(JSON.stringify(input.manifest).length).toBeLessThan(32 * 1024);

      const finalized = await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
      expect(finalized).toMatchObject({ inputDigest: input.inputDigest, eligibleSamples: null, timingStatus: "unmapped", replayed: false, snapshotOnly: true });
      const replayed = await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
      expect(replayed).toMatchObject({ inputDigest: input.inputDigest, replayed: true, eligibleSamples: null });

      const current = await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId]);
      expect(current).toMatchObject({ currentAtRead: true, currentInputDigest: input.inputDigest, staleReason: null, snapshotOnly: true });
      expect(current.measurement).toMatchObject({ captureId, orgId, eligibleSamples: null, timingStatus: "unmapped" });
      for (const sql of [
        "insert into public.dialpad_recording_shadow_measurements(capture_id,org_id,call_activity_id,intent_id,algorithm_version,input_digest,evidence_manifest,observed_samples,observed_samples_by_epoch,eligible_samples,timing_status,evidence_status,reasons) values ($1,$2,$3,$4,'provider-window-shadow-v1',$5,'{}',0,'{}',null,'unmapped','insufficient','[\"timing_mapping_missing\"]')",
        "update public.dialpad_recording_shadow_measurements set evidence_status='conflicting' where capture_id=$1",
        "delete from public.dialpad_recording_shadow_measurements where capture_id=$1",
      ]) {
        const args = sql.startsWith("insert") ? [captureId, orgId, (current.measurement as Json).callActivityId, (current.measurement as Json).intentId, input.inputDigest] : [captureId];
        expect((await failure(() => service(() => pg.query(sql, args)))).code).toBe("42501");
      }
      const invalidEligible = await failure(async () => {
        await pg.query("set local role postgres");
        await pg.query("insert into public.dialpad_recording_shadow_measurements(capture_id,org_id,call_activity_id,intent_id,algorithm_version,input_digest,evidence_manifest,observed_samples,observed_samples_by_epoch,eligible_samples,timing_status,evidence_status,reasons) values ($1,$2,$3,$4,'provider-window-shadow-v1',$5,'{}',0,'{}',0,'unmapped','insufficient','[\"timing_mapping_missing\"]')", [captureId, orgId, (current.measurement as Json).callActivityId, (current.measurement as Json).intentId, input.inputDigest]);
      });
      expect(invalidEligible.code).toBe("23514");
      expect(await captureRow(captureId)).toEqual(captureBefore);
      expect(await pg.query("select * from public.dialpad_recording_vad_totals where capture_id=$1", [captureId])).toEqual(vadBefore);
      expect(await pg.query("select * from public.dialpad_recording_vad_threshold_latches where capture_id=$1", [captureId])).toEqual(latchBefore);
      expect(await pg.query("select provider, provider_call_id, seller_speech_seconds_measured, seller_speech_seconds_estimated, seller_speech_confidence, recording_status from public.call_activities where id=(select call_activity_id from public.dialpad_recording_captures where id=$1)", [captureId])).toEqual(activityBefore);
    });

    it("unions authoritative half-open VAD ranges per epoch and never awards eligibility", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify([
        { startSample: 0, endSample: 10, evidenceRef: "vad:a" },
        { startSample: 5, endSample: 15, evidenceRef: "vad:b" },
      ])]);
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify([
        { startSample: 20, endSample: 25, evidenceRef: "vad:c" },
        { startSample: 20, endSample: 25, evidenceRef: "vad:c-replay" },
      ])]);
      await endCall(call);
      const claimed = await claim();
      expect(claimed.status).toBe("claimed");
      await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      expect(input).toMatchObject({ observedSamples: 20, observedSamplesByEpoch: { "1": 20 }, eligibleSamples: null, timingStatus: "unmapped" });
    });

    it("rejects a stale expected digest without creating a measurement", async () => {
      const { captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      expect((await failure(() => rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, sha("wrong-shadow-digest")]))).code).toBe("40001");
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_shadow_measurements where capture_id=$1", [captureId])).rows[0]!.n).toBe(0);
      await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
    });

    it("invalidates a snapshot for a same-key conflict even when the conflicting master call changes", async () => {
      const { call, captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const childCallId = "98765432123456789";
      const eventTimestamp = call.start + 6000;
      const first = await service(() => pg.query<{ v: { eventId: string; disposition: string } }>(
        "select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v",
        [orgId, connectionId, payload("shadow-conflict", eventTimestamp, call.custom, { master_call_id: call.callId }, childCallId)],
      ));
      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
      expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: true, currentInputDigest: input.inputDigest });
      const conflict = await service(() => pg.query<{ v: { eventId: string; disposition: string } }>(
        "select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v",
        [orgId, connectionId, payload("shadow-conflict", eventTimestamp, call.custom, { master_call_id: "99999999999999999" }, childCallId)],
      ));
      expect(first.rows[0]!.v.disposition).toBe("received");
      expect(conflict.rows[0]!.v.disposition).toBe("conflict");
      const conflictRow = await pg.query<{ disposition: string; conflicts_with_event_id: string }>("select disposition, conflicts_with_event_id from public.dialpad_call_events where id=$1", [conflict.rows[0]!.v.eventId]);
      expect(conflictRow.rows[0]).toMatchObject({ disposition: "conflict", conflicts_with_event_id: first.rows[0]!.v.eventId });
      const afterConflict = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      expect(afterConflict.inputDigest).not.toBe(input.inputDigest);
      expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed" });
    });

    it("covers fragmented long-call ranges with a bounded digest and terminal writer fencing", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      for (let batch = 0; batch < 20; batch += 1) {
        const ranges = Array.from({ length: 10 }, (_, index) => ({
          startSample: batch * 1000 + index * 100,
          endSample: batch * 1000 + index * 100 + 50,
          evidenceRef: `fragment:${batch}:${index}`,
        }));
        await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify(ranges)]);
      }
      await endCall(call);
      const claimed = await claim("shadow-fragment-sealer");
      expect(claimed.status).toBe("claimed");
      await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      const manifest = input.manifest as Json;
      expect(input).toMatchObject({ observedSamples: 10_000, observedSamplesByEpoch: { "1": 10_000 }, eligibleSamples: null });
      expect((manifest.relations as Json).vadRanges).toMatchObject({ count: 200 });
      expect((manifest.relations as Json).vadRanges).not.toHaveProperty("rows");
      expect(JSON.stringify(manifest).length).toBeLessThan(32 * 1024);
      await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
      expect((await failure(() => chunk(captureId, "tab", 1, 99))).code).toBe("55000");
      expect((await failure(() => rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify([{ startSample: 99_000, endSample: 99_001, evidenceRef: "late" }])]))).code).toBe("55000");
      expect((await failure(() => rpc("fn_record_dialpad_recording_pcm_progress", [orgId, captureId, "tab", 1, uuid(), 640, 640, 48_000, 1, "opus", JSON.stringify([])]))).code).toBe("55000");
      await withoutTriggers("update public.dialpad_recording_vad_ranges set evidence_ref='fragment:tail:changed' where capture_id=$1 and batch_id=(select batch_id from public.dialpad_recording_vad_batches where capture_id=$1 order by recorded_at desc, batch_id desc limit 1) and range_index=9", [captureId]);
      expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed" });
    });

    it("marks provider evidence insertion stale without changing historical evidence", async () => {
      const { call, captureId, token } = await sealedReady();
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
      await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
      const ingested = await service(() => pg.query<{ v: { eventId: string } }>(
        "select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v",
        [orgId, connectionId, payload("calling", call.start + 5000, call.custom, { date_started: call.start }, call.callId)],
      ));
      const marker = await pg.query<{ n: string }>("select count(*)::int as n from public.dialpad_recording_shadow_event_changes where event_id=$1", [ingested.rows[0]!.v.eventId]);
      expect(Number(marker.rows[0]!.n)).toBe(1);
      await pg.query("set local role postgres");
      await pg.query("update public.dialpad_call_events set disposition_reason='shadow-attribution-change' where id=$1", [ingested.rows[0]!.v.eventId]);
      await pg.query("reset role");
      const attributionMarkers = await pg.query<{ n: string }>("select count(*)::int as n from public.dialpad_recording_shadow_event_changes where event_id=$1", [ingested.rows[0]!.v.eventId]);
      expect(Number(attributionMarkers.rows[0]!.n)).toBe(2);
      const stale = await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId]);
      expect(stale).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed", snapshotOnly: true });
      expect((stale.measurement as Json).inputDigest).toBe(input.inputDigest);
    });

    it("requires a terminal capture and service-role execution", async () => {
      const { captureId } = await openedCapture();
      expect((await failure(() => rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]))).code).toBe("55000");
      expect((await failure(() => rpc("fn_get_dialpad_recording_shadow_input", [otherOrgId, captureId]))).code).toBe("P0002");
      expect((await failure(() => authenticated(repA, () => pg.query("select public.fn_get_dialpad_recording_shadow_input($1,$2)", [orgId, captureId])))).code).toBe("42501");
      expect((await failure(() => anonymous(() => pg.query("select public.fn_get_dialpad_recording_shadow_input($1,$2)", [orgId, captureId])))).code).toBe("42501");
      for (const wrap of [(run: () => Promise<unknown>) => authenticated(repA, run), (run: () => Promise<unknown>) => anonymous(run)]) {
        expect((await failure(() => wrap(() => pg.query("select * from public.dialpad_recording_shadow_measurements")))).code).toBe("42501");
        expect((await failure(() => wrap(() => pg.query("select * from public.dialpad_recording_shadow_event_changes")))).code).toBe("42501");
      }
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
  let sessionConnectionId = "";
  let sessionContactId = "";
  let sessionPropertyId = "";

  async function session(): Promise<Client> {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query("set role service_role");
    clients.push(client);
    return client;
  }

  async function clientRpc(client: Client, name: string, args: unknown[]): Promise<Json> {
    const marks = args.map((_, index) => `$${index + 1}`).join(",");
    return (await client.query<{ v: Json }>(`select public.${name}(${marks}) as v`, args)).rows[0]!.v;
  }

  async function committedShadowCapture(): Promise<{ call: Call; captureId: string; token: string }> {
    orgId = orgs[0]!;
    otherOrgId = orgs[1]!;
    ownerId = users[0]!;
    repA = users[1]!;
    repB = users[2]!;
    otherRep = users[3]!;
    connectionId = sessionConnectionId;
    contactId = sessionContactId;
    propertyId = sessionPropertyId;
    dialpadRepId = DIALPAD_REP_A;
    dialpadExternalNumber = "+18165550142";
    NOW_MS = Date.now();
    const opened = await openedCapture(nextPlaybackCallId());
    await authorizedEpoch(opened.captureId);
    await fullTrack(opened.captureId, "tab");
    await fullTrack(opened.captureId, "mic");
    await endCall(opened.call);
    const claimed = await claim("shadow-concurrency-sealer");
    if (claimed.status !== "claimed") throw new Error(`shadow capture was not claimed: ${claimed.status}`);
    await register(opened.captureId, claimed.claimToken, [decoded("tab"), decoded("mic")]);
    return { call: opened.call, captureId: opened.captureId, token: String(claimed.claimToken) };
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
    sessionConnectionId = connectionId;
    sessionContactId = contactId;
    sessionPropertyId = propertyId;
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

  it("serializes concurrent identical VAD batches and reports same-ID conflicts", async () => {
    const hash = nextHash();
    await pg.query("begin");
    expect((await mint(captureId, hash, 3)).status).toBe("minted");
    expect((await consume(hash)).status).toBe("consumed");
    await pg.query("commit");
    const batchId = uuid();
    const ranges = JSON.stringify([{ startSample: 0, endSample: 100, evidenceRef: "concurrent" }]);
    const workers = await Promise.all([session(), session()]);
    const results = await Promise.all(workers.map((client) => client.query<{ v: Json }>(
      "select public.fn_record_dialpad_recording_vad_ranges($1,$2,'tab',3,$3,$4::jsonb) as v",
      [orgId, captureId, batchId, ranges],
    )));
    expect(results.map((result) => result.rows[0]!.v.status).sort()).toEqual(["recorded", "replayed"]);
    expect((await pg.query("select count(*)::int as n, max(voiced_samples)::bigint as total from public.dialpad_recording_vad_batches b join public.dialpad_recording_vad_totals t using (capture_id) where b.capture_id=$1", [captureId])).rows[0]).toMatchObject({ n: 1, total: "100" });
    await expect(workers[0]!.query(
      "select public.fn_record_dialpad_recording_vad_ranges($1,$2,'tab',3,$3,$4::jsonb)",
      [orgId, captureId, batchId, JSON.stringify([{ startSample: 0, endSample: 101, evidenceRef: "changed" }])],
    )).rejects.toMatchObject({ code: "40001" });
  });

  it("serializes concurrent next-epoch mint attempts and redeems the single winner", async () => {
    const status = await pg.query<{ v: Json }>(
      "select public.fn_get_dialpad_recording_browser_status($1,$2,$3) as v",
      [orgId, repA, captureId],
    );
    const expected = Number(status.rows[0]!.v.latestConsumedEpoch);
    const [first, second] = await Promise.all([session(), session()]);
    const firstHash = nextHash();
    const secondHash = nextHash();
    const results = await Promise.all([
      first.query<{ v: Json }>("select public.fn_mint_dialpad_recording_next_epoch($1,$2,$3,$4,$5,60) as v", [orgId, repA, captureId, expected, firstHash]),
      second.query<{ v: Json }>("select public.fn_mint_dialpad_recording_next_epoch($1,$2,$3,$4,$5,60) as v", [orgId, repA, captureId, expected, secondHash]),
    ]);
    const outcomes = results.map((result) => result.rows[0]!.v);
    expect(outcomes.filter((outcome) => outcome.status === "minted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.reason === "grant_pending")).toHaveLength(1);
    const mintedHash = outcomes.find((outcome) => outcome.status === "minted") === outcomes[0] ? firstHash : secondHash;
    const redeemed = await first.query<{ v: Json }>("select public.fn_consume_dialpad_recording_ingest_grant($1,'next-epoch-worker') as v", [mintedHash]);
    expect(redeemed.rows[0]!.v).toMatchObject({ status: "consumed", epoch: expected + 1 });
  });

  describe("20260929220000 transport contract", () => {
    beforeEach(async () => {
      await pg.query("begin");
    });

    afterEach(async () => {
      await pg.query("rollback");
      await pg.query("reset role");
    });

    it("records explicit EOF once, rejects conflicting replay, and exposes authoritative lifecycle", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      const chunkSha = sha("eof-chunk");
      await chunk(captureId, "tab", 1, 0, { sha: chunkSha });
      const first = await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "tab", 1, 0, chunkSha]);
      expect(parseDialpadRecordingEofResult(first as never)).toMatchObject({ status: "recorded", seq: 0, sha256: chunkSha });
      const replay = await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "tab", 1, 0, chunkSha]);
      expect(parseDialpadRecordingEofResult(replay as never)).toMatchObject({ status: "replayed", seq: 0 });
      expect((await failure(() => rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "tab", 1, 0, sha("different-eof")]))).code).toBe("40001");
      expect((await failure(() => chunk(captureId, "tab", 1, 1))).code).toBe("40001");

      const live = parseDialpadRecordingLifecycle(await rpc("fn_get_dialpad_recording_lifecycle", [orgId, captureId]) as never);
      expect(live).toMatchObject({ captureStatus: "open", callState: "connected", acceptsLivePcm: true, allowsRetentionDrain: false });
      await endCall(call);
      const retainedSha = sha("terminal-drain");
      await chunk(captureId, "mic", 1, 0, { sha: retainedSha });
      const ended = parseDialpadRecordingLifecycle(await rpc("fn_get_dialpad_recording_lifecycle", [orgId, captureId]) as never);
      expect(ended).toMatchObject({ callState: "ended", connected: true, ended: true, acceptsLivePcm: false, allowsRetentionDrain: true });
      expect(parseDialpadRecordingEofResult(await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "mic", 1, 0, retainedSha]) as never)).toMatchObject({ status: "recorded", track: "mic" });
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      expect((await failure(() => chunk(captureId, "mic", 1, 1))).code).toBe("55000");
      expect(await chunk(captureId, "mic", 1, 0, { sha: retainedSha })).toMatchObject({ status: "replayed" });
      expect(parseDialpadRecordingEofResult(await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "mic", 1, 0, retainedSha]) as never)).toMatchObject({ status: "replayed" });
      await forceSealing(captureId);
      expect(parseDialpadRecordingEofResult(await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "mic", 1, 0, retainedSha]) as never)).toMatchObject({ status: "replayed" });
      expect((await failure(() => rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, "mic", 1, 0, sha("different-terminal-eof")]))).code).toBe("40001");
      expect((await failure(() => rpc("fn_get_dialpad_recording_lifecycle", [otherOrgId, captureId]))).code).toBe("P0002");
    });

    it("uses explicit EOF markers as effective seal evidence", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      for (const track of ["tab", "mic"] as const) {
        for (let seq = 0; seq < 3; seq += 1) await chunk(captureId, track, 1, seq);
        const eofSha = sha(`${track}-1-2`);
        expect(parseDialpadRecordingEofResult(await rpc("fn_mark_dialpad_recording_eof", [orgId, captureId, track, 1, 2, eofSha]) as never)).toMatchObject({ status: "recorded" });
      }
      await endCall(call);
      const claimed = await claim("explicit-eof-sealer");
      expect(claimed.status).toBe("claimed");
      const inputs = parseDialpadRecordingSealInputs(await rpc("fn_get_dialpad_recording_seal_inputs", [captureId, claimed.claimToken]) as never);
      expect(inputs.inputs.filter((input) => input.isEof).map((input) => `${input.track}:${input.seq}`)).toEqual(["tab:2", "mic:2"]);
      expect(await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")])).toMatchObject({ outcome: "sealed" });
    });

    it("waits for durable PCM EOF before an early transport claim, while expiry still permits degraded sealing", async () => {
      const first = await openedCapture();
      await authorizedEpoch(first.captureId);
      await fullTrack(first.captureId, "tab");
      await fullTrack(first.captureId, "mic");
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, first.captureId, "tab", 1, uuid(), JSON.stringify([{ startSample: 0, endSample: 100, evidenceRef: "pending:vad" }])]);
      await endCall(first.call);
      expect(await rpc("fn_claim_dialpad_recording_seal_work", ["before-measurement", 300])).toEqual({ status: "none" });

      for (const track of ["tab", "mic"] as const) {
        expect(await rpc("fn_record_dialpad_recording_pcm_progress", [
          orgId, first.captureId, track, 1, uuid(), 640, 640, 48000, 1, "opus", JSON.stringify([]),
        ])).toMatchObject({ status: "recorded", processedThroughSample: 640, pcmEofSample: 640 });
      }
      expect((await rpc("fn_claim_dialpad_recording_seal_work", ["after-measurement", 300])).status).toBe("claimed");

      const expired = await openedCapture();
      await authorizedEpoch(expired.captureId);
      await fullTrack(expired.captureId, "tab");
      await fullTrack(expired.captureId, "mic");
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, expired.captureId, "tab", 1, uuid(), JSON.stringify([{ startSample: 0, endSample: 100, evidenceRef: "expired:vad" }])]);
      await endCall(expired.call);
      await rpc("fn_get_dialpad_recording_lifecycle", [orgId, expired.captureId]);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [expired.captureId]);
      expect((await rpc("fn_claim_dialpad_recording_seal_work", ["expired-drain", 300])).status).toBe("claimed");
      const snapshot = parseDialpadRecordingVadSnapshot(await rpc("fn_get_dialpad_recording_vad_snapshot", [orgId, expired.captureId]) as never);
      expect(snapshot).toMatchObject({ measurementStatus: "provisional", degradedReasons: [] });
    });

    it("does not claim a zero-measurement capture between retention EOF and PCM EOF", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await fullTrack(captureId, "mic");
      await endCall(call);
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_pcm_batches where capture_id=$1", [captureId])).rows[0]!.n).toBe(0);
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_vad_batches where capture_id=$1", [captureId])).rows[0]!.n).toBe(0);
      expect(await rpc("fn_claim_dialpad_recording_seal_work", ["zero-before-pcm", 300])).toEqual({ status: "none" });
      for (const track of ["tab", "mic"] as const) {
        await rpc("fn_record_dialpad_recording_pcm_progress", [orgId, captureId, track, 1, uuid(), 640, 640, null, null, null, JSON.stringify([])]);
      }
      expect((await rpc("fn_claim_dialpad_recording_seal_work", ["zero-after-pcm", 300])).status).toBe("claimed");
    });

    it("normalizes missing EOF to false in partial seal inputs and result registration", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await chunk(captureId, "tab", 1, 0);
      await chunk(captureId, "mic", 1, 0);
      await endCall(call);
      await rpc("fn_get_dialpad_recording_lifecycle", [orgId, captureId]);
      await withoutTriggers("update public.dialpad_recording_captures set drain_deadline_at=now()-interval '1 second' where id=$1", [captureId]);
      const claimed = await rpc("fn_claim_dialpad_recording_seal_work", ["partial-expiry", 300]);
      expect(claimed.status).toBe("claimed");
      const inputs = parseDialpadRecordingSealInputs(await rpc("fn_get_dialpad_recording_seal_inputs", [captureId, claimed.claimToken]) as never);
      expect(inputs.inputs).toHaveLength(2);
      expect(inputs.inputs.every((input) => input.isEof === false)).toBe(true);
      expect(await register(captureId, claimed.claimToken, [decoded("tab"), decoded("mic")])).toMatchObject({ outcome: "partial" });
    });

    it("returns ordered seal inputs only for the active claim lease", async () => {
      const { call, captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "mic");
      await fullTrack(captureId, "tab");
      await endCall(call);
      const claimResult = await claim("transport-worker", 300);
      expect(claimResult.status).toBe("claimed");
      const claimToken = String(claimResult.claimToken);
      const inputs = parseDialpadRecordingSealInputs(await rpc("fn_get_dialpad_recording_seal_inputs", [captureId, claimToken]) as never);
      expect(inputs.inputs).toHaveLength(6);
      expect(inputs.inputs.map((input) => `${input.epoch}:${input.track}:${input.seq}`)).toEqual([
        "1:tab:0", "1:tab:1", "1:tab:2", "1:mic:0", "1:mic:1", "1:mic:2",
      ]);
      expect((await failure(() => rpc("fn_get_dialpad_recording_seal_inputs", [captureId, uuid()]))).code).toBe("42501");
      expect((await rpc("fn_get_dialpad_recording_seal_inputs", [captureId, claimToken])).inputs).toHaveLength(6);
      await withoutTriggers("update public.dialpad_recording_captures set lease_expires_at = now() - interval '1 second' where id=$1", [captureId]);
      expect((await failure(() => rpc("fn_get_dialpad_recording_seal_inputs", [captureId, claimToken]))).code).toBe("42501");
    });

    it("persists exact VAD ranges, unions overlaps, and latches a strict threshold once", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      const firstBatch = uuid();
      const exactRanges = JSON.stringify([{ startSample: 0, endSample: 4_800_000, evidenceRef: "vad:exact" }]);
      const exact = await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, firstBatch, exactRanges]);
      expect(parseDialpadRecordingVadResult(exact as never)).toMatchObject({ status: "recorded", voicedSamples: 4_800_000, measurementStatus: "provisional", threshold: { status: "not_latched" } });
      expect(parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, firstBatch, exactRanges]) as never)).toMatchObject({ status: "replayed", voicedSamples: 4_800_000 });

      const crossingBatch = uuid();
      const crossingRanges = JSON.stringify([
        { startSample: 4_800_000, endSample: 4_800_001, evidenceRef: "vad:cross" },
        { startSample: 4_800_000, endSample: 4_800_001, evidenceRef: "vad:duplicate" },
        { startSample: 4_800_100, endSample: 4_800_200, evidenceRef: "vad:gap" },
      ]);
      const crossed = parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, crossingBatch, crossingRanges]) as never);
      expect(crossed).toMatchObject({ status: "recorded", voicedSamples: 4_800_101, threshold: { status: "latched", crossingTotalSamples: 4_800_001, crossingEpoch: 1, crossingSample: 4_800_000, evidenceRef: "vad:cross" } });
      expect(parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, crossingBatch, crossingRanges]) as never)).toMatchObject({ status: "replayed", threshold: { status: "latched", crossingTotalSamples: 4_800_001 } });
      await forceSealing(captureId);
      expect(parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, crossingBatch, crossingRanges]) as never)).toMatchObject({ status: "replayed", threshold: { crossingSample: 4_800_000 } });
      expect((await failure(() => rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, crossingBatch, JSON.stringify([{ startSample: 4_800_000, endSample: 4_800_002, evidenceRef: "vad:conflict" }])]))).code).toBe("40001");
      expect((await failure(() => rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify([{ startSample: 5_000_000, endSample: 5_000_001, evidenceRef: "vad:late" }])]))).code).toBe("55000");
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_vad_threshold_latches where capture_id=$1", [captureId])).rows[0]!.n).toBe(1);
      expect((await pg.query("select measurement_status, provider_window_evidence, finalized_at from public.dialpad_recording_vad_totals where capture_id=$1", [captureId])).rows[0]).toMatchObject({ measurement_status: "provisional", provider_window_evidence: null, finalized_at: null });
    });

    it("keeps VAD epoch evidence replayable across a consumed restart epoch", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId, 1);
      await authorizedEpoch(captureId, 2);
      const batch1 = uuid();
      const batch2 = uuid();
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, batch1, JSON.stringify([{ startSample: 0, endSample: 100, evidenceRef: "epoch:1" }])]);
      const result = parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 2, batch2, JSON.stringify([{ startSample: 0, endSample: 50, evidenceRef: "epoch:2" }])]) as never);
      expect(result).toMatchObject({ voicedSamples: 150, highWaterEpoch: 2, highWaterEndSample: 50, measurementStatus: "provisional" });
      const rows = await pg.query("select epoch, start_sample, end_sample from public.dialpad_recording_vad_ranges where capture_id=$1 order by epoch", [captureId]);
      expect(rows.rows.map((row) => [row.epoch, row.start_sample, row.end_sample])).toEqual([[1, "0", "100"], [2, "0", "50"]]);
    });

    it("latches the exact crossing evidence after disjoint epoch ranges", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId, 1);
      await authorizedEpoch(captureId, 2);
      await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 1, uuid(), JSON.stringify([{ startSample: 0, endSample: 4_799_999, evidenceRef: "epoch:one" }])]);
      const crossed = parseDialpadRecordingVadResult(await rpc("fn_record_dialpad_recording_vad_ranges", [orgId, captureId, "tab", 2, uuid(), JSON.stringify([{ startSample: 10, endSample: 12, evidenceRef: "epoch:two-cross" }])]) as never);
      expect(crossed.threshold).toMatchObject({ status: "latched", crossingTotalSamples: 4_800_001, crossingEpoch: 2, crossingSample: 11, evidenceRef: "epoch:two-cross" });
    });

    it("records batched PCM continuity, EOF and degradation in a restart-safe snapshot", async () => {
      const { captureId } = await openedCapture();
      await authorizedEpoch(captureId);
      const firstBatch = uuid();
      const first = parseDialpadRecordingPcmProgressResult(await rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, firstBatch, 320, null, 48000, 1, "opus", JSON.stringify(["reconnect"]),
      ]) as never);
      expect(first).toMatchObject({ status: "recorded", processedThroughSample: 320, normalizedSampleRateHz: 16000, normalizedChannels: 1, sourceSampleRateHz: 48000, sourceChannels: 1, sourceCodec: "opus", degradedReasons: ["reconnect"] });
      const secondBatch = uuid();
      const second = parseDialpadRecordingPcmProgressResult(await rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, secondBatch, 640, 640, 48000, 1, "opus", JSON.stringify(["gap"]),
      ]) as never);
      expect(second).toMatchObject({ processedThroughSample: 640, pcmEofSample: 640, sourceSampleRateHz: 48000, sourceChannels: 1, sourceCodec: "opus", degradedReasons: ["gap", "reconnect"] });
      expect(parseDialpadRecordingPcmProgressResult(await rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, firstBatch, 320, null, 48000, 1, "opus", JSON.stringify(["reconnect"]),
      ]) as never)).toMatchObject({ status: "replayed", processedThroughSample: 640, pcmEofSample: 640 });
      expect((await failure(() => rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, uuid(), 960, 960, 48000, 1, "opus", JSON.stringify(["late"]),
      ]))).code).toBe("40001");
      expect((await failure(() => rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, uuid(), 320, 160, 48000, 1, "opus", JSON.stringify(["early-eof"]),
      ]))).code).toBe("22023");
      expect((await failure(() => rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, uuid(), 128, null, 48000, 1, "opus", JSON.stringify(["regression"]),
      ]))).code).toBe("40001");
      expect((await failure(() => rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, uuid(), 640, 640, 48000, null, "opus", JSON.stringify([]),
      ]))).code).toBe("22023");
      expect((await failure(() => pg.query(
        "insert into public.dialpad_recording_pcm_batches(batch_id,capture_id,org_id,track,epoch,processed_through_sample,source_sample_rate_hz,source_channels,source_codec,degraded_reasons,batch_sha256) values ($1,$2,$3,'tab',1,10,48000,null,'opus','[]'::jsonb,$4)",
        [uuid(), captureId, orgId, HASH_A],
      ))).code).toBe("23514");
      await forceSealing(captureId);
      expect(parseDialpadRecordingPcmProgressResult(await rpc("fn_record_dialpad_recording_pcm_progress", [
        orgId, captureId, "tab", 1, secondBatch, 640, 640, 48000, 1, "opus", JSON.stringify(["gap"]),
      ]) as never)).toMatchObject({ status: "replayed" });
      const snapshot = parseDialpadRecordingVadSnapshot(await rpc("fn_get_dialpad_recording_vad_snapshot", [orgId, captureId]) as never);
      expect(snapshot).toMatchObject({ version: 1, totalSamples: 0, epoch: null, epochCreditedThrough: null, degradedReasons: ["gap", "reconnect"] });
      expect(snapshot.processedPcm).toEqual([expect.objectContaining({ track: "tab", epoch: 1, processedThroughSample: 640, pcmEofSample: 640, sourceSampleRateHz: 48000, sourceChannels: 1, sourceCodec: "opus", normalizedSampleRateHz: 16000, normalizedChannels: 1, degradedReasons: ["gap", "reconnect"] })]);
    });
  });

  describe("20260929221000 Dialpad playback projection", () => {
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

    it("publishes two opaque track files and preserves sealed metadata in the library projection", async () => {
      const { captureId, token } = await sealedReady(nextPlaybackCallId());
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const activityId = (await captureRow(captureId)).call_activity_id;
      const sources = await rpc("fn_dialpad_recording_library_sources", [ownerId, "owner"]);
      const source = (sources as unknown as Array<Json>).find((item) => item.id === String(activityId));
      expect(source).toMatchObject({ source: "dialpad", actorId: repA });
      const files = (source?.files ?? []) as Array<Json>;
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.track)).toEqual(["mic", "tab"]);
      expect(files.every((file) => typeof file.id === "string" && /^dpf_[0-9a-f]{64}$/.test(String(file.id)))).toBe(true);
      expect(files.every((file) => file.completeness === "complete" && file.recordingStatus === "sealed")).toBe(true);
      const playback = await rpc("fn_dialpad_recording_playback_file", [ownerId, "owner", files[0]!.id]);
      expect(playback).toMatchObject({ source: "dialpad", file: { track: files[0]!.track, epoch: 1, completeness: "complete", recordingStatus: "sealed", bucket: "dialpad-recordings" } });
      expect(String((playback.file as Json).storagePath)).toBe(`${orgId}/${captureId}/final/1/${files[0]!.track}`);
    });

    it("executes the real Sandra search RPC with canonical UUIDs and fractional duration bounds", async () => {
      await seedSandraLibraryFixture();
      const { captureId, token } = await sealedReady(String(Date.now()));
      await register(captureId, token, [decoded("tab", 1, { decodedDurationMs: 4250 }), decoded("mic", 1, { decodedDurationMs: 4250 })]);
      const activityId = (await captureRow(captureId)).call_activity_id;
      const sources = await rpc("fn_dialpad_recording_library_sources", [ownerId, "owner"]);
      const source = (sources as unknown as Array<Json>).find((item) => item.id === String(activityId));
      expect(source).toMatchObject({ source: "dialpad", recordingStatus: "sealed" });
      const audio = JSON.stringify([source]);
      const exact = await rpc("fn_recording_library_search", [ownerId, "owner", JSON.stringify({ status: "all", min: "4.25", max: "4.25" }), audio]);
      expect((exact.rows as unknown[])).toHaveLength(1);
      expect(((exact.rows as Array<Json>)[0]!.files as Array<Json>).every((file) => file.duration === 4.25)).toBe(true);
      const outside = await rpc("fn_recording_library_search", [ownerId, "owner", JSON.stringify({ status: "all", min: "4.251", max: "4.251" }), audio]);
      expect(outside.rows).toEqual([]);
    });

    it("keeps a usable partial final playable while marking the capture partial", async () => {
      const { call, captureId } = await openedCapture(nextPlaybackCallId());
      await authorizedEpoch(captureId);
      await fullTrack(captureId, "tab");
      await endCall(call);
      await rpc("fn_close_dialpad_recording_capture", [orgId, captureId, null, "service_closed"]);
      const claimToken = uuid();
      await withoutTriggers("update public.dialpad_recording_captures set status='sealing', claim_token=$2, claimed_by='partial-playback', claimed_at=now(), lease_expires_at=now()+interval '5 minutes' where id=$1", [captureId, claimToken]);
      await register(captureId, claimToken, [decoded("tab")]);
      const activityId = (await captureRow(captureId)).call_activity_id;
      const sources = await rpc("fn_dialpad_recording_library_sources", [ownerId, "owner"]);
      const source = (sources as unknown as Array<Json>).find((item) => item.id === String(activityId));
      expect(source).toMatchObject({ source: "dialpad", recordingStatus: "partial" });
      expect(source?.files).toEqual([expect.objectContaining({ status: "available", track: "tab", completeness: "complete", recordingStatus: "partial" })]);
      const playback = await rpc("fn_dialpad_recording_playback_file", [ownerId, "owner", (source?.files as Array<Json>)[0]!.id]);
      expect(playback).toMatchObject({ file: { status: "available", completeness: "complete", recordingStatus: "partial" } });
    });

    it("denies guessed IDs, other reps and cross-org access", async () => {
      const { captureId, token } = await sealedReady(nextPlaybackCallId());
      await register(captureId, token, [decoded("tab"), decoded("mic")]);
      const activityId = (await captureRow(captureId)).call_activity_id;
      const sources = await rpc("fn_dialpad_recording_library_sources", [ownerId, "owner"]);
      const source = (sources as unknown as Array<Json>).find((item) => item.id === String(activityId))!;
      const fileId = ((source.files ?? []) as Array<Json>)[0]!.id;
      expect(await rpc("fn_dialpad_recording_playback_file", [repB, "mine", fileId])).toBeNull();
      expect(await rpc("fn_dialpad_recording_playback_file", [otherRep, "mine", fileId])).toBeNull();
      expect(await rpc("fn_dialpad_recording_playback_file", [ownerId, "owner", `dpf_${"f".repeat(64)}`])).toBeNull();
      expect((await pg.query("select count(*)::int as n from public.dialpad_recording_track_finals where capture_id=$1", [captureId])).rows[0]!.n).toBe(2);
    });
  });

  it("serializes two shadow finalizers and preserves one replay timestamp", async () => {
    const { captureId } = await committedShadowCapture();
    const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
    const [first, second] = await Promise.all([session(), session()]);
    const results = await Promise.all([
      clientRpc(first, "fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]),
      clientRpc(second, "fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: true, currentInputDigest: input.inputDigest });
  });

  it("keeps a provider commit after the finalizer snapshot visible as stale", async () => {
    const { call, captureId } = await committedShadowCapture();
    const input = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
    const ingester = await session();
    const finalizer = await session();
    await ingester.query("begin");
    await clientRpc(ingester, "fn_ingest_dialpad_call_event", [
      orgId,
      connectionId,
      1,
      payload("shadow-after-snapshot", call.start + 7000, call.custom, { master_call_id: call.callId }, "98765432123456788"),
    ]);
    const finalized = await clientRpc(finalizer, "fn_finalize_dialpad_recording_shadow", [orgId, captureId, input.inputDigest]);
    expect(finalized).toMatchObject({ replayed: false, inputDigest: input.inputDigest });
    await ingester.query("commit");
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed" });
  });

  it("does not deadlock finalization with standalone matching and resolver attribution", async () => {
    const { call, captureId } = await committedShadowCapture();
    const source = await session();
    const matcher = await session();
    const finalizer = await session();
    const ingested = await clientRpc(source, "fn_ingest_dialpad_call_event", [
      orgId,
      connectionId,
      1,
      payload("shadow-transfer", call.start + 8000, call.custom, { master_call_id: call.callId }, "98765432123456787"),
    ]);
    const eventId = String(ingested.eventId);
    const beforeMatcher = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
    await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, beforeMatcher.inputDigest]);
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: true, currentInputDigest: beforeMatcher.inputDigest });

    // Hold the matcher transaction open after its attribution update. The
    // finalizer must still complete against the last committed snapshot, then
    // the matcher commit must invalidate that snapshot through its marker.
    await matcher.query("begin");
    const matched = await clientRpc(matcher, "fn_match_dialpad_call_event", [eventId]);
    expect(matched).toMatchObject({ disposition: "quarantined", reason: "intent_already_matched" });
    const finalizedDuringMatch = await clientRpc(finalizer, "fn_finalize_dialpad_recording_shadow", [orgId, captureId, beforeMatcher.inputDigest]);
    expect(finalizedDuringMatch).toMatchObject({ replayed: true, inputDigest: beforeMatcher.inputDigest });
    const markersAfterMatch = await matcher.query<{ n: string }>("select count(*)::int as n from public.dialpad_recording_shadow_event_changes where event_id=$1", [eventId]);
    expect(Number(markersAfterMatch.rows[0]!.n)).toBe(2);
    await matcher.query("commit");
    const afterMatcher = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
    expect(afterMatcher.inputDigest).not.toBe(beforeMatcher.inputDigest);
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed" });

    // Establish a second committed baseline after quarantine, then hold the
    // resolver transaction open while finalization runs against that baseline.
    await rpc("fn_finalize_dialpad_recording_shadow", [orgId, captureId, afterMatcher.inputDigest]);
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: true, currentInputDigest: afterMatcher.inputDigest });
    await matcher.query("begin");
    const resolved = await clientRpc(matcher, "dialpad_cti_resolve_event", [eventId]);
    expect(resolved).toMatchObject({ disposition: "matched", leg: true });
    const finalizedDuringResolve = await clientRpc(finalizer, "fn_finalize_dialpad_recording_shadow", [orgId, captureId, afterMatcher.inputDigest]);
    expect(finalizedDuringResolve).toMatchObject({ replayed: true, inputDigest: afterMatcher.inputDigest });
    const markersAfterResolve = await matcher.query<{ n: string }>("select count(*)::int as n from public.dialpad_recording_shadow_event_changes where event_id=$1", [eventId]);
    expect(Number(markersAfterResolve.rows[0]!.n)).toBe(3);
    await matcher.query("commit");
    const afterResolve = await rpc("fn_get_dialpad_recording_shadow_input", [orgId, captureId]);
    expect(afterResolve.inputDigest).not.toBe(afterMatcher.inputDigest);
    expect(await rpc("fn_get_dialpad_recording_shadow_measurement", [orgId, captureId])).toMatchObject({ currentAtRead: false, staleReason: "provider_evidence_changed" });
  });

  describe("20260930001000 browser session authority", () => {
    const sessionOrg = () => orgs[0]!;
    const sessionRep = () => users[1]!;
    const sessionRpc = (name: string, args: unknown[]) => {
      const marks = args.map((_, index) => `$${index + 1}`).join(",");
      return service(async () => (await pg.query<{ v: Json }>(`select public.${name}(${marks}) as v`, args)).rows[0]!.v);
    };
    const sessionRpcAs = (name: string, org: string, rep: string, args: unknown[]) => sessionRpc(name, [org, rep, ...args]);
    const sessionMint = (id: string, expected: number, hash = nextHash()) => sessionRpc("fn_mint_dialpad_recording_next_epoch", [sessionOrg(), sessionRep(), id, expected, hash, 60]);
    const sessionStatus = (id: string) => sessionRpc("fn_get_dialpad_recording_browser_status", [sessionOrg(), sessionRep(), id]);

    beforeEach(async () => {
      // The playback search fixture intentionally rebinds these shared helper
      // variables to Sandra's canonical org. Restore the committed concurrency
      // fixture before opening any additional calls here.
      orgId = orgs[0]!;
      otherOrgId = orgs[1]!;
      ownerId = users[0]!;
      repA = users[1]!;
      repB = users[2]!;
      otherRep = users[3]!;
      connectionId = sessionConnectionId;
      contactId = sessionContactId;
      propertyId = sessionPropertyId;
      dialpadRepId = DIALPAD_REP_A;
      dialpadExternalNumber = "+18165550142";
      await pg.query("begin");
      NOW_MS = Date.now();
      callCounter += 1000;
    });

    afterEach(async () => {
      await pg.query("rollback");
      await pg.query("reset role");
    });

    it("advances a consumed zero-chunk epoch, fences stale callers, and reports the lifecycle watermark", async () => {
      const baseline = Number((await sessionStatus(captureId)).latestConsumedEpoch);
      const firstHash = nextHash();
      const first = await sessionMint(captureId, baseline, firstHash);
      expect(first).toMatchObject({ status: "minted", epoch: baseline + 1, controlVersion: 2 });
      expect(await sessionStatus(captureId)).toMatchObject({ latestConsumedEpoch: baseline, captureStatus: "open" });
      expect(await consume(firstHash)).toMatchObject({ status: "consumed", epoch: baseline + 1 });
      expect(await sessionStatus(captureId)).toMatchObject({ latestConsumedEpoch: baseline + 1 });
      expect(await sessionMint(captureId, baseline)).toMatchObject({ status: "denied", reason: "epoch_stale", latestConsumedEpoch: baseline + 1 });
      const second = await sessionMint(captureId, baseline + 1);
      expect(second).toMatchObject({ status: "minted", epoch: baseline + 2 });
    });

    it("does not rotate a live grant, accepts an expired pending grant, and denies the epoch cap", async () => {
      const baseline = Number((await sessionStatus(captureId)).latestConsumedEpoch);
      const expiredHash = nextHash();
      await pg.query(
        "insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,created_at,expires_at) values ($1,$2,$3,$4,$5,now()-interval '2 minutes',now()-interval '1 minute')",
        [sessionOrg(), captureId, sessionRep(), baseline + 1, expiredHash],
      );
      const replacementHash = nextHash();
      const replacement = await sessionMint(captureId, baseline, replacementHash);
      expect(replacement).toMatchObject({ status: "minted", epoch: baseline + 1 });
      expect(await sessionMint(captureId, baseline)).toMatchObject({ status: "denied", reason: "grant_pending" });
      expect(await consume(replacementHash)).toMatchObject({ status: "consumed", epoch: baseline + 1 });
      for (let epoch = baseline + 2; epoch <= 16; epoch += 1) {
        const hash = nextHash();
        expect((await sessionMint(captureId, epoch - 1, hash)).status).toBe("minted");
        expect((await consume(hash)).status).toBe("consumed");
      }
      expect(await sessionMint(captureId, 16)).toMatchObject({ status: "denied", reason: "epoch_limit", latestConsumedEpoch: 16 });
    });

    it("keeps browser mint/status service-only and denies closed capture replay", async () => {
      const baseline = Number((await sessionStatus(captureId)).latestConsumedEpoch);
      const authFailure = await failure(() => authenticated(sessionRep(), () => pg.query("select public.fn_get_dialpad_recording_browser_status($1,$2,$3)", [sessionOrg(), sessionRep(), captureId])));
      expect(authFailure.code).toBe("42501");
      await sessionRpc("fn_close_dialpad_recording_capture", [sessionOrg(), captureId, null, "service_closed"]);
      expect(await sessionMint(captureId, 0)).toMatchObject({ status: "denied", reason: "capture_not_open" });
      expect(await sessionStatus(captureId)).toMatchObject({ captureStatus: "closing", latestConsumedEpoch: baseline });
    });

    it("rejects new mint privilege escalation and cross-actor or cross-org capture guesses", async () => {
      const baseline = Number((await sessionStatus(captureId)).latestConsumedEpoch);
      const authFailure = await failure(() => authenticated(sessionRep(), () => pg.query(
        "select public.fn_mint_dialpad_recording_next_epoch($1,$2,$3,$4,$5,$6)",
        [sessionOrg(), sessionRep(), captureId, baseline, nextHash(), 60],
      )));
      expect(authFailure.code).toBe("42501");
      const otherActor = await failure(() => sessionRpcAs("fn_mint_dialpad_recording_next_epoch", sessionOrg(), users[2]!, [captureId, baseline, nextHash(), 60]));
      expect(otherActor.code).toBe("P0002");
      const otherOrg = await failure(() => sessionRpcAs("fn_mint_dialpad_recording_next_epoch", orgs[1]!, sessionRep(), [captureId, baseline, nextHash(), 60]));
      expect(otherOrg.code).toBe("P0002");
    });

    it("enforces the 64-grant cap and keeps legacy and next-epoch minting ordered", async () => {
      const { captureId: revokedCapture } = await openedCapture();
      const revokedBaseline = Number((await sessionStatus(revokedCapture)).latestConsumedEpoch);
      const revokedHash = nextHash();
      await withoutTriggers(
        "insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,expires_at,revoked_at) values ($1,$2,$3,$4,$5,now()+interval '1 minute',now())",
        [sessionOrg(), revokedCapture, sessionRep(), revokedBaseline + 1, revokedHash],
      );
      expect(await sessionMint(revokedCapture, revokedBaseline)).toMatchObject({ status: "minted", epoch: revokedBaseline + 1 });
      expect(await consume(revokedHash)).toMatchObject({ status: "denied", reason: "revoked" });

      const { captureId: freshCapture } = await openedCapture();
      const baseline = Number((await sessionStatus(freshCapture)).latestConsumedEpoch);
      await withoutTriggers(
        `insert into public.dialpad_recording_ingest_grants(org_id,capture_id,rep_user_id,epoch,token_hash,expires_at,revoked_at)
         select $1,$2,$3,1,repeat(md5(($2::uuid)::text || ':' || n::text),2),now()+interval '1 minute',now()
           from generate_series(1,64) as n`,
        [sessionOrg(), freshCapture, sessionRep()],
      );
      expect(await sessionMint(freshCapture, baseline)).toMatchObject({ status: "denied", reason: "grant_limit" });

      const { captureId: mixedCapture } = await openedCapture();
      const mixedBaseline = Number((await sessionStatus(mixedCapture)).latestConsumedEpoch);
      const legacyHash = nextHash();
      expect(await sessionRpc("fn_mint_dialpad_recording_ingest_grant", [sessionOrg(), sessionRep(), mixedCapture, mixedBaseline + 1, legacyHash, 60])).toMatchObject({ status: "minted", epoch: mixedBaseline + 1 });
      expect(await consume(legacyHash)).toMatchObject({ status: "consumed", epoch: mixedBaseline + 1 });
      expect(await sessionMint(mixedCapture, mixedBaseline + 1)).toMatchObject({ status: "minted", epoch: mixedBaseline + 2 });
    });

    it("checks active call and membership before accepting an exact-token replay", async () => {
      const { call, captureId: freshCapture } = await openedCapture();
      const baseline = Number((await sessionStatus(freshCapture)).latestConsumedEpoch);
      const hash = nextHash();
      expect(await sessionMint(freshCapture, baseline, hash)).toMatchObject({ status: "minted", epoch: baseline + 1 });
      await setDesignation(sessionRep(), sessionOrg(), false);
      expect(await sessionMint(freshCapture, baseline, hash)).toMatchObject({ status: "denied", reason: "rep_not_active" });
      await setDesignation(sessionRep(), sessionOrg(), true);
      await endCall(call);
      expect(await sessionMint(freshCapture, baseline, hash)).toMatchObject({ status: "denied", reason: "call_ended" });
    });
  });
});
