import { NORMA_OPEN_STATUSES } from "./types";

/** The slice of a request row the lead page shows. */
export type NormaRequestView = {
  id: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  callback_raw: string | null;
  completed_at: string | null;
};

export const NORMA_REQUEST_VIEW_COLUMNS = "id, status, outcome, summary, callback_raw, completed_at";

/** The request, if any, that is currently holding the lead (newest first input). */
export function findOpenNormaRequest(rows: readonly NormaRequestView[]): NormaRequestView | null {
  return rows.find((row) => (NORMA_OPEN_STATUSES as readonly string[]).includes(row.status)) ?? null;
}
