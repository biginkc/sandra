import { createHmac, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Fixture for the My Leads Phase 2 acceptance slice (TECH-PLAN 4.2, Phase 2 half). Written against
 * main plus #803/#809 only. Everything talks to the disposable database over its owner connection
 * (`acquisition_*` is closed to service_role, plan F5). Leads are synthetic, non-training, with
 * fictional 555-01xx phones; nothing here can reach a hosted database or a real Dialpad.
 */

export const CI_DIALPAD_USER_ID = "4242424242";
export const CI_WEBHOOK_SECRET_REF = "env:DIALPAD_CTI_WEBHOOK_SECRET_E2E";
/** `DIALPAD_CTI_DIAL_KEY_*` is the namespace `resolveDialpadDialKey` accepts (api-dial.ts). */
export const CI_DIAL_KEY_REF = "env:DIALPAD_CTI_DIAL_KEY_E2E";
/** The connection must allow this origin (`DIALPAD_CTI_TARGET_ORIGIN`, protocol.ts) for the dial bootstrap. */
export const CI_DIALPAD_ORIGIN = "https://dialpad.com";

const FLAG_COLUMNS = [
  "call_next_strip", "post_call_prompt", "click_to_dial", "native_matcher", "auto_prompt", "callback_alert",
  "call_screen", "contract_card", "seller_reminders", "artifact_fetch", "facts_job", "offer_projection", "comp_queue",
] as const;

type Env = Readonly<Record<string, string | undefined>>;
type Db = Pick<Pool, "query" | "connect">;
type Run = <R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<R>>;

/** The only lane this slice supports: a disposable stack reached over loopback. */
export function assertLaneSafe(lane: "ci", env: Env = process.env): void {
  if (lane !== "ci") throw new Error("the Phase 2 acceptance slice runs only in the ci lane");
  if (env.E2E_DISPOSABLE_DATABASE !== "1") {
    throw new Error("Phase 2 acceptance needs E2E_DISPOSABLE_DATABASE=1 (a disposable local stack).");
  }
  ciDatabaseUrl(env);
}

export function ciDatabaseUrl(env: Env = process.env): string {
  const url = env.E2E_CI_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Phase 2 acceptance needs E2E_CI_SUPABASE_DB_URL or TEST_SUPABASE_DB_URL.");
  return requireLoopbackPostgresUrl(url);
}

/** One transaction on one connection, optionally under a database role and JWT claims. */
async function inTx<T>(db: Db, setup: { role?: "service_role" | "authenticated"; sub?: string }, body: (run: Run) => Promise<T>): Promise<T> {
  const c: PoolClient = await db.connect();
  const run: Run = (sql, params) => c.query(sql, params);
  try {
    await run("begin");
    if (setup.role) {
      await run("select set_config('request.jwt.claim.role',$1,true)", [setup.role]);
      if (setup.sub) await run("select set_config('request.jwt.claim.sub',$1,true)", [setup.sub]);
      await run(`set local role ${setup.role}`);
    }
    const out = await body(run);
    await run("commit");
    return out;
  } catch (error) {
    await run("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
const asService = <T>(db: Db, body: (run: Run) => Promise<T>) => inTx(db, { role: "service_role" }, body);
/** Runs as the signed-in member: My Leads reads need a JWT identity (plan F4). */
export const asMember = <T>(db: Db, userId: string, body: (run: Run) => Promise<T>) => inTx(db, { role: "authenticated", sub: userId }, body);

/** The designation guard only lets `acquisitions_enabled` change under its marker setting. */
async function setDesignation(run: Run, orgId: string, userId: string, on: boolean): Promise<void> {
  await run("select set_config('my_leads.designation_update', ':' || $1::text || ':' || $2::text, true)", [orgId, userId]);
  await run("update public.memberships set acquisitions_enabled=$3 where org_id=$1 and user_id=$2", [orgId, userId, on]);
  await run("select set_config('my_leads.designation_update', '', true)");
}

export async function designateRep(db: Db, input: { orgId: string; repUserId: string }): Promise<void> {
  await db.query(
    "insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true) on conflict (org_id) do update set my_leads_enabled=true",
    [input.orgId],
  );
  await asService(db, (run) => setDesignation(run, input.orgId, input.repUserId, true));
}

/** Upserts the org's flags row: exactly the named flags true, every other flag false. */
export async function seedFeatureFlags(db: Db, orgId: string, on: readonly string[]): Promise<void> {
  const unknown = on.filter((f) => !(FLAG_COLUMNS as readonly string[]).includes(f));
  if (unknown.length > 0) throw new Error(`Unknown My Leads flag(s): ${unknown.join(", ")}`);
  const cols = FLAG_COLUMNS.join(", ");
  const vals = FLAG_COLUMNS.map((f) => (on.includes(f) ? "true" : "false")).join(", ");
  const sets = FLAG_COLUMNS.map((f) => `${f} = excluded.${f}`).join(", ");
  await asService(db, (run) =>
    run(`insert into public.my_leads_feature_flags(org_id, ${cols}) values ($1, ${vals}) on conflict (org_id) do update set ${sets}, updated_at = now()`, [orgId]),
  );
}

/** Active connection (E2E webhook secret ref, allowed origin, dummy dial key ref) and a verified binding for the rep. */
export async function seedDialpadForRep(db: Db, input: { orgId: string; repUserId: string }): Promise<{ connectionId: string }> {
  return asService(db, async (run) => {
    const found = await run<{ id: string }>("select id from public.dialpad_org_connections where org_id=$1", [input.orgId]);
    let connectionId = found.rows[0]?.id;
    if (connectionId) {
      await run(
        `update public.dialpad_org_connections
            set status='active', webhook_secret_ref=$2, allowed_origins=array[$3]::text[], dial_api_key_ref=$4, updated_at=now()
          where id=$1`,
        [connectionId, CI_WEBHOOK_SECRET_REF, CI_DIALPAD_ORIGIN, CI_DIAL_KEY_REF],
      );
    } else {
      const made = await run<{ id: string }>(
        `insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref,allowed_origins,dial_api_key_ref)
         values ($1,'active','e2e_p2_client',$2,array[$3]::text[],$4) returning id`,
        [input.orgId, CI_WEBHOOK_SECRET_REF, CI_DIALPAD_ORIGIN, CI_DIAL_KEY_REF],
      );
      connectionId = made.rows[0]!.id;
    }
    const bound = await run("select 1 from public.dialpad_member_bindings where org_id=$1 and user_id=$2 and status='verified'", [input.orgId, input.repUserId]);
    if (bound.rowCount === 0) {
      const claim = await run<{ v: { bindingId: string } }>("select public.fn_claim_dialpad_member_binding($1,$2,$3) as v", [input.orgId, input.repUserId, CI_DIALPAD_USER_ID]);
      await run("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','e2e-p2')", [claim.rows[0]!.v.bindingId]);
    }
    return { connectionId };
  });
}

/**
 * Puts the org back to its defaults. Every step is its own transaction and a failure never skips
 * the rest (the designation restore must always run or the next file's reset trigger refuses);
 * the first error is rethrown at the end. Dialpad evidence tables forbid deletes, so the
 * connection is disabled and bindings are revoked through their function.
 */
export async function resetCloseWorld(db: Db, input: { orgId: string; repUserId: string }): Promise<void> {
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push(e); } };
  await step(() => asService(db, (run) => setDesignation(run, input.orgId, input.repUserId, false)));
  await step(() => asService(db, (run) => run("delete from public.my_leads_feature_flags where org_id=$1", [input.orgId])));
  await step(() => asService(db, (run) => run("update public.dialpad_org_connections set status='disabled', updated_at=now() where org_id=$1", [input.orgId])));
  await step(() =>
    asService(db, async (run) => {
      const live = await run<{ id: string }>("select id from public.dialpad_member_bindings where org_id=$1 and status <> 'revoked'", [input.orgId]);
      for (const row of live.rows) await run("select public.fn_revoke_dialpad_member_binding($1,'p2 acceptance cleanup')", [row.id]);
    }),
  );
  if (errors.length > 0) throw errors[0];
}

/**
 * Disposable database only. Bindings reference auth.users with ON DELETE RESTRICT and forbid row
 * deletes, so the job's exact-run identity cleanup could never remove the test rep while one
 * exists. TRUNCATE fires no row triggers; refuses outside the ci lane.
 */
export async function purgeDialpadEvidenceCi(db: Db, env: Env = process.env): Promise<void> {
  assertLaneSafe("ci", env);
  await db.query("truncate table public.dialpad_member_bindings cascade");
}

export type SyntheticLead = { propertyId: string; contactId: string; address: string; phoneE164: string; episodeId: string; runTag: string };

/**
 * A synthetic lead assigned to the rep (so the assignment trigger opens a live episode), in queue
 * stage `contacted` with one old manual outreach attempt so it ranks in the Call next strip.
 * `training: true` makes the immutable training variant instead (service-role insert, dedicated
 * contact, `new_lead`), which gets no episode, queue row or attempt.
 */
export async function createSyntheticLead(
  db: Db,
  input: { orgId: string; repUserId: string; runTag: string; phoneE164: string; lastTouchDaysAgo?: number; training?: boolean },
): Promise<SyntheticLead> {
  if (!/^\+1\d{10}$/.test(input.phoneE164)) throw new Error("phoneE164 must look like +1XXXXXXXXXX");
  const propertyId = randomUUID();
  const contactId = randomUUID();
  const address = `${input.runTag} ${propertyId.slice(0, 8)} Fixture Ln`;
  const days = input.lastTouchDaysAgo ?? 20;
  const training = input.training === true;

  await db.query(
    "insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,'Seller',$4,'mobile')",
    [contactId, input.orgId, input.runTag, input.phoneE164],
  );
  await asService(db, (run) =>
    run(
      `insert into public.properties(id,org_id,address,city,state,zip,status,homeowner_contact_id,assigned_user_id,is_training)
       values ($1,$2,$3,'Kansas City','MO','64151','new_lead',$4,$5,$6)`,
      [propertyId, input.orgId, address, contactId, input.repUserId, training],
    ),
  );
  const ep = await db.query<{ id: string }>(
    "select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null order by assigned_at desc limit 1",
    [propertyId],
  );
  const episodeId = ep.rows[0]?.id ?? "";
  if (training) return { propertyId, contactId, address, phoneE164: input.phoneE164, episodeId, runTag: input.runTag };
  if (!episodeId) throw new Error("createSyntheticLead: no live assignment episode; is the rep designated and acquisitions enabled?");

  await db.query(
    `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at)
     values ($1,$2,'contacted', now() - make_interval(days => $3::int))
     on conflict (property_id,org_id) do update set stage='contacted', stage_entered_at=excluded.stage_entered_at`,
    [propertyId, input.orgId, days],
  );
  await db.query(
    `insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,idempotency_key,outcome)
     values ($1,$2,$3,$4,'outreach','manual', now() - make_interval(days => $5::int), $6, 'no_answer')`,
    [input.orgId, propertyId, episodeId, input.repUserId, days, randomUUID()],
  );
  return { propertyId, contactId, address, phoneE164: input.phoneE164, episodeId, runTag: input.runTag };
}

/** A prepared (not dispatched) intent for the lead, minted through the same function the dial path uses. */
export async function prepareDialpadIntent(
  db: Db,
  input: { orgId: string; repUserId: string; lead: SyntheticLead },
): Promise<{ intentId: string; customData: string }> {
  const r = await asService(db, (run) =>
    run<{ v: { intentId: string; customData: string } }>(
      "select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v",
      [input.orgId, input.repUserId, input.lead.propertyId, input.lead.contactId, randomUUID()],
    ),
  );
  return { intentId: r.rows[0]!.v.intentId, customData: String(r.rows[0]!.v.customData) };
}

export type DialIntentRow = {
  id: string; status: string; customData: string; destinationE164: string; idempotencyKey: string;
  dispatchAuthorizedAt: string | null; matchedProviderCallId: string | null;
};

/**
 * What a spec can know about a dial. The stub dialer's would-be request is held in the Next
 * server's memory (`readStubDialpadDials`, api-dial.ts) where a Playwright worker cannot read it,
 * so the durable intent row stands in for it. Exposing the list needs a `src/` change in #809.
 */
export async function readDialIntents(db: Db, propertyId: string): Promise<DialIntentRow[]> {
  const r = await db.query(
    `select id,status,custom_data,destination_e164,idempotency_key,dispatch_authorized_at,matched_provider_call_id
       from public.dialpad_call_intents where property_id=$1 order by prepared_at,id`,
    [propertyId],
  );
  return r.rows.map((x) => ({
    id: x.id, status: x.status, customData: x.custom_data, destinationE164: x.destination_e164, idempotencyKey: x.idempotency_key,
    dispatchAuthorizedAt: x.dispatch_authorized_at ? new Date(x.dispatch_authorized_at).toISOString() : null,
    matchedProviderCallId: x.matched_provider_call_id,
  }));
}

/**
 * Disposable database only. Makes an unmatched intent look three minutes old so the call-status
 * function reports `expired` and the rate/in-flight guards stop counting it. The intent guard
 * trigger protects immutable evidence, so it is disabled for this one statement inside a single
 * transaction (DDL is transactional, a failure restores it). Refuses outside the ci lane.
 */
export async function expireDialIntentCi(db: Db, intentId: string, env: Env = process.env): Promise<void> {
  assertLaneSafe("ci", env);
  await inTx(db, {}, async (run) => {
    await run("alter table public.dialpad_call_intents disable trigger dialpad_call_intents_guard");
    const r = await run(
      `update public.dialpad_call_intents
          set prepared_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute',
              dispatch_authorized_at = case when dispatch_authorized_at is null then null else now() - interval '2 minutes' end
        where id=$1 and status='prepared'`,
      [intentId],
    );
    if (r.rowCount !== 1) throw new Error("expireDialIntentCi: no unmatched prepared intent with that id");
    await run("alter table public.dialpad_call_intents enable trigger dialpad_call_intents_guard");
  });
}

/** `disposition:reason` of every stored event of one provider call. */
export async function readEventDispositions(db: Db, orgId: string, callId: string): Promise<string[]> {
  const r = await db.query(
    "select disposition || ':' || coalesce(disposition_reason,'') as d from public.dialpad_call_events where org_id=$1 and provider_call_id=$2 order by event_timestamp_ms,id",
    [orgId, callId],
  );
  return r.rows.map((x) => x.d as string);
}

const b64url = (v: string) => Buffer.from(v).toString("base64url");

/** HS256 compact JWT over the raw payload text (the construction `verifyDialpadWebhookJwt` expects). */
export function signDialpadWebhook(payloadText: string, secret: string): string {
  const signingInput = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(payloadText)}`;
  return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
}

export type DialpadEventInput = {
  callId: string;
  state: "calling" | "connected" | "hangup";
  /** 13-digit epoch milliseconds. */
  at: number;
  customData?: string;
  direction?: "outbound" | "inbound";
  externalNumber: string;
  targetUserId: string;
  shareLink?: string;
  adminRecordingUrl?: string;
  dateStarted?: number;
  dateConnected?: number;
  talkTimeMs?: number;
};

/** Raw payload text. `call_id` and `target.id` are written as bare integers: the app keeps 64-bit ids exact only as text. */
export function dialpadEventPayload(i: DialpadEventInput): string {
  if (!/^\d{1,20}$/.test(i.callId)) throw new Error("callId must be a decimal integer string");
  if (!/^\d{1,20}$/.test(i.targetUserId)) throw new Error("targetUserId must be a decimal integer string");
  if (!Number.isInteger(i.at) || String(i.at).length !== 13) throw new Error("at must be 13-digit epoch milliseconds");
  const started = i.dateStarted ?? i.at;
  const connected = i.dateConnected ?? started + 4_000;
  const hangup = i.state === "hangup";
  const fields: Record<string, unknown> = {
    state: i.state,
    event_timestamp: i.at,
    direction: i.direction ?? "outbound",
    external_number: i.externalNumber,
    internal_number: "+18165550100",
    target: { type: "user", id: "@@TARGET@@" },
    date_started: started,
  };
  if (i.customData) fields.custom_data = i.customData;
  if (i.state !== "calling") fields.date_connected = connected;
  if (hangup) {
    fields.date_ended = i.at;
    fields.talk_time = i.talkTimeMs ?? Math.max(0, i.at - connected);
    fields.was_recorded = Boolean(i.shareLink || i.adminRecordingUrl);
    if (i.shareLink) fields.public_call_review_share_link = i.shareLink;
    if (i.adminRecordingUrl) fields.admin_recording_urls = [i.adminRecordingUrl];
  }
  const body = JSON.stringify(fields).replace('"@@TARGET@@"', i.targetUserId);
  return `{"call_id":${i.callId},${body.slice(1)}`;
}

/** POSTs a signed body to the app's Dialpad voice webhook for one connection. */
export function postDialpadEvent(baseUrl: string, connectionId: string, jwt: string): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/$/, "")}/api/webhooks/dialpad/voice/${connectionId}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: jwt,
  });
}
