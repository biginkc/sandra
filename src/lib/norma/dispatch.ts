import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { createBlandClient, type BlandClient } from "./bland";
import { readNormaBlandConfig, readNormaGateConfig, type NormaBlandConfig, type NormaGateConfig } from "./config";
import { evaluateNormaGate } from "./gate";
import { sendNormaPrecallSms, type PrecallDeps } from "./precall-sms";
import {
  bindNormaCallId,
  checkNormaEligibility,
  claimNormaDispatch,
  markNormaDispatchRejected,
  markNormaDispatchUnknown,
  presendNormaFence,
} from "./rpc";

type Client = SupabaseClient<Database>;

export type DispatchResult =
  | { status: "dispatched"; callId: string }
  /** Gate closed / Bland not configured / ineligible / Bland refused: nothing was dialled, request closed. */
  | { status: "rejected"; reason: string }
  /** Send outcome uncertain: request is dispatch_unknown and blocks a redial. */
  | { status: "unknown"; reason: string }
  /** Another worker already owns, or already finished, this request. */
  | { status: "not_claimed" }
  | { status: "not_found" };

export type DispatchDeps = {
  client: Client;
  bland?: BlandClient;
  blandConfig?: NormaBlandConfig | null;
  gate?: NormaGateConfig;
  /** Pre-call text overrides (tests); production reads NORMA_PRECALL_SMS_ENABLED and the template constant. */
  precallSms?: PrecallDeps;
};

const PRESEND_FENCE_RESPONSE_BUDGET_MS = 5_000;

/**
 * THE only function that may call Bland send-call. Every path (server action,
 * reconciliation, slice-2 cron) must come through here so the section-0 gate
 * and the dial-time eligibility recheck cannot be bypassed.
 *
 * Gate decision: a closed gate (or missing Bland config) marks the still-open
 * `requested` row `dispatch_rejected` (reason recorded) and releases the drip
 * pauses the request made. It never dials and never leaves the row hanging
 * open. The gate runs BEFORE the claim.
 */
export async function dispatchNormaCall(requestId: string, deps: DispatchDeps): Promise<DispatchResult> {
  const { client } = deps;

  const { data: row, error } = await client
    .from("norma_call_requests")
    .select("id, status, org_id, phone_e164, property_id, contact_id, idempotency_key, rep_context, attempt")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(`norma dispatch load failed: ${error.message}`);
  if (!row) return { status: "not_found" };
  if (row.status !== "requested") return { status: "not_claimed" };
  const attempt = row.attempt ?? 1;

  // ---- gate (section 0), before the claim ---------------------------------
  const gate = evaluateNormaGate(row.phone_e164, deps.gate ?? readNormaGateConfig());
  if (!gate.open) {
    const closed = await markNormaDispatchRejected(client, requestId, `gate:${gate.reason}`, "requested", attempt);
    // Another worker claimed it between our read and the close: it owns the row now.
    if (closed !== "dispatch_rejected") return { status: "not_claimed" };
    return { status: "rejected", reason: gate.reason };
  }
  const blandConfig = deps.blandConfig === undefined ? readNormaBlandConfig() : deps.blandConfig;
  if (!blandConfig) {
    const closed = await markNormaDispatchRejected(client, requestId, "bland_not_configured", "requested", attempt);
    if (closed !== "dispatch_rejected") return { status: "not_claimed" };
    return { status: "rejected", reason: "bland_not_configured" };
  }

  // ---- claim: requested -> dispatching ------------------------------------
  // Fenced on the attempt read above: every later decision (pre-call text, metadata) uses
  // that same value, so a stale snapshot can never act for a different attempt.
  if (!(await claimNormaDispatch(client, requestId, attempt))) return { status: "not_claimed" };

  // ---- pre-send (a failure here means nothing was sent) --------------------
  // The dial-time eligibility recheck is the LAST thing before the send: lead
  // facts are loaded first, so the gap between "eligible" and "dialled" is a
  // single function call, not a pair of database round trips.
  let variables: Record<string, string>;
  try {
    variables = await loadCallVariables(client, row);
    const recheck = () =>
      checkNormaEligibility(client, { propertyId: row.property_id, contactId: row.contact_id ?? "", phoneE164: row.phone_e164 });
    let eligibility = await recheck();
    if (eligibility.eligible && attempt === 1) {
      // Call twice: the retry (attempt 2) never texts again. The text is a
      // best-effort extra: refused, failed or slow, the call is still placed.
      // After it, eligibility is read once more so the check stays the LAST
      // thing before the send (the seller may have replied STOP meanwhile).
      const sms = await sendNormaPrecallSms(client, row, deps.precallSms);
      if (sms.status !== "disabled" && sms.status !== "empty_template") {
        await recordPrecallSms(client, requestId, `${sms.status}:${sms.detail}`);
        eligibility = await recheck();
      }
    }
    if (!eligibility.eligible) {
      await markNormaDispatchRejected(client, requestId, `ineligible:${eligibility.reason}`, undefined, attempt);
      return { status: "rejected", reason: `ineligible:${eligibility.reason}` };
    }
  } catch (preSendError) {
    reportError(preSendError, { tags: { surface: "norma_dispatch_pre_send" }, extra: { requestId } });
    try {
      await markNormaDispatchRejected(client, requestId, "pre_send_error", undefined, attempt);
    } catch {
      // Left `dispatching`; the reconciliation sweep owns it.
    }
    return { status: "rejected", reason: "pre_send_error" };
  }

  // ---- send ----------------------------------------------------------------
  const bland = deps.bland ?? createBlandClient(blandConfig);
  const fenceStartedAt = performance.now();
  let fencePassed = false;
  try {
    fencePassed = await presendNormaFence(client, requestId, attempt);
  } catch (fenceError) {
    reportError(fenceError, { tags: { surface: "norma_dispatch_presend_fence" }, extra: { requestId, attempt } });
  }
  if (!fencePassed || performance.now() - fenceStartedAt > PRESEND_FENCE_RESPONSE_BUDGET_MS) return { status: "not_claimed" };
  const result = await bland.sendCall({
    phoneNumber: row.phone_e164,
    requestId,
    idempotencyKey: row.idempotency_key,
    attempt,
    variables,
  });

  if (result.kind === "rejected") {
    await markNormaDispatchRejected(client, requestId, `bland_${result.httpStatus}:${result.message}`, undefined, attempt);
    return { status: "rejected", reason: `bland_${result.httpStatus}` };
  }
  if (result.kind === "unknown") {
    await markNormaDispatchUnknown(client, requestId, `send_unknown:${result.reason}`, attempt);
    return { status: "unknown", reason: result.reason };
  }

  try {
    const bound = await bindNormaCallId(client, requestId, result.callId, attempt);
    // `already_completed`: the webhook beat us here and finished the request.
    if (bound === "bound" || bound === "already_completed") return { status: "dispatched", callId: result.callId };
    reportError(new Error(`norma bind returned ${bound}`), { tags: { surface: "norma_dispatch_bind" }, extra: { requestId } });
  } catch (bindError) {
    reportError(bindError, { tags: { surface: "norma_dispatch_bind" }, extra: { requestId } });
  }
  // A call exists but we could not record it: never redial.
  try {
    await markNormaDispatchUnknown(client, requestId, "bind_failed", attempt);
  } catch {
    // Left `dispatching`; reconciliation escalates it.
  }
  return { status: "unknown", reason: "bind_failed" };
}

/** Audit trail for the pre-call text. Best effort: it must never affect the call. */
async function recordPrecallSms(client: Client, requestId: string, status: string): Promise<void> {
  try {
    await client.from("norma_call_requests").update({ precall_sms_status: status.slice(0, 120) }).eq("id", requestId);
  } catch (error) {
    reportError(error, { tags: { surface: "norma_precall_sms_record" }, extra: { requestId } });
  }
}

/**
 * Lead facts passed as pathway variables. These are data, not script text.
 * TODO(pathway pin): confirm these variable names against the pinned pathway.
 */
export const NORMA_DISPATCH_VARIABLES = {
  sellerFirstName: "seller_first_name",
  propertyAddress: "property_address",
  repContext: "rep_context",
  askingPrice: "asking_price",
  latestNotes: "latest_notes",
} as const;

const LATEST_NOTES_MAX_CHARS = 1000;
const LATEST_NOTES_FETCH_LIMIT = 25;
const NOTES_SEPARATOR = " | ";

/** Whole dollars, US formatting ("$160,000"); empty when there is no usable price. */
function formatAskingPrice(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Rep-written text, treated as data: control chars stripped, whitespace collapsed. */
function cleanNote(body: string | null | undefined): string {
  return (body ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Newest-first notes joined with " | ", capped at 1,000 chars (whole notes; a lone oversized note is cut). */
function joinLatestNotes(bodies: Array<string | null | undefined>): string {
  let out = "";
  for (const body of bodies) {
    const note = cleanNote(body);
    if (!note) continue;
    const next = out ? `${out}${NOTES_SEPARATOR}${note}` : note;
    if (next.length <= LATEST_NOTES_MAX_CHARS) {
      out = next;
      continue;
    }
    if (!out) out = Array.from(note).slice(0, LATEST_NOTES_MAX_CHARS).join("").trimEnd();
    break;
  }
  return out;
}

async function loadCallVariables(
  client: Client,
  row: { org_id: string; property_id: string; contact_id: string | null; rep_context: string | null },
): Promise<Record<string, string>> {
  const [
    { data: property, error: propertyError },
    { data: contact, error: contactError },
    { data: notes, error: notesError },
  ] = await Promise.all([
    // listing_price is the "Listing price" row on the lead page (CSV "asking price" imports into it).
    client.from("properties").select("address, city, state, zip, listing_price")
      .eq("id", row.property_id)
      .eq("org_id", row.org_id)
      .maybeSingle(),
    row.contact_id
      ? client.from("contacts").select("first_name").eq("id", row.contact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // lead_notes is the notes feed on the lead page, read there by property_id, newest first.
    client
      .from("lead_notes")
      .select("body")
      .eq("org_id", row.org_id)
      .eq("property_id", row.property_id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(LATEST_NOTES_FETCH_LIMIT),
  ]);
  if (propertyError || contactError || notesError) throw new Error("norma dispatch lead facts failed");
  const address = [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(", ");
  return {
    [NORMA_DISPATCH_VARIABLES.sellerFirstName]: contact?.first_name ?? "",
    [NORMA_DISPATCH_VARIABLES.propertyAddress]: address,
    [NORMA_DISPATCH_VARIABLES.repContext]: row.rep_context ?? "",
    [NORMA_DISPATCH_VARIABLES.askingPrice]: formatAskingPrice(property?.listing_price),
    [NORMA_DISPATCH_VARIABLES.latestNotes]: joinLatestNotes((notes ?? []).map((n) => n.body)),
  };
}
