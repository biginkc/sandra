import type { InboxDetail } from "@/app/(dashboard)/messages/inbox-detail-data";

export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const MAX_HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_CURSOR_LENGTH = 512;

export type ReadValidationError =
  | "INVALID_REQUEST"
  | "INVALID_CONVERSATION_ID"
  | "INVALID_PAGE_SIZE"
  | "CURSOR_TOO_LARGE"
  | "INVALID_CURSOR"
  | "CURSOR_CONVERSATION_MISMATCH";

type Validation<T> = { ok: true; value: T } | { ok: false; error: ReadValidationError };

/** Boundary for descending (created_at, id) keyset pagination, excluding this row. */
export type HistoryPosition = { createdAt: string; id: string };
export type InboxReadRequest = {
  conversationId: string;
  pageSize: number;
  before: HistoryPosition | null;
};

export type InboxHistoryMessage = Pick<InboxDetail["initialMessages"][number],
  "id" | "created_at" | "channel" | "direction" | "body" | "status" |
  "read_at" | "sent_at" | "delivered_at" | "failed_at" | "from_address" | "to_address">;

/** Display data only. Permission/consent must be rechecked by mutation handlers. */
export type InboxReadResponse =
  | {
      status: "ready";
      conversationId: string;
      context: Omit<InboxDetail, "initialMessages" | "conversationId" | "threadId">;
      /** Oldest-to-newest within this page; the cursor requests the older page. */
      messages: InboxHistoryMessage[];
      nextCursor: string | null;
      /** Separate read observations, NOT an atomic snapshot or universal revision. */
      freshness: { contextReadCompletedAt: string; latestInbound: HistoryPosition | null };
    }
  | { status: "unavailable" | "error"; conversationId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const invalid = (error: ReadValidationError): { ok: false; error: ReadValidationError } => ({ ok: false, error });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (offsetHour === undefined || (Number(offsetHour) <= 14 && Number(offsetMinute) < 60
      && (Number(offsetHour) !== 14 || Number(offsetMinute) === 0)));
}

/** Opaque transport, not a signature or access grant. Preserve database microseconds. */
export function encodeHistoryCursor(conversationId: string, position: HistoryPosition): string {
  if (!uuid(conversationId) || !uuid(position.id) || !timestamp(position.createdAt)) {
    throw new Error("Invalid history cursor position");
  }
  return btoa(JSON.stringify({ v: 1, conversationId: conversationId.toLowerCase(),
    createdAt: position.createdAt, id: position.id.toLowerCase() }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: unknown, conversationId: string): Validation<HistoryPosition> {
  if (typeof cursor !== "string") return invalid("INVALID_CURSOR");
  if (cursor.length > MAX_HISTORY_CURSOR_LENGTH) return invalid("CURSOR_TOO_LARGE");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid("INVALID_CURSOR");
  try {
    const parsed: unknown = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (!object(parsed) || Object.keys(parsed).length !== 4 || parsed.v !== 1
      || !uuid(parsed.conversationId) || !uuid(parsed.id) || !timestamp(parsed.createdAt)) {
      return invalid("INVALID_CURSOR");
    }
    if (parsed.conversationId.toLowerCase() !== conversationId) return invalid("CURSOR_CONVERSATION_MISMATCH");
    const position = { createdAt: parsed.createdAt, id: parsed.id.toLowerCase() };
    if (encodeHistoryCursor(conversationId, position) !== cursor) return invalid("INVALID_CURSOR");
    return { ok: true, value: position };
  } catch {
    return invalid("INVALID_CURSOR");
  }
}

/** No tenant input: the future reader must derive org/access from its authenticated session.
 * URL adapters must explicitly parse pageSize to a number; coercion is not done here.
 * Reading must never mark read. Mark-read is a separate action after intended content renders.
 */
export function validateInboxReadRequest(input: unknown): Validation<InboxReadRequest> {
  if (!object(input) || Object.keys(input).some(key => !["conversationId", "pageSize", "cursor"].includes(key))) {
    return invalid("INVALID_REQUEST");
  }
  if (!uuid(input.conversationId)) return invalid("INVALID_CONVERSATION_ID");
  const conversationId = input.conversationId.toLowerCase();
  const pageSize = input.pageSize === undefined ? DEFAULT_HISTORY_PAGE_SIZE : input.pageSize;
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE_SIZE) {
    return invalid("INVALID_PAGE_SIZE");
  }
  if (input.cursor === undefined || input.cursor === null) {
    return { ok: true, value: { conversationId, pageSize, before: null } };
  }
  const decoded = decodeCursor(input.cursor, conversationId);
  if (!decoded.ok) return decoded;
  return { ok: true, value: { conversationId, pageSize, before: decoded.value } };
}
