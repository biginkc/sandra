/** The shared operator wording for a sequence enrollment. */
export type DripStatus = "Waiting" | "Replied" | "Couldn't send" | "Stopped" | "Finished, no reply";

const REASONS: Record<string, string> = {
  inbound_reply: "Lead replied to a drip text.",
  rep_sms_human_takeover: "A person took over the text conversation.",
  provider_failed: "Text provider could not send this step.",
  reconciliation_required: "Text delivery needs review before this drip can continue.",
  status_terminal: "Lead reached a final status.",
  status_acquisition_active: "Lead is in an active acquisition conversation.",
  consent_revoked: "Lead opted out of texts.",
  appointment_booked: "An appointment was booked.",
  call_in_progress: "A call is in progress.",
  manual: "Drip was paused by a person.",
  dnc: "Lead is marked do not contact.",
  terminal_dispo: "Lead reached a final disposition.",
  template_missing: "The text template is missing.",
  "no approved sender for first-touch sequence send": "No approved sender is available for the first text.",
};

export function pauseReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? "Drip was paused; review the lead before continuing.";
}

export function dripStatus(status: string, pauseReason: string | null, canceled: boolean, repliedAfterLast = false): DripStatus {
  if (status === "active") return "Waiting";
  if (status === "opted_out" || (status === "completed" && canceled)) return "Stopped";
  if (status === "completed") return repliedAfterLast ? "Replied" : "Finished, no reply";
  if (pauseReason === "inbound_reply" || pauseReason === "rep_sms_human_takeover") return "Replied";
  if (pauseReason === "provider_failed" || pauseReason === "reconciliation_required" || pauseReason === "template_missing" || pauseReason === "no approved sender for first-touch sequence send") return "Couldn't send";
  return "Stopped";
}
