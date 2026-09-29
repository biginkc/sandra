/** The shared operator wording for a sequence enrollment. */
export type DripBucket = "waiting" | "replied" | "finished_no_reply" | "couldnt_send" | "stopped";

export const DRIP_BUCKET_LABELS = {
  waiting: "Waiting",
  replied: "Replied",
  finished_no_reply: "Finished, no reply",
  couldnt_send: "Couldn’t send",
  stopped: "Stopped",
} as const satisfies Record<DripBucket, string>;

export type DripStatus = (typeof DRIP_BUCKET_LABELS)[DripBucket];

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
  step_misconfigured: "This drip step is not set up to send a text.",
  no_phone: "Lead has no phone number for texts.",
  not_interested: "Lead is not interested.",
  "no approved sender for first-touch sequence send": "No approved sender is available for the first text.",
};

export function pauseReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? "Drip was paused; review the lead before continuing.";
}

export function dripStatus(status: string, pauseReason: string | null, canceled: boolean, repliedAfterLast = false): DripStatus | null {
  const bucket = dripBucket({ status, pause_reason: pauseReason, canceled, inboundAfterLastRun: repliedAfterLast });
  return bucket ? DRIP_BUCKET_LABELS[bucket] : null;
}

export function dripBucket(input: {
  status: string;
  pause_reason?: string | null;
  canceled?: boolean;
  inboundAfterLastRun?: boolean;
}): DripBucket | null {
  if (input.status === "active") return "waiting";
  if (input.status === "paused") {
    if (["inbound_reply", "rep_sms_human_takeover"].includes(input.pause_reason ?? "")) return "replied";
    if (["provider_failed", "reconciliation_required"].includes(input.pause_reason ?? "")) return "couldnt_send";
  }
  if (input.status === "opted_out" || (input.status === "completed" && input.canceled)) return "stopped";
  if (input.status === "completed" && !input.inboundAfterLastRun) return "finished_no_reply";
  return null;
}

/** Needs-person triage examines the newest enrollment, even when it is not actionable. */
export function latestEnrollmentBucket(enrollments: Array<Parameters<typeof dripBucket>[0] & {
  id: string;
  enrolled_at: string;
}>): DripBucket | null {
  const latest = enrollments.reduce<(typeof enrollments)[number] | null>((newest, enrollment) =>
    !newest || enrollment.enrolled_at > newest.enrolled_at ||
      (enrollment.enrolled_at === newest.enrolled_at && enrollment.id > newest.id) ? enrollment : newest, null);
  return latest ? dripBucket(latest) : null;
}
