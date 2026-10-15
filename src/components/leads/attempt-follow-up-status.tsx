import type { RepSmsObligationStatus } from "@/lib/my-leads/queries";

/**
 * No-answer text follow-up status for one outreach attempt. Copy and markup
 * match the My Leads detail panel so the lead page says the same thing.
 */
export function AttemptFollowUpStatus({
  attemptId,
  status,
  message,
  blockedReason,
}: {
  attemptId: string;
  status: RepSmsObligationStatus;
  message?: string | null;
  blockedReason?: string | null;
}) {
  return (
    <div
      className="col-span-2 space-y-0.5 rounded-md border border-blue-200 bg-blue-50/60 px-2.5 py-2 text-xs dark:border-blue-900 dark:bg-blue-950/30"
      data-testid={`attempt-follow-up-${attemptId}`}
    >
      <p className="font-semibold">Text follow-up: {formatFollowUpStatus(status)}</p>
      {message && <p className="text-muted-foreground">Status detail: {message}</p>}
      {blockedReason && <p className="text-muted-foreground">Blocked reason: {blockedReason}</p>}
      <p className="text-muted-foreground">{followUpGuidance(status)}</p>
    </div>
  );
}

export function formatFollowUpStatus(status: RepSmsObligationStatus) {
  return status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function followUpGuidance(status: RepSmsObligationStatus) {
  if (status === "required" || status === "draft" || status === "failed_not_dispatched") {
    return "Open Text lead to resume this saved follow-up.";
  }
  if (status === "accepted" || status === "delivered") {
    return "Review the text history for the provider and delivery record.";
  }
  if (status === "blocked") {
    return "Resolve the blocked reason, then review the saved follow-up before sending.";
  }
  return "Review the text history before retrying; automatic retry is disabled.";
}
