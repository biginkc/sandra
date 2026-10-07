import { NORMA_OPEN_STATUSES } from "./types";

/** The slice of a request row the lead page shows. */
export type NormaRequestView = {
  id: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  callback_raw: string | null;
  /** Converted from the seller's words (or an exact time); still unconfirmed. */
  callback_requested_for?: string | null;
  callback_timezone?: string | null;
  completed_at: string | null;
  /** 1, or 2 once the first call was not answered and Norma is calling again. */
  attempt?: number | null;
};

export const NORMA_REQUEST_VIEW_COLUMNS =
  "id, status, outcome, summary, callback_raw, callback_requested_for, callback_timezone, completed_at, attempt";

/** "Tue, Oct 6, 3:00 PM CDT" in the seller's zone; null when there is no usable time. */
export function formatNormaCallbackTime(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(ms));
  try {
    return format(timeZone || "America/Chicago");
  } catch {
    return format("America/Chicago");
  }
}

/** The request, if any, that is currently holding the lead (newest first input). */
export function findOpenNormaRequest(rows: readonly NormaRequestView[]): NormaRequestView | null {
  return rows.find((row) => (NORMA_OPEN_STATUSES as readonly string[]).includes(row.status)) ?? null;
}

/** The newest finished call (rows are newest first), for the result badge beside the button. */
export function findLastCompletedNormaRequest(rows: readonly NormaRequestView[]): NormaRequestView | null {
  return rows.find((row) => row.status === "completed") ?? null;
}
