import type { RequestNormaCallResult } from "./request-call";

/**
 * Plain reasons for why a Norma call is blocked or did not go out. Keyed by the
 * SQL block reasons and the action's result codes; unknown values get a safe
 * generic line rather than leaking a raw code.
 */
const BLOCK_REASON_TEXT: Record<string, string> = {
  dnc_locked: "This lead is marked do-not-contact.",
  dnc_contact: "This contact is marked do-not-contact.",
  global_dnc_registry: "This number is on the do-not-contact list.",
  wrong_number_flagged: "This number was already flagged as a wrong number.",
  not_interested: "This lead is marked not interested.",
  contact_not_on_property: "The homeowner on this lead changed. Reload the page and try again.",
  phone_not_on_contact: "The number to dial is no longer on the homeowner's record. Reload the page and try again.",
  property_not_found: "This lead could not be found.",
  training_lead: "Norma cannot call training leads.",
  requester_not_member: "Only active workspace members can ask Norma to call.",
  assignee_not_member: "The person who receives Norma's callback tasks is not an active member.",
  invalid_request: "This request could not be validated.",
  eligibility_check_failed: "Sandra could not confirm this lead is allowed to be called. Try again in a moment.",
};

export function normaBlockReasonText(reason: string): string {
  return BLOCK_REASON_TEXT[reason] ?? BLOCK_REASON_TEXT.eligibility_check_failed;
}

export type NormaBlockCode =
  | "unauthenticated"
  | "lead_not_found"
  | "training_lead"
  | "no_callable_number"
  | "blocked"
  | "in_flight"
  | "gate_off"
  | "callback_assignee_not_configured"
  | "dispatch_rejected"
  | "error";

export type NormaBlockInfo = { code: NormaBlockCode; reason?: string };

export function normaBlockText(info: NormaBlockInfo): string {
  switch (info.code) {
    case "unauthenticated":
      return "Sign in again to ask Norma to call.";
    case "lead_not_found":
      return "This lead could not be found.";
    case "training_lead":
      return normaBlockReasonText("training_lead");
    case "no_callable_number":
      return "This lead has no number Norma can call.";
    case "blocked":
      return normaBlockReasonText(info.reason ?? "eligibility_check_failed");
    case "in_flight":
      return "A Norma call is already in progress for this lead.";
    case "gate_off":
      return info.reason === "number_not_allowed"
        ? "Norma is switched on for test numbers only, and this number is not one of them."
        : "Norma calling is switched off.";
    case "callback_assignee_not_configured":
      return "Norma is not fully set up yet: nobody is assigned to receive callback tasks.";
    case "dispatch_rejected":
      return "The call was not placed. Nothing was sent to the seller.";
    default:
      return "Something went wrong. Nothing was sent to the seller. Try again in a moment.";
  }
}

/** Message shown after Confirm, for every result of `requestNormaCall`. */
export function describeRequestResult(result: RequestNormaCallResult): { tone: "success" | "warning" | "error"; text: string } {
  if (result.ok) {
    return result.code === "calling"
      ? { tone: "success", text: "Norma is calling now. The summary will appear on this lead when the call ends." }
      : {
          tone: "warning",
          text: "Sandra could not confirm the call went out. Do not request another; it will be checked automatically and show here.",
        };
  }
  const reason = "reason" in result ? result.reason : undefined;
  return { tone: result.code === "in_flight" ? "warning" : "error", text: normaBlockText({ code: result.code, reason }) };
}
