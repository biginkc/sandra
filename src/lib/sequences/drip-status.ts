export type DripBucket = "waiting" | "replied" | "finished_no_reply" | "couldnt_send" | "stopped";

export const DRIP_BUCKET_LABELS: Record<DripBucket, string> = {
  waiting: "Waiting",
  replied: "Replied",
  finished_no_reply: "Finished, no reply",
  couldnt_send: "Couldn't send",
  stopped: "Stopped",
};

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
