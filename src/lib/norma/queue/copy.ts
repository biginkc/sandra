/**
 * All Norma queue UI wording in one place so lines can be swapped without touching components.
 * Draft shown to Jarrad 2026-10-07; do not add strings here without approval.
 */
export const NORMA_QUEUE_COPY = {
  dialog: {
    button: "Queue Norma calls",
    title: (n: number) => `Queue ${n} leads for Norma`,
    hours: "Norma calls 9:00 AM to 7:30 PM in the seller's time zone, Monday to Saturday.",
    retry: "If no one answers, she tries twice a day for 3 days, daily for 2 weeks, then monthly up to 6 times.",
    contextLabel: "Note for Norma (optional, used on every call)",
    submit: "Queue calls",
    switchedOff: "The Norma queue is switched off. Leads will be queued but not called until it is switched on.",
    queued: (n: number) => `Queued: ${n}`,
    alreadyQueued: (n: number) => `Already queued: ${n}`,
    notQueued: (n: number) => `Not queued: ${n}`,
    capacity: (cap: number, due: number) => `Norma can place ${cap} calls today. ${due} are already due.`,
  },
  chip: {
    add: "Add to Norma queue",
    status: {
      queued: "Queued",
      calling: "Calling now",
      paused: "Paused",
      done: "Done",
      cancelled: "Cancelled",
      exhausted: "Finished trying",
    } as Record<string, string>,
    nextCall: (time: string) => `Next call ${time} (seller's time)`,
    attempts: (n: number) => `${n} of 24 tries`,
    pauseReason: {
      inbound_reply: "Seller replied",
      needs_review: "Needs review",
      reviewed: "Needs review",
      unknown_state: "Unknown time zone",
      provider_refused: "Bland refused the call",
    } as Record<string, string>,
    pausedBy: (name: string | null | undefined) => `Paused by ${name?.trim() ? name.trim() : "a teammate"}`,
    needsReassignment: "Needs a new callback owner",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    cancelPrompt: "Stop Norma calling this lead?",
    cancelBulkPrompt: "Stop Norma calling these leads?",
  },
  page: {
    title: "Norma queue",
    filterCalling: "Calling now",
    filterDueToday: "Due today",
    filterPaused: "Paused",
    filterBlocked: "Blocked",
    filterReassignment: "Needs new owner",
    placed: (placed: number, cap: number) => `${placed} of ${cap} calls placed today`,
    heldSlots: (n: number) => `${n} calls waiting for review are holding a calling slot`,
  },
} as const;

export function normaQueuePauseReasonText(reason: string | null, pausedByName?: string | null): string | null {
  if (!reason) return null;
  if (reason === "rep_paused") return NORMA_QUEUE_COPY.chip.pausedBy(pausedByName);
  return NORMA_QUEUE_COPY.chip.pauseReason[reason] ?? null;
}

/** Next attempt in the SELLER's zone (never the browser's). */
export function formatNormaQueueTime(iso: string | null, tz: string | null): string | null {
  if (!iso || !tz) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return null;
  }
}
