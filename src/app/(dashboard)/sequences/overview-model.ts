import type { NeedsPersonRow } from "./actions";

export const NEEDS_PERSON_PAGE_SIZE = 50;

export function needsPersonPiles<T extends Pick<NeedsPersonRow, "bucket">>(rows: T[]) {
  return {
    finished_no_reply: rows.filter((row) => row.bucket === "finished_no_reply"),
    couldnt_send: rows.filter((row) => row.bucket === "couldnt_send"),
    needs_sequence: rows.filter((row) => row.bucket === "needs_sequence"),
  };
}
