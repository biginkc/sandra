import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Local-only migration test for Dialpad CTI dispatch authorization (A2). Run with
 * `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch db> npm run test:integration:local`.
 * It rejects non-loopback URLs and is excluded from `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const readSql = (name: string) => readFileSync(path.resolve(__dirname, name), "utf8");
const foundationSql = readSql("20260929034021_dialpad_cti_foundation.sql");
const projectionSql = readSql("20260929120000_dialpad_cti_call_projection.sql");
const dispatchSql = readSql("20260929180000_dialpad_cti_dispatch.sql");

const uuid = () => crypto.randomUUID();
const DIALPAD_REP_A = "5150000000000001";
const ROOT_CALL = "6543210987654321098";
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

interface PgError extends Error {
  code?: string;
  detail?: string;
}

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
  await pg.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `CTI ${orgId}`, otherOrgId, `CTI ${otherOrgId}`]);
  await service(async () => {
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, orgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member'),($3,$2,'member')", [repA, orgId, repB]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [ownerId, otherOrgId]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [otherRep, otherOrgId]);
  });
  for (const [user, org] of [[repA, orgId], [repB, orgId], [otherRep, otherOrgId]] as const) await setDesignation(user, org, true);
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true),($2,true)", [orgId, otherOrgId]);
  await pg.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type,phone_2,phone_2_type) values ($1,$2,'Seller','(816) 555-0142','mobile','816-555-0143','landline')",
    [contactId, orgId],
  );
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 CTI Way','MO',$3,$4)",
    [propertyId, orgId, contactId, repA],
  );
  const connection = await service(() =>
    pg.query<{ id: string }>(
      "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,dialpad_company_id,directory_api_key_ref) values ($1,'active','client_abc','env:DIALPAD_CTI_WEBHOOK_SECRET_A','4040404040404040','env:DIALPAD_CTI_DIRECTORY_KEY_A') returning id",
      [orgId],
    ),
  );
  connectionId = connection.rows[0]!.id;
  bindingA = await verifiedBinding(orgId, repA, DIALPAD_REP_A);
}

type Json = Record<string, unknown>;

async function prepare(options: { slot?: number; grant?: string | null; ttl?: number; rep?: string } = {}): Promise<Json> {
  const result = await service(() =>
    pg.query<{ v: Json }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,$5::smallint,$6,$7,$8) as v", [
      orgId,
      options.rep ?? repA,
      propertyId,
      contactId,
      options.slot ?? 1,
      uuid(),
      options.grant ?? null,
      options.ttl ?? 600,
    ]),
  );
  return result.rows[0]!.v;
}

async function grantCaller(withIdentity = true, number = "+18165550100"): Promise<string> {
  const result = await service(() =>
    pg.query<{ v: { grantId: string } }>(
      withIdentity
        ? "select public.fn_grant_dialpad_caller($1,$2,$3,'Office','5555',$4) as v"
        : "select public.fn_grant_dialpad_caller($1,$2,$3,null,null,$4) as v",
      [orgId, repA, number, ownerId],
    ),
  );
  return result.rows[0]!.v.grantId;
}

async function authorize(intentId: unknown, org = orgId, rep = repA): Promise<Json> {
  const result = await service(() => pg.query<{ v: Json }>("select public.fn_authorize_dialpad_dispatch($1,$2,$3) as v", [org, rep, intentId]));
  return result.rows[0]!.v;
}

async function statusOf(intentId: unknown): Promise<Json> {
  const result = await service(() => pg.query<{ v: Json }>("select public.fn_get_dialpad_call_status($1,$2,$3) as v", [orgId, repA, intentId]));
  return result.rows[0]!.v;
}

async function intentRow(intentId: unknown): Promise<Json> {
  return (await pg.query("select * from public.dialpad_call_intents where id=$1", [intentId])).rows[0];
}

async function withoutTriggers(sql: string, params: unknown[] = []): Promise<void> {
  await pg.query("set local session_replication_role = replica");
  await pg.query(sql, params);
  await pg.query("set local session_replication_role = origin");
}

function payload(state: string, at: number, custom: string, extra: Record<string, unknown> = {}): string {
  const body = { state, event_timestamp: at, external_number: "+18165550142", internal_number: "+18165550100", direction: "outbound", target: { type: "user", id: "__T__" }, custom_data: custom, ...extra };
  return JSON.stringify(body).replace('"__T__"', DIALPAD_REP_A).replace(/^\{/, `{"call_id":${ROOT_CALL},`);
}

async function deliver(text: string): Promise<Json> {
  const ingested = await service(() => pg.query<{ v: { eventId: string } }>("select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v", [orgId, connectionId, text]));
  const processed = await service(() => pg.query<{ v: Json }>("select public.fn_process_dialpad_call_event($1) as v", [ingested.rows[0]!.v.eventId]));
  return processed.rows[0]!.v;
}

describe("20260929180000 Dialpad CTI dispatch migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl) });
    await pg.connect();
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(dispatchSql);
    await pg.query(dispatchSql);
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

  describe("connection identity configuration", () => {
    it("constrains the company id and the directory key reference to names, never values", async () => {
      for (const set of ["dialpad_company_id='abc'", "dialpad_company_id='123456789012345678901'", "directory_api_key_ref='op://vault/dialpad'", "directory_api_key_ref='env:PATH'", "directory_api_key_ref='env:DIALPAD_CTI_DIRECTORY_KEY_lower'"]) {
        expect((await failure(() => service(() => pg.query(`update public.dialpad_org_connections set ${set} where id=$1`, [connectionId])))).code).toBe("23514");
      }
    });

    it("keeps the company id and key reference out of the authenticated column grant", async () => {
      const readable = await authenticated(repA, () => pg.query("select id, org_id, status, cti_client_id, allowed_origins from public.dialpad_org_connections"));
      expect(readable.rows).toHaveLength(1);
      for (const column of ["dialpad_company_id", "directory_api_key_ref", "webhook_secret_ref"]) {
        expect((await failure(() => authenticated(repA, () => pg.query(`select ${column} from public.dialpad_org_connections`)))).code).toBe("42501");
      }
    });
  });

  describe("privileges", () => {
    it("is callable only by service_role", async () => {
      const intent = await prepare();
      for (const call of [
        (run: () => Promise<unknown>) => authenticated(repA, run),
        (run: () => Promise<unknown>) => anonymous(run),
      ]) {
        expect((await failure(() => call(() => pg.query("select public.fn_authorize_dialpad_dispatch($1,$2,$3)", [orgId, repA, intent.intentId])))).code).toBe("42501");
        expect((await failure(() => call(() => pg.query("select public.fn_get_dialpad_call_status($1,$2,$3)", [orgId, repA, intent.intentId])))).code).toBe("42501");
      }
      const grants = await pg.query<{ grantee: string }>(
        "select distinct grantee from information_schema.routine_privileges where routine_schema='public' and routine_name in ('fn_authorize_dialpad_dispatch','fn_get_dialpad_call_status') and grantee <> 'postgres'",
      );
      expect(grants.rows.map((row) => row.grantee)).toEqual(["service_role"]);
    });
  });

  describe("fn_authorize_dialpad_dispatch", () => {
    it("releases the dial payload once, with the frozen destination and custom_data", async () => {
      const intent = await prepare();
      const first = await authorize(intent.intentId);
      expect(first).toMatchObject({
        status: "authorized",
        intentId: intent.intentId,
        dial: { phoneNumber: "+18165550142", customData: intent.customData, identityType: null, identityId: null, outboundCallerId: null },
      });
      expect((await intentRow(intent.intentId)).dispatch_authorized_at).not.toBeNull();
    });

    it("sends the granted identity, or the caller number when the grant has no identity", async () => {
      const withIdentity = await grantCaller(true);
      const identityIntent = await prepare({ grant: withIdentity });
      expect((await authorize(identityIntent.intentId)).dial).toMatchObject({ identityType: "Office", identityId: "5555", outboundCallerId: null });
      await service(() => pg.query("select public.fn_revoke_dialpad_caller_grant($1,$2)", [withIdentity, ownerId]));
      const numberOnly = await grantCaller(false, "+18165550111");
      const numberIntent = await prepare({ grant: numberOnly });
      expect((await authorize(numberIntent.intentId)).dial).toMatchObject({ identityType: null, identityId: null, outboundCallerId: "+18165550111" });
    });

    it("cannot release the payload twice: retries return already_dispatched without a dial", async () => {
      const intent = await prepare();
      const first = await authorize(intent.intentId);
      const stamp = (await intentRow(intent.intentId)).dispatch_authorized_at;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await authorize(intent.intentId);
        expect(retry).toMatchObject({ status: "already_dispatched", intentId: intent.intentId });
        expect(retry).not.toHaveProperty("dial");
        expect(JSON.stringify(retry)).not.toContain(String(intent.customData));
      }
      expect(first.status).toBe("authorized");
      expect((await intentRow(intent.intentId)).dispatch_authorized_at).toEqual(stamp);
    });

    it("treats an idempotent re-prepare as the same intent, so a retried prepare-then-authorize cannot dial twice", async () => {
      const key = uuid();
      const prepareWith = () =>
        service(() => pg.query<{ v: Json }>("select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v", [orgId, repA, propertyId, contactId, key]));
      const first = (await prepareWith()).rows[0]!.v;
      const second = (await prepareWith()).rows[0]!.v;
      expect(second).toMatchObject({ intentId: first.intentId, replayed: true });
      expect((await authorize(first.intentId)).status).toBe("authorized");
      expect((await authorize(second.intentId)).status).toBe("already_dispatched");
    });

    it("scopes the intent to the caller org and rep", async () => {
      const intent = await prepare();
      expect((await failure(() => authorize(intent.intentId, otherOrgId, otherRep))).code).toBe("P0002");
      expect((await failure(() => authorize(intent.intentId, orgId, repB))).code).toBe("P0002");
      expect((await failure(() => authorize(uuid()))).code).toBe("P0002");
      expect((await failure(() => authorize(null))).code).toBe("22023");
      expect((await intentRow(intent.intentId)).dispatch_authorized_at).toBeNull();
    });

    it("returns cancelled, matched and expired states without a payload or a dispatch stamp", async () => {
      const cancelled = await prepare();
      await service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repA, cancelled.intentId]));
      expect(await authorize(cancelled.intentId)).toEqual({ status: "cancelled", intentId: cancelled.intentId });

      const expired = await prepare({ ttl: 60 });
      await withoutTriggers("update public.dialpad_call_intents set prepared_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' where id=$1", [expired.intentId]);
      const expiredResult = await authorize(expired.intentId);
      expect(expiredResult).toMatchObject({ status: "expired" });
      expect(expiredResult).not.toHaveProperty("dial");
      expect((await intentRow(expired.intentId)).dispatch_authorized_at).toBeNull();

      const matched = await prepare();
      await deliver(payload("calling", NOW_MS + 1000, String(matched.customData), { date_started: NOW_MS + 1000 }));
      expect(await authorize(matched.intentId)).toEqual({ status: "matched", intentId: matched.intentId });
    });

    describe("revalidates every frozen fact at dispatch and cancels the intent permanently on failure", () => {
      async function expectDenied(intentId: unknown, denial: string): Promise<void> {
        const result = await authorize(intentId);
        expect(result).toMatchObject({ status: "denied", denial });
        expect(result).not.toHaveProperty("dial");
        const row = await intentRow(intentId);
        expect(row).toMatchObject({ status: "cancelled", dispatch_authorized_at: null });
        expect(row.cancelled_at).not.toBeNull();
      }

      it("binding no longer verified", async () => {
        const intent = await prepare();
        await withoutTriggers("update public.dialpad_member_bindings set status='revoked', revoked_at=now(), revoked_reason='test' where id=$1", [bindingA]);
        await expectDenied(intent.intentId, "binding_not_verified");
      });

      it("binding revoked through the service (which already cancels prepared intents)", async () => {
        const intent = await prepare();
        await service(() => pg.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded')", [bindingA]));
        expect(await authorize(intent.intentId)).toEqual({ status: "cancelled", intentId: intent.intentId });
      });

      it("caller grant revoked or missing", async () => {
        const grant = await grantCaller();
        const intent = await prepare({ grant });
        await withoutTriggers("update public.dialpad_number_grants set status='revoked', revoked_at=now(), revoked_by=$2 where id=$1", [grant, ownerId]);
        await expectDenied(intent.intentId, "caller_grant_unavailable");
        const second = await grantCaller(true, "+18165550122");
        const viaService = await prepare({ grant: second });
        await service(() => pg.query("select public.fn_revoke_dialpad_caller_grant($1,$2)", [second, ownerId]));
        expect(await authorize(viaService.intentId)).toEqual({ status: "cancelled", intentId: viaService.intentId });
      });

      it("assignment moved to another rep", async () => {
        const intent = await prepare();
        await pg.query("update public.properties set assigned_user_id=$2 where id=$1", [propertyId, repB]);
        await expectDenied(intent.intentId, "not_assigned_rep");
      });

      it("frozen episode ended and replaced by a new episode for the same rep", async () => {
        const intent = await prepare();
        await pg.query("update public.properties set assigned_user_id=$2 where id=$1", [propertyId, repB]);
        await pg.query("update public.properties set assigned_user_id=$2 where id=$1", [propertyId, repA]);
        await expectDenied(intent.intentId, "not_assigned_rep");
      });

      it("contact turned do-not-contact (locks the property), and directly", async () => {
        const first = await prepare();
        await pg.query("update public.contacts set do_not_contact=true where id=$1", [contactId]);
        await expectDenied(first.intentId, "property_dnc_locked");
      });

      it("contact do-not-contact without a property lock", async () => {
        const intent = await prepare();
        await withoutTriggers("update public.contacts set do_not_contact=true where id=$1", [contactId]);
        await expectDenied(intent.intentId, "contact_do_not_contact");
      });

      it("phone at the frozen slot changed or removed", async () => {
        const changed = await prepare();
        await pg.query("update public.contacts set phone_1='(816) 555-0199' where id=$1", [contactId]);
        await expectDenied(changed.intentId, "phone_unavailable");
        const removed = await prepare({ slot: 2 });
        await pg.query("update public.contacts set phone_2=null where id=$1", [contactId]);
        await expectDenied(removed.intentId, "phone_unavailable");
      });

      it("phone added to the global do-not-call registry", async () => {
        const intent = await prepare();
        await service(() =>
          pg.query(
            "insert into public.global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256) values ($1,'+18165550142',gen_random_uuid(),gen_random_uuid(),repeat('a',64))",
            [orgId],
          ),
        );
        await expectDenied(intent.intentId, "phone_dnc");
      });

      it("property DNC-locked", async () => {
        const locked = await prepare();
        await pg.query("update public.properties set is_dnc_locked=true where id=$1", [propertyId]);
        await expectDenied(locked.intentId, "property_dnc_locked");
      });

      it("property deleted", async () => {
        const deleted = await prepare();
        await pg.query("update public.properties set deleted_at=now() where id=$1", [propertyId]);
        await expectDenied(deleted.intentId, "property_unavailable");
      });

      it("rep loses the acquisitions designation, or the connection or My Leads is switched off", async () => {
        const designation = await prepare();
        await setDesignation(repA, orgId, false);
        await expectDenied(designation.intentId, "rep_not_active");
        await setDesignation(repA, orgId, true);

        const connection = await prepare();
        await service(() => pg.query("update public.dialpad_org_connections set status='disabled' where id=$1", [connectionId]));
        await expectDenied(connection.intentId, "connection_inactive");
        await service(() => pg.query("update public.dialpad_org_connections set status='active' where id=$1", [connectionId]));

        const settings = await prepare();
        await pg.query("update public.acquisition_org_settings set my_leads_enabled=false where org_id=$1", [orgId]);
        await expectDenied(settings.intentId, "my_leads_disabled");
      });

      it("does not revive a denied intent when the reason later clears", async () => {
        const intent = await prepare();
        await pg.query("update public.contacts set phone_1='(816) 555-0199' where id=$1", [contactId]);
        await expectDenied(intent.intentId, "phone_unavailable");
        await pg.query("update public.contacts set phone_1='(816) 555-0142' where id=$1", [contactId]);
        expect(await authorize(intent.intentId)).toEqual({ status: "cancelled", intentId: intent.intentId });
      });

      it("does not re-check facts once the payload has been released (a retry is only ever already_dispatched)", async () => {
        const intent = await prepare();
        expect((await authorize(intent.intentId)).status).toBe("authorized");
        await pg.query("update public.contacts set phone_1='(816) 555-0199' where id=$1", [contactId]);
        const retry = await authorize(intent.intentId);
        expect(retry.status).toBe("already_dispatched");
        expect(retry).not.toHaveProperty("dial");
      });
    });

    it("guards the dispatch stamp: set once, only while prepared, never cleared, never on insert", async () => {
      const intent = await prepare();
      await authorize(intent.intentId);
      const rewrite = (sql: string) => failure(() => service(() => pg.query(sql, [intent.intentId])));
      expect((await rewrite("update public.dialpad_call_intents set dispatch_authorized_at=null where id=$1")).code).toBe("42501");
      expect((await rewrite("update public.dialpad_call_intents set dispatch_authorized_at=now() + interval '1 hour' where id=$1")).code).toBe("42501");
      const other = await prepare();
      expect(
        (await failure(() => service(() => pg.query("update public.dialpad_call_intents set status='cancelled', cancelled_at=now(), dispatch_authorized_at=now() where id=$1", [other.intentId])))).code,
      ).toBe("42501");
      expect(
        (
          await failure(() =>
            service(() =>
              pg.query(
                `insert into public.dialpad_call_intents (org_id, connection_id, rep_user_id, binding_id, dialpad_user_id, property_id, contact_id, phone_slot, destination_e164, assignment_episode_id, custom_data, idempotency_key, request_hash, expires_at, dispatch_authorized_at)
                 select org_id, connection_id, rep_user_id, binding_id, dialpad_user_id, property_id, contact_id, phone_slot, destination_e164, assignment_episode_id, 'sandra.dialpad.v1.' || repeat('1',48), gen_random_uuid(), repeat('a',64), now() + interval '5 minutes', now()
                 from public.dialpad_call_intents where id=$1`,
                [other.intentId],
              ),
            ),
          )
        ).code,
      ).toBe("42501");
    });

    it("keeps the dispatch stamp when a signed event later matches the call", async () => {
      const intent = await prepare();
      await authorize(intent.intentId);
      await deliver(payload("calling", NOW_MS + 1000, String(intent.customData), { date_started: NOW_MS + 1000 }));
      const row = await intentRow(intent.intentId);
      expect(row.status).toBe("matched");
      expect(row.dispatch_authorized_at).not.toBeNull();
    });
  });

  describe("fn_get_dialpad_call_status", () => {
    it("derives state from the frozen intent and the webhook projection only", async () => {
      const intent = await prepare();
      expect(await statusOf(intent.intentId)).toMatchObject({ state: "prepared", callActivityId: null, endedAt: null });
      await authorize(intent.intentId);
      expect(await statusOf(intent.intentId)).toMatchObject({ state: "awaiting_provider" });

      const start = NOW_MS + 1000;
      await deliver(payload("calling", start, String(intent.customData), { date_started: start }));
      const ringing = await statusOf(intent.intentId);
      expect(ringing).toMatchObject({ state: "in_progress", endedAt: null });
      expect(ringing.callActivityId).not.toBeNull();

      await deliver(payload("connected", start + 4000, String(intent.customData), { date_started: start, date_connected: start + 4000 }));
      expect(await statusOf(intent.intentId)).toMatchObject({ state: "in_progress", endedAt: null });

      await deliver(
        payload("hangup", start + 64_000, String(intent.customData), { date_started: start, date_connected: start + 4000, date_ended: start + 64_000, talk_time: 60_000, was_recorded: true }),
      );
      const ended = await statusOf(intent.intentId);
      expect(ended).toMatchObject({ state: "ended", durationSeconds: 64, talkDurationSeconds: 60 });
      expect(ended.endedAt).not.toBeNull();
      expect(ended.attemptId).not.toBeNull();
    });

    it("reports cancelled and expired, and never reports in_progress for an unmatched intent", async () => {
      const cancelled = await prepare();
      await service(() => pg.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [orgId, repA, cancelled.intentId]));
      expect(await statusOf(cancelled.intentId)).toMatchObject({ state: "cancelled" });

      const expired = await prepare({ ttl: 60 });
      await authorize(expired.intentId);
      await withoutTriggers("update public.dialpad_call_intents set prepared_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' where id=$1", [expired.intentId]);
      expect(await statusOf(expired.intentId)).toMatchObject({ state: "expired", callActivityId: null });
    });

    it("scopes to the org and rep", async () => {
      const intent = await prepare();
      expect((await failure(() => service(() => pg.query("select public.fn_get_dialpad_call_status($1,$2,$3)", [otherOrgId, otherRep, intent.intentId])))).code).toBe("P0002");
      expect((await failure(() => service(() => pg.query("select public.fn_get_dialpad_call_status($1,$2,$3)", [orgId, repB, intent.intentId])))).code).toBe("P0002");
    });
  });
});

/**
 * Two-client interleavings need committed rows, so this block seeds real data,
 * runs the transactions on separate connections, and removes its org, users and
 * rows afterwards (replica role: the CTI tables are append-only by trigger).
 * Scratch database only.
 */
describe("20260929180000 authorize versus revoke serialization", () => {
  let c1: Client;
  let c2: Client;
  let admin: Client;
  const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
  const url = () => requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? localDbUrl);

  async function begin(client: Client): Promise<void> {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  }

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

  const callAuthorize = (client: Client, intentId: unknown) =>
    client.query<{ v: Json }>("select public.fn_authorize_dialpad_dispatch($1,$2,$3) as v", [orgId, repA, intentId]);

  beforeAll(async () => {
    pg = new Client({ connectionString: url() });
    c1 = new Client({ connectionString: url() });
    c2 = new Client({ connectionString: url() });
    await Promise.all([pg.connect(), c1.connect(), c2.connect()]);
    admin = pg;
    await pg.query(foundationSql);
    await pg.query(projectionSql);
    await pg.query(dispatchSql);
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

  let intentId: unknown;

  beforeEach(async () => {
    NOW_MS = Date.now();
    await pg.query("begin");
    await seedFixture();
    intentId = (await prepare()).intentId;
    await pg.query("commit");
    created.orgs.push(orgId, otherOrgId);
    created.users.push(ownerId, repA, repB, otherRep);
  });

  afterEach(async () => {
    await Promise.all([c1.query("rollback"), c2.query("rollback")]);
  });

  it("makes a binding revoke wait for an in-flight authorize, which then cancels the just-authorized intent", async () => {
    const revokerPid = (await c2.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c1);
    expect((await callAuthorize(c1, intentId)).rows[0]!.v.status).toBe("authorized");
    await begin(c2);
    const revoke = settle(c2.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded') as v", [bindingA]));
    await waitUntilBlocked(admin, revokerPid);
    await c1.query("commit");
    expect((await revoke).ok).toBe(true);
    await c2.query("commit");
    // The payload was already released by the committed authorize; the revoke
    // serialized after it, so the intent is cancelled and can never be released again.
    expect(await intentRow(intentId)).toMatchObject({ status: "cancelled" });
    expect(((await callAuthorize(admin, intentId)).rows[0]!.v as Json).status).toBe("cancelled");
  });

  it("makes an authorize that races a committed binding revoke release nothing", async () => {
    const authorizerPid = (await c1.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c2);
    await c2.query("select public.fn_revoke_dialpad_member_binding($1,'offboarded')", [bindingA]);
    await begin(c1);
    const authorizing = settle(callAuthorize(c1, intentId));
    await waitUntilBlocked(admin, authorizerPid);
    await c2.query("commit");
    const outcome = await authorizing;
    expect(outcome.ok && outcome.value.rows[0]!.v).toEqual({ status: "cancelled", intentId });
    await c1.query("commit");
    expect((await intentRow(intentId)).dispatch_authorized_at).toBeNull();
  });

  it("releases the payload to exactly one of two concurrent authorize calls", async () => {
    const secondPid = (await c2.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await begin(c1);
    await begin(c2);
    const first = await callAuthorize(c1, intentId);
    const second = settle(callAuthorize(c2, intentId));
    await waitUntilBlocked(admin, secondPid);
    await c1.query("commit");
    const outcome = await second;
    await c2.query("commit");
    expect(first.rows[0]!.v.status).toBe("authorized");
    expect(outcome.ok && outcome.value.rows[0]!.v).toMatchObject({ status: "already_dispatched" });
    expect(outcome.ok && outcome.value.rows[0]!.v).not.toHaveProperty("dial");
  });
});
