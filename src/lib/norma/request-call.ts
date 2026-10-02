import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { readNormaCallbackAssigneeId, readNormaGateConfig, type NormaEnv } from "./config";
import { dispatchNormaCall, type DispatchResult } from "./dispatch";
import { evaluateNormaGate } from "./gate";
import { createNormaRequest } from "./rpc";
import { loadNormaWrongNumbers, selectVoicePhone, toUsVoiceE164 } from "./voice-phone";

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Typed outcomes the (later) UI renders. `ok` is true only when a call is queued/placed. */
export type RequestNormaCallResult =
  | { ok: true; code: "calling"; requestId: string }
  /** The send outcome is uncertain; the request stays open and blocks a redial. */
  | { ok: true; code: "dispatch_unknown"; requestId: string }
  | { ok: false; code: "unauthenticated" }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "training_lead" }
  | { ok: false; code: "no_callable_number" }
  | { ok: false; code: "blocked"; reason: string }
  | { ok: false; code: "in_flight"; requestId: string | null }
  | { ok: false; code: "gate_off"; reason: "dispatch_disabled" | "number_not_allowed" }
  | { ok: false; code: "callback_assignee_not_configured" }
  | { ok: false; code: "dispatch_rejected"; reason: string; requestId: string }
  | { ok: false; code: "error" };

export type RequestNormaCallDeps = {
  /** Session-authenticated user id, or null when signed out. */
  getUserId: () => Promise<string | null>;
  /** Session (RLS-scoped) client: proves the caller can read the lead. */
  sessionClient: Client;
  /** Service-role client: RPCs and dispatch. */
  adminClient: Client;
  env?: NormaEnv;
  dispatch?: (requestId: string) => Promise<DispatchResult>;
};

export async function requestNormaCallCore(
  propertyId: string,
  repContext: string | null,
  deps: RequestNormaCallDeps,
): Promise<RequestNormaCallResult> {
  if (!UUID_PATTERN.test(propertyId)) return { ok: false, code: "lead_not_found" };

  const userId = await deps.getUserId();
  if (!userId) return { ok: false, code: "unauthenticated" };

  const assigneeId = readNormaCallbackAssigneeId(deps.env);
  if (!assigneeId) return { ok: false, code: "callback_assignee_not_configured" };

  // RLS read: a lead the caller cannot see (or another org's) is "not found".
  const { data: property, error } = await deps.sessionClient
    .from("properties")
    .select("id, org_id, is_training, homeowner_contact_id")
    .eq("id", propertyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, code: "error" };
  if (!property || !property.homeowner_contact_id) return { ok: false, code: "lead_not_found" };
  if (property.is_training) return { ok: false, code: "training_lead" };

  const { data: contact, error: contactError } = await deps.sessionClient
    .from("contacts")
    .select("phone_1, phone_2, phone_3")
    .eq("id", property.homeowner_contact_id)
    .maybeSingle();
  if (contactError) return { ok: false, code: "error" };

  let phone: string | null;
  try {
    const candidates = [contact?.phone_1, contact?.phone_2, contact?.phone_3]
      .map((value) => toUsVoiceE164(value))
      .filter((value): value is string => value !== null);
    const wrong = await loadNormaWrongNumbers(deps.adminClient, property.org_id, candidates);
    phone = selectVoicePhone(contact, wrong)?.phoneE164 ?? null;
  } catch {
    return { ok: false, code: "error" };
  }
  if (!phone) return { ok: false, code: "no_callable_number" };

  // A closed gate creates no request and pauses nothing. dispatchNormaCall
  // enforces the same gate again for every other path.
  const gate = evaluateNormaGate(phone, readNormaGateConfig(deps.env));
  if (!gate.open) return { ok: false, code: "gate_off", reason: gate.reason };

  let created;
  try {
    created = await createNormaRequest(deps.adminClient, {
      propertyId,
      contactId: property.homeowner_contact_id,
      phoneE164: phone,
      requestedBy: userId,
      repContext: repContext?.trim() ? repContext.trim().slice(0, 2000) : null,
      callbackAssigneeId: assigneeId,
    });
  } catch {
    return { ok: false, code: "error" };
  }
  if (created.status === "blocked") {
    return created.reason === "training_lead"
      ? { ok: false, code: "training_lead" }
      : { ok: false, code: "blocked", reason: created.reason };
  }
  if (created.status === "already_open") return { ok: false, code: "in_flight", requestId: created.requestId };

  const dispatch = deps.dispatch ?? ((id: string) => dispatchNormaCall(id, { client: deps.adminClient }));
  let result: DispatchResult;
  try {
    result = await dispatch(created.requestId);
  } catch {
    // Outcome unknown to the caller; the request stays open and the sweep owns it.
    return { ok: true, code: "dispatch_unknown", requestId: created.requestId };
  }
  switch (result.status) {
    case "dispatched":
      return { ok: true, code: "calling", requestId: created.requestId };
    case "unknown":
      return { ok: true, code: "dispatch_unknown", requestId: created.requestId };
    case "rejected":
      return { ok: false, code: "dispatch_rejected", reason: result.reason, requestId: created.requestId };
    default:
      return { ok: false, code: "in_flight", requestId: created.requestId };
  }
}
