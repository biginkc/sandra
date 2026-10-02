import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { createBlandClient, type BlandClient } from "./bland";
import { readNormaBlandConfig, readNormaGateConfig, type NormaBlandConfig, type NormaGateConfig } from "./config";
import { evaluateNormaGate } from "./gate";
import {
  bindNormaCallId,
  checkNormaEligibility,
  claimNormaDispatch,
  markNormaDispatchRejected,
  markNormaDispatchUnknown,
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
};

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
    .select("id, status, phone_e164, property_id, contact_id, idempotency_key, rep_context")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(`norma dispatch load failed: ${error.message}`);
  if (!row) return { status: "not_found" };
  if (row.status !== "requested") return { status: "not_claimed" };

  // ---- gate (section 0), before the claim ---------------------------------
  const gate = evaluateNormaGate(row.phone_e164, deps.gate ?? readNormaGateConfig());
  if (!gate.open) {
    await markNormaDispatchRejected(client, requestId, `gate:${gate.reason}`);
    return { status: "rejected", reason: gate.reason };
  }
  const blandConfig = deps.blandConfig === undefined ? readNormaBlandConfig() : deps.blandConfig;
  if (!blandConfig) {
    await markNormaDispatchRejected(client, requestId, "bland_not_configured");
    return { status: "rejected", reason: "bland_not_configured" };
  }

  // ---- claim: requested -> dispatching ------------------------------------
  if (!(await claimNormaDispatch(client, requestId))) return { status: "not_claimed" };

  // ---- pre-send (a failure here means nothing was sent) --------------------
  let variables: Record<string, string>;
  try {
    const eligibility = await checkNormaEligibility(client, {
      propertyId: row.property_id,
      contactId: row.contact_id ?? "",
      phoneE164: row.phone_e164,
    });
    if (!eligibility.eligible) {
      await markNormaDispatchRejected(client, requestId, `ineligible:${eligibility.reason}`);
      return { status: "rejected", reason: `ineligible:${eligibility.reason}` };
    }
    variables = await loadCallVariables(client, row);
  } catch (preSendError) {
    reportError(preSendError, { tags: { surface: "norma_dispatch_pre_send" }, extra: { requestId } });
    try {
      await markNormaDispatchRejected(client, requestId, "pre_send_error");
    } catch {
      // Left `dispatching`; the reconciliation sweep owns it.
    }
    return { status: "rejected", reason: "pre_send_error" };
  }

  // ---- send ----------------------------------------------------------------
  const bland = deps.bland ?? createBlandClient(blandConfig);
  const result = await bland.sendCall({
    phoneNumber: row.phone_e164,
    requestId,
    idempotencyKey: row.idempotency_key,
    variables,
  });

  if (result.kind === "rejected") {
    await markNormaDispatchRejected(client, requestId, `bland_${result.httpStatus}:${result.message}`);
    return { status: "rejected", reason: `bland_${result.httpStatus}` };
  }
  if (result.kind === "unknown") {
    await markNormaDispatchUnknown(client, requestId, `send_unknown:${result.reason}`);
    return { status: "unknown", reason: result.reason };
  }

  try {
    const bound = await bindNormaCallId(client, requestId, result.callId);
    // `already_completed`: the webhook beat us here and finished the request.
    if (bound === "bound" || bound === "already_completed") return { status: "dispatched", callId: result.callId };
    reportError(new Error(`norma bind returned ${bound}`), { tags: { surface: "norma_dispatch_bind" }, extra: { requestId } });
  } catch (bindError) {
    reportError(bindError, { tags: { surface: "norma_dispatch_bind" }, extra: { requestId } });
  }
  // A call exists but we could not record it: never redial.
  try {
    await markNormaDispatchUnknown(client, requestId, "bind_failed");
  } catch {
    // Left `dispatching`; reconciliation escalates it.
  }
  return { status: "unknown", reason: "bind_failed" };
}

/**
 * Lead facts passed as pathway variables. These are data, not script text.
 * TODO(pathway pin): confirm these variable names against the pinned pathway.
 */
export const NORMA_DISPATCH_VARIABLES = {
  sellerFirstName: "seller_first_name",
  propertyAddress: "property_address",
  repContext: "rep_context",
} as const;

async function loadCallVariables(
  client: Client,
  row: { property_id: string; contact_id: string | null; rep_context: string | null },
): Promise<Record<string, string>> {
  const [{ data: property, error: propertyError }, { data: contact, error: contactError }] = await Promise.all([
    client.from("properties").select("address, city, state, zip").eq("id", row.property_id).maybeSingle(),
    row.contact_id
      ? client.from("contacts").select("first_name").eq("id", row.contact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (propertyError || contactError) throw new Error("norma dispatch lead facts failed");
  const address = [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(", ");
  return {
    [NORMA_DISPATCH_VARIABLES.sellerFirstName]: contact?.first_name ?? "",
    [NORMA_DISPATCH_VARIABLES.propertyAddress]: address,
    [NORMA_DISPATCH_VARIABLES.repContext]: row.rep_context ?? "",
  };
}
