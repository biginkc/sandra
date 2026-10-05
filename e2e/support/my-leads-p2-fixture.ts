import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { assertLaneSafe, CI_WEBHOOK_SECRET_REF, handleTarget } from "./my-leads-close-fixture";

/**
 * Phase 2 additions to the shared my-leads-close fixture (`my-leads-close-fixture.ts`, merged with #804).
 * Everything the Phase 1 lane already provides (leads, flags, Dialpad connection and binding, webhook
 * signing and posting, cleanup) is imported from there, never re-implemented. Only what Phase 2 needs
 * on top lives here. Disposable database only.
 */

type Db = Pick<Pool, "query" | "connect">;

/** `DIALPAD_CTI_DIAL_KEY_*` is the namespace `resolveDialpadDialKey` accepts (api-dial.ts); the dummy value is in playwright.config.ts. */
export const CI_DIAL_KEY_REF = "env:DIALPAD_CTI_DIAL_KEY_E2E";
/** The connection must allow this origin (`DIALPAD_CTI_TARGET_ORIGIN`, protocol.ts) for the dial bootstrap. */
export const CI_DIALPAD_ORIGIN = "https://dialpad.com";

/**
 * Turns the connection the shared `seedDialpadForRep` created into one the API dial path accepts:
 * the allowed origin and the dial key ref. Call it right after `seedDialpadForRep`.
 */
export async function enableDialpadDialing(db: Db, orgId: string): Promise<void> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claim.role','service_role',true)");
    await c.query("set local role service_role");
    const r = await c.query(
      "update public.dialpad_org_connections set allowed_origins=array[$2]::text[], dial_api_key_ref=$3, updated_at=now() where org_id=$1 and webhook_secret_ref=$4",
      [orgId, CI_DIALPAD_ORIGIN, CI_DIAL_KEY_REF, CI_WEBHOOK_SECRET_REF],
    );
    if (r.rowCount !== 1) throw new Error("enableDialpadDialing: seedDialpadForRep must run first");
    await c.query("commit");
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

export type DialIntentRow = {
  id: string; status: string; customData: string; destinationE164: string; idempotencyKey: string;
  dispatchAuthorizedAt: string | null; matchedProviderCallId: string | null;
};

/**
 * What a spec can know about a dial. The stub dialer's would-be request is held in the Next server's
 * memory (`readStubDialpadDials`, api-dial.ts) where a Playwright worker cannot read it, so the durable
 * intent row stands in for it. Exposing the list needs a `src/` change in #809.
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
 * Disposable database only. Makes an unmatched intent look three minutes old so the call-status function
 * reports `expired` and the rate/in-flight guards stop counting it. The intent guard trigger protects
 * immutable evidence, so it is disabled for this one statement inside a single transaction (DDL is
 * transactional, a failure restores it). Refuses outside the ci lane and on a non-loopback handle.
 */
export async function expireDialIntentCi(db: Db & Pool, intentId: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  assertLaneSafe("ci", env);
  if (handleTarget(db) !== "loopback") throw new Error("expireDialIntentCi: the database handle is not configured for a loopback host.");
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("alter table public.dialpad_call_intents disable trigger dialpad_call_intents_guard");
    const r = await c.query(
      `update public.dialpad_call_intents
          set prepared_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute',
              dispatch_authorized_at = case when dispatch_authorized_at is null then null else now() - interval '2 minutes' end
        where id=$1 and status='prepared'`,
      [intentId],
    );
    if (r.rowCount !== 1) throw new Error("expireDialIntentCi: no unmatched prepared intent with that id");
    await c.query("alter table public.dialpad_call_intents enable trigger dialpad_call_intents_guard");
    await c.query("commit");
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

/** `disposition:reason` of every stored event of one provider call. */
export async function readEventDispositions(db: Db, orgId: string, callId: string): Promise<string[]> {
  const r = await db.query(
    "select disposition || ':' || coalesce(disposition_reason,'') as d from public.dialpad_call_events where org_id=$1 and provider_call_id=$2 order by event_timestamp_ms,id",
    [orgId, callId],
  );
  return r.rows.map((x) => x.d as string);
}

/**
 * Puts a second lead on an existing lead's contact (`contacts.phone_1` is unique, so "one number on two
 * leads" is one contact on two properties, the case #803's native matcher integration test covers).
 * Assigned to the same rep so the assignment trigger opens its own live episode. Insert goes through the
 * service role like the shared fixture's property insert. Returns the new property id.
 */
export async function addLeadOnSharedContact(
  db: Db,
  input: { orgId: string; repUserId: string; contactId: string; runTag: string },
): Promise<string> {
  const propertyId = randomUUID();
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claim.role','service_role',true)");
    await c.query("set local role service_role");
    await c.query(
      `insert into public.properties(id,org_id,address,city,state,zip,status,homeowner_contact_id,assigned_user_id)
       values ($1,$2,$3,'Kansas City','MO','64151','new_lead',$4,$5)`,
      [propertyId, input.orgId, `${input.runTag} ${propertyId.slice(0, 8)} Shared Contact Rd`, input.contactId, input.repUserId],
    );
    await c.query("commit");
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
  return propertyId;
}
