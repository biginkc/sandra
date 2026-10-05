import { createHmac, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { assertProdSupabaseUrl } from "../../src/lib/prod-canary/env";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Fixture module for the My Leads one-call-close acceptance lanes (TECH-PLAN Phase 4, item 4.2).
 *
 * Everything here talks to Postgres directly: `acquisition_*` tables are closed to `service_role`
 * (plan fact F5), so the disposable CI database's owner connection is the only honest seam. The
 * synthetic lead is a NON-training lead (training leads get no attempt row, F2) and is never
 * deleted: Dialpad intents and events are permanent evidence (F1), so cleanup is lifecycle
 * cancellation plus soft retirement (`properties.deleted_at`).
 *
 * Phase 2/3 helpers (stub dial record reads, comps variants, Dropbox Sign stub) are typed TODO
 * hooks until those phases merge; see the bottom of this file.
 */

export type CloseLane = "ci" | "preview" | "production";

/** The thirteen `my_leads_feature_flags` kill switches, in column order. */
export const MY_LEADS_CLOSE_FLAGS = [
  "call_next_strip",
  "post_call_prompt",
  "click_to_dial",
  "native_matcher",
  "auto_prompt",
  "callback_alert",
  "call_screen",
  "contract_card",
  "seller_reminders",
  "artifact_fetch",
  "facts_job",
  "offer_projection",
  "comp_queue",
] as const;
export type MyLeadsCloseFlag = (typeof MY_LEADS_CLOSE_FLAGS)[number];

/** Dialpad user id of the bound rep in the CI lane. */
export const CI_DIALPAD_USER_ID = "4242424242";
/** `webhook_secret_ref` of the CI connection; the value lives only in the Next server env. */
export const CI_WEBHOOK_SECRET_REF = "env:DIALPAD_CTI_WEBHOOK_SECRET_E2E";
export const CI_WEBHOOK_SECRET_ENV = "DIALPAD_CTI_WEBHOOK_SECRET_E2E";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Same rule as `assertCanaryOwned` in e2e/prod-canary/support.ts (a value must carry the PROD-CANARY
 * label before any write). Re-stated here because importing that module loads `.env.local` into
 * `process.env` as a side effect, which the CI lane must never do.
 */
export function assertCanaryOwned(value: string, context: string): void {
  if (!value.includes("PROD-CANARY")) {
    throw new Error(`${context} must include PROD-CANARY before cleanup/write.`);
  }
}

/**
 * Throws unless the lane's safety preconditions hold.
 * ci: `E2E_DISPOSABLE_DATABASE==='1'` and a loopback `E2E_CI_SUPABASE_DB_URL`/`TEST_SUPABASE_DB_URL`.
 * preview/production: `RUN_PROD_CANARIES==='1'`, at least one owned phone in
 * `MY_LEADS_CLOSE_OWNED_PHONES`, a `MY_LEADS_CLOSE_RUN_TAG` carrying the PROD-CANARY label
 * (`assertCanaryOwned`) and a `NEXT_PUBLIC_SUPABASE_URL` that is the production project
 * (`assertProdSupabaseUrl`). The attended spec (item 4.4) adds the Hugo state check.
 */
export function assertLaneSafe(lane: CloseLane, env: Env = process.env): void {
  if (lane === "ci") {
    if (env.E2E_DISPOSABLE_DATABASE !== "1") {
      throw new Error("my-leads-close ci lane requires E2E_DISPOSABLE_DATABASE=1 (a disposable local stack).");
    }
    requireLoopbackPostgresUrl(ciDatabaseUrl(env));
    return;
  }
  if (env.RUN_PROD_CANARIES !== "1") {
    throw new Error("Production canaries are disabled (set RUN_PROD_CANARIES=1 to run the attended lane).");
  }
  const phones = (env.MY_LEADS_CLOSE_OWNED_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (phones.length === 0 || !phones.every((p) => /^\+1\d{10}$/.test(p))) {
    throw new Error("The attended lane needs MY_LEADS_CLOSE_OWNED_PHONES (comma-separated +1XXXXXXXXXX owned numbers).");
  }
  assertCanaryOwned(env.MY_LEADS_CLOSE_RUN_TAG ?? "", "MY_LEADS_CLOSE_RUN_TAG");
  assertProdSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

/** The disposable database URL the ci lane may use; never a hosted one. */
export function ciDatabaseUrl(env: Env = process.env): string {
  const url = env.E2E_CI_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL ?? "";
  if (!url) throw new Error("my-leads-close ci lane needs E2E_CI_SUPABASE_DB_URL or TEST_SUPABASE_DB_URL.");
  return requireLoopbackPostgresUrl(url);
}

export type SyntheticLead = {
  propertyId: string;
  contactId: string;
  address: string;
  phoneE164: string;
  episodeId: string;
  runTag: string;
};

/** The retained inventory after retirement; nothing is ever deleted. */
export type CleanupReport = {
  attempts: number;
  offers: number;
  notes: number;
  intents: number;
  events: number;
  cancelledTasks: number;
  openTasks: number;
  propertyDeletedAt: string | null;
};

type Queryable = Pick<Pool, "query" | "connect">;

/** Runs `fn` on one connection inside a transaction with `set local role service_role` and the matching claim. */
async function asService<T>(db: Queryable, fn: (q: { query: Pool["query"] }) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
    const out = await fn({ query: client.query.bind(client) as Pool["query"] });
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` as the authenticated member `userId` inside one transaction (My Leads reads need a JWT identity, F4). */
export async function asMember<T>(db: Queryable, userId: string, fn: (q: { query: Pool["query"] }) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await client.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await client.query("set local role authenticated");
    const out = await fn({ query: client.query.bind(client) as Pool["query"] });
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Designates `repUserId` for My Leads in `orgId` (acquisitions_enabled through the designation guard)
 * and makes sure the org has My Leads on. Idempotent.
 */
export async function designateRep(db: Queryable, input: { orgId: string; repUserId: string; ownerUserId?: string }): Promise<void> {
  await db.query(
    `insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)
     on conflict (org_id) do update set my_leads_enabled=true`,
    [input.orgId],
  );
  await asService(db, async (q) => {
    await q.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [input.orgId, input.repUserId]);
    await q.query("update public.memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2", [input.orgId, input.repUserId]);
    await q.query("select set_config('my_leads.designation_update', '', true)");
  });
}

/**
 * Undoes what the spec's setup switched on for `orgId`, so the next file starts from the defaults:
 * the flags row and seller reminder settings are deleted, the Dialpad connection is disabled (the
 * table forbids deletes) and every live binding revoked (append-only evidence), and the rep's
 * `acquisitions_enabled` goes back to false through the same designation guard marker.
 */
export async function resetCloseWorld(db: Queryable, input: { orgId: string; repUserId: string }): Promise<void> {
  // Each step is its own transaction and a failure in one never skips the others: the designation
  // restore in particular must always run, or `reset_tenant_tables()` of the next spec file fails
  // with MY_LEADS_DESIGNATION_FORBIDDEN. The first error is rethrown after every step has run.
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      errors.push(error);
    }
  };

  // Designation first (through the same guard marker the setup used).
  await step(() =>
    asService(db, async (q) => {
      await q.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [input.orgId, input.repUserId]);
      await q.query("update public.memberships set acquisitions_enabled=false where org_id=$1 and user_id=$2", [input.orgId, input.repUserId]);
      await q.query("select set_config('my_leads.designation_update', '', true)");
    }),
  );
  await step(() => asService(db, (q) => q.query("delete from public.my_leads_feature_flags where org_id=$1", [input.orgId])));
  await step(() =>
    asService(db, (q) =>
      q.query("update public.dialpad_org_connections set status='disabled', updated_at=now() where org_id=$1", [input.orgId]),
    ),
  );
  // `service_role` only has SELECT on the bindings table; revocation goes through the SECURITY
  // DEFINER function (which also cancels the binding's prepared intents). The table forbids deletes.
  await step(() =>
    asService(db, async (q) => {
      const live = await q.query<{ id: string }>(
        "select id from public.dialpad_member_bindings where org_id=$1 and status <> 'revoked'",
        [input.orgId],
      );
      for (const row of live.rows) {
        await q.query("select public.fn_revoke_dialpad_member_binding($1,'e2e cleanup')", [row.id]);
      }
    }),
  );
  await step(() => db.query("delete from public.seller_reminder_settings where org_id=$1", [input.orgId]));
  if (errors.length > 0) throw errors[0];
}

/**
 * CI lane only (disposable database): empties the append-only Dialpad evidence tables. The
 * bindings (and intents) reference `auth.users` with ON DELETE RESTRICT and forbid row deletes, so
 * the exact-run identity cleanup at the end of the job ("Database error deleting user") can never
 * remove the test rep while a binding exists. TRUNCATE fires no row triggers; the owner connection
 * may run it. Refuses to run outside the loopback `ci` lane.
 */
export async function purgeDialpadEvidenceCi(db: Queryable, env: Env = process.env): Promise<void> {
  assertLaneSafe("ci", env);
  await db.query("truncate table public.dialpad_member_bindings cascade");
}

/**
 * Non-training lead (`is_training=false`), not DNC-locked, one callable phone, state MO, assigned to
 * `repUserId` so the assignment observer opens a live episode, queue stage `contacted`, last touch
 * `lastTouchDaysAgo` days ago through a manual outreach attempt (ranking tier 5, deterministic reason).
 * Every text field carries `runTag`.
 */
export async function createSyntheticLead(
  db: Queryable,
  input: {
    orgId: string;
    repUserId: string;
    runTag: string;
    phoneE164: string;
    lastTouchDaysAgo?: number;
    /** Phase 3 (TODO): comps fixture variant. Ignored until `lead_comps` exists. */
    compsVariant?: "normal" | "low_confidence";
    /** Set true for the training-isolation case only (T7). */
    training?: boolean;
  },
): Promise<SyntheticLead> {
  if (!/^\+1\d{10}$/.test(input.phoneE164)) throw new Error("phoneE164 must be +1XXXXXXXXXX");
  const propertyId = randomUUID();
  const contactId = randomUUID();
  const address = `${input.runTag} ${propertyId.slice(0, 8)} Close Ln`;
  const days = input.lastTouchDaysAgo ?? 20;

  await db.query(
    `insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type)
     values ($1,$2,$3,'Seller',$4,'mobile')`,
    [contactId, input.orgId, input.runTag, input.phoneE164],
  );
  await asService(db, (q) =>
    q.query(
      `insert into public.properties(id,org_id,address,city,state,zip,status,homeowner_contact_id,assigned_user_id,is_training)
       values ($1,$2,$3,'Kansas City','MO','64151','new_lead',$4,$5,$6)`,
      [propertyId, input.orgId, address, contactId, input.repUserId, input.training === true],
    ),
  );
  const episode = await db.query<{ id: string }>(
    "select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null order by assigned_at desc limit 1",
    [propertyId],
  );
  const episodeId = episode.rows[0]?.id;
  if (!episodeId && !input.training) {
    throw new Error("createSyntheticLead: no live assignment episode opened; is the rep designated (designateRep) and acquisitions enabled?");
  }
  if (!input.training) {
    await db.query(
      `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at)
       values ($1,$2,'contacted',now() - make_interval(days => $3))
       on conflict (property_id,org_id) do update set stage='contacted', stage_entered_at=excluded.stage_entered_at`,
      [propertyId, input.orgId, days],
    );
    // Direct insert as the owner connection: the attempt is history, not a command (plan F5). The
    // attribution and last-touch triggers must run, so no session_replication_role switch.
    await db.query(
      `insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,idempotency_key,outcome)
       values ($1,$2,$3,$4,'outreach','manual',now() - make_interval(days => $5),$6,'no_answer')`,
      [input.orgId, propertyId, episodeId, input.repUserId, days, randomUUID()],
    );
  }
  return { propertyId, contactId, address, phoneE164: input.phoneE164, episodeId: episodeId ?? "", runTag: input.runTag };
}

/** Upserts the org's `my_leads_feature_flags` row with exactly the named flags true and every other flag false. */
export async function seedFeatureFlags(db: Queryable, orgId: string, on: readonly string[]): Promise<void> {
  for (const flag of on) {
    if (!(MY_LEADS_CLOSE_FLAGS as readonly string[]).includes(flag)) throw new Error(`Unknown My Leads flag ${flag}`);
  }
  const values = MY_LEADS_CLOSE_FLAGS.map((flag) => (on.includes(flag) ? "true" : "false"));
  const columns = MY_LEADS_CLOSE_FLAGS.join(",");
  const updates = MY_LEADS_CLOSE_FLAGS.map((flag) => `${flag}=excluded.${flag}`).join(",");
  await asService(db, (q) =>
    q.query(
      `insert into public.my_leads_feature_flags(org_id,${columns},updated_at) values ($1,${values.join(",")},now())
       on conflict (org_id) do update set ${updates}, updated_at=now()`,
      [orgId],
    ),
  );
}

/** Seller reminder org switch (D9). The job still refuses to send while the `seller_reminders` flag is off. */
export async function seedSellerReminderSettings(db: Queryable, orgId: string, enabled: boolean): Promise<void> {
  await db.query(
    `insert into public.seller_reminder_settings(org_id,enabled) values ($1,$2)
     on conflict (org_id) do update set enabled=excluded.enabled, updated_at=now()`,
    [orgId, enabled],
  );
}

/**
 * CI only: active `dialpad_org_connections` row whose secret ref is the E2E env name, a verified
 * `dialpad_member_bindings` row for the rep (dialpad user `4242424242`). Number grants are not
 * needed for the webhook path (`fn_prepare_dialpad_call_intent` accepts a null grant).
 */
export async function seedDialpadForRep(db: Queryable, input: { orgId: string; repUserId: string }): Promise<{ connectionId: string; bindingId: string }> {
  return asService(db, async (q) => {
    const existing = await q.query<{ id: string }>("select id from public.dialpad_org_connections where org_id=$1", [input.orgId]);
    let connectionId = existing.rows[0]?.id;
    if (connectionId) {
      await q.query(
        "update public.dialpad_org_connections set status='active', webhook_secret_ref=$2, webhook_secret_version=1, updated_at=now() where id=$1",
        [connectionId, CI_WEBHOOK_SECRET_REF],
      );
    } else {
      const inserted = await q.query<{ id: string }>(
        "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','e2e_close_client',$2) returning id",
        [input.orgId, CI_WEBHOOK_SECRET_REF],
      );
      connectionId = inserted.rows[0]!.id;
    }
    const verified = await q.query<{ id: string }>(
      "select id from public.dialpad_member_bindings where org_id=$1 and user_id=$2 and status='verified' limit 1",
      [input.orgId, input.repUserId],
    );
    let bindingId = verified.rows[0]?.id;
    if (!bindingId) {
      const claim = await q.query<{ v: { bindingId: string } }>(
        "select public.fn_claim_dialpad_member_binding($1,$2,$3) as v",
        [input.orgId, input.repUserId, CI_DIALPAD_USER_ID],
      );
      bindingId = claim.rows[0]!.v.bindingId;
      await q.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','e2e-close')", [bindingId]);
    }
    return { connectionId: connectionId!, bindingId: bindingId! };
  });
}

/** Prepares a Dialpad call intent for the lead as the rep (service path, no HTTP). */
export async function prepareDialpadIntent(
  db: Queryable,
  input: { orgId: string; repUserId: string; lead: SyntheticLead },
): Promise<{ intentId: string; customData: string }> {
  const r = await asService(db, (q) =>
    q.query<{ v: { intentId: string; customData: string } }>(
      "select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v",
      [input.orgId, input.repUserId, input.lead.propertyId, input.lead.contactId, randomUUID()],
    ),
  );
  const v = r.rows[0]!.v;
  return { intentId: v.intentId, customData: String(v.customData) };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** HS256 compact JWT of the raw payload text (same construction as event-processing.test.ts). */
export function signDialpadWebhook(payloadText: string, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(payloadText);
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export type DialpadEventInput = {
  callId: string;
  state: "calling" | "connected" | "hangup" | "voicemail";
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

/**
 * Payload text with `call_id` and `target.id` as unquoted integer literals (the verifier keeps int64
 * ids intact) and a 13-digit `event_timestamp`.
 */
export function dialpadEventPayload(i: DialpadEventInput): string {
  if (!/^\d{1,20}$/.test(i.callId)) throw new Error("callId must be a decimal integer string");
  if (!/^\d{1,20}$/.test(i.targetUserId)) throw new Error("targetUserId must be a decimal integer string");
  if (!Number.isInteger(i.at) || String(i.at).length !== 13) throw new Error("at must be 13-digit epoch milliseconds");
  const started = i.dateStarted ?? i.at;
  const body: Record<string, unknown> = {
    state: i.state,
    event_timestamp: i.at,
    external_number: i.externalNumber,
    internal_number: "+18165550100",
    direction: i.direction ?? "outbound",
    target: { type: "user", id: "__TARGET__" },
    date_started: started,
    ...(i.customData ? { custom_data: i.customData } : {}),
    ...(i.state === "connected" || i.state === "hangup" ? { date_connected: i.dateConnected ?? started + 4000 } : {}),
    ...(i.state === "hangup"
      ? {
          date_ended: i.at,
          talk_time: i.talkTimeMs ?? Math.max(0, i.at - (i.dateConnected ?? started + 4000)),
          was_recorded: Boolean(i.shareLink || i.adminRecordingUrl),
          ...(i.shareLink ? { public_call_review_share_link: i.shareLink } : {}),
          ...(i.adminRecordingUrl ? { admin_recording_urls: [i.adminRecordingUrl] } : {}),
        }
      : {}),
  };
  let text = JSON.stringify(body).replace('"__TARGET__"', i.targetUserId);
  text = text.replace(/^\{/, `{"call_id":${i.callId},`);
  return text;
}

/** POST the signed body to the app's Dialpad voice webhook for one connection. */
export async function postDialpadEvent(baseUrl: string, connectionId: string, jwt: string): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/$/, "")}/api/webhooks/dialpad/voice/${connectionId}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: jwt,
  });
}

async function inventory(db: Queryable, lead: SyntheticLead): Promise<CleanupReport> {
  const one = async (sql: string) => Number((await db.query<{ n: string }>(sql, [lead.propertyId])).rows[0]?.n ?? 0);
  const prop = await db.query<{ deleted_at: Date | null }>("select deleted_at from public.properties where id=$1", [lead.propertyId]);
  return {
    attempts: await one("select count(*)::text as n from public.acquisition_attempts where property_id=$1"),
    offers: await one("select count(*)::text as n from public.acquisition_offers where property_id=$1"),
    notes: await one("select count(*)::text as n from public.lead_notes where property_id=$1"),
    intents: await one("select count(*)::text as n from public.dialpad_call_intents where property_id=$1"),
    events: await one(
      "select count(*)::text as n from public.dialpad_call_events e where exists (select 1 from public.dialpad_call_intents i where i.property_id=$1 and i.matched_provider_call_id is not null and i.matched_provider_call_id = e.provider_call_id)",
    ).catch(() => 0),
    cancelledTasks: await one("select count(*)::text as n from public.tasks where related_property_id=$1 and status='cancelled'"),
    openTasks: await one("select count(*)::text as n from public.tasks where related_property_id=$1 and status in ('open','snoozed')"),
    propertyDeletedAt: prop.rows[0]?.deleted_at ? new Date(prop.rows[0].deleted_at).toISOString() : null,
  };
}

/**
 * Soft retire: open appointments cancelled through `fn_cancel_appointment` as the rep (lifecycle,
 * never delete), other open tasks cancelled, `properties.deleted_at=now()`, queue row archived,
 * contact kept (intent FK restrict). Returns the retained inventory.
 */
export async function retireSyntheticLead(db: Queryable, lead: SyntheticLead, repUserId: string): Promise<CleanupReport> {
  const pending = await db.query<{ n: string }>(
    `select count(*)::text as n from public.task_calendar_mutations m join public.tasks t on t.id = m.source_task_id
     where t.related_property_id=$1 and m.phase in ('pending','provider_done')`,
    [lead.propertyId],
  ).catch(() => ({ rows: [{ n: "0" }] }));
  if (Number(pending.rows[0]?.n ?? 0) > 0) throw new Error("retireSyntheticLead: a calendar mutation is still in flight; let it finish first.");

  const open = await db.query<{ id: string }>(
    "select id from public.tasks where related_property_id=$1 and type='appointment' and status='open' order by due_at",
    [lead.propertyId],
  );
  for (const row of open.rows) {
    await asMember(db, repUserId, (q) => q.query("select public.fn_cancel_appointment($1)", [row.id]));
  }
  await db.query(
    "update public.tasks set status='cancelled', updated_at=now() where related_property_id=$1 and type<>'appointment' and status in ('open','snoozed')",
    [lead.propertyId],
  );
  await asService(db, (q) =>
    q.query("update public.properties set deleted_at=now(), assigned_user_id=null where id=$1 and deleted_at is null", [lead.propertyId]),
  );
  await db.query("update public.acquisition_queue_states set archived_at=coalesce(archived_at, now()) where property_id=$1", [lead.propertyId]).catch(() => {});
  return inventory(db, lead);
}

/** All lanes: there is no deletion path. Cleanup is `retireSyntheticLead`. */
export async function cleanupSyntheticLead(db: Queryable, lead: SyntheticLead, lane: CloseLane, repUserId: string): Promise<CleanupReport> {
  assertLaneSafe(lane);
  // Check the handle actually passed in, not just the environment.
  const server = await db.query<{ addr: string | null }>("select inet_server_addr()::text as addr");
  const addr = server.rows[0]?.addr ?? null; // null = unix socket (local)
  const loopback = addr === null || /^(127\.|::1)/.test(addr);
  if (lane === "ci" && !loopback) throw new Error(`cleanupSyntheticLead: the ci lane's database handle is not loopback (${addr}).`);
  if (lane !== "ci") {
    if (loopback) throw new Error("cleanupSyntheticLead: a production lane was given a loopback database handle.");
    assertCanaryOwned(lead.runTag, "synthetic lead run tag");
    assertCanaryOwned(lead.address, "synthetic lead address");
  }
  const row = await db.query<{ address: string }>("select address from public.properties where id=$1", [lead.propertyId]);
  if (!row.rows[0]?.address.startsWith(lead.runTag)) {
    throw new Error("cleanupSyntheticLead: the property on this database handle is not the tagged synthetic lead; refusing to retire it.");
  }
  return retireSyntheticLead(db, lead, repUserId);
}

/** T5 helper: database-time expiry of a strip override that `page.clock` cannot move. */
export async function expireStripOverride(db: Queryable, propertyId: string): Promise<void> {
  await db.query(
    "update public.my_leads_strip_overrides set pinned_until = least(pinned_until, now() - interval '1 minute'), hidden_until = least(hidden_until, now() - interval '1 minute') where property_id=$1",
    [propertyId],
  );
}

// ----------------------------------------------------------------------------------------------
// Phase 2/3 seams (TODO: filled by the p2-acceptance slice and the main p4 PR once those phases merge).

/** Phase 2 (S1): the stub dial provider's recorded `initiate_call` requests. */
export type StubDialRecord = { phone: string; customData: string; callerId: string | null; at: string };
export async function readStubDialRecords(_db: Queryable, _propertyId: string): Promise<StubDialRecord[]> {
  throw new Error("TODO Phase 2: DIALPAD_DIAL_PROVIDER=stub record reader is owned by the p2-acceptance slice.");
}

/** Phase 3 (S2/S3): the Dropbox Sign stub server handle. */
export type ProviderStubMode = "ok" | "slow_then_abort" | "reject" | "slow";
export async function setProviderStubMode(_baseUrl: string, _mode: ProviderStubMode): Promise<void> {
  throw new Error("TODO Phase 3: e2e/support/provider-stub-server.ts ships with the main p4-acceptance PR.");
}
