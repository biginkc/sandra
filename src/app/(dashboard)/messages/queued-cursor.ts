/**
 * Keyset cursor for the Outbox queue list — the (scheduled_for, id) of
 * the last row the client already has. Keyset (not offset) because rows
 * continually leave the head of the queue as they release; an offset
 * would skip rows every time the queue drains underneath the scroller.
 */
export type QueuedPageCursor = {
  scheduledFor: string | null;
  id: string;
};

/**
 * Supabase's `.or()` takes RAW PostgREST grammar — values interpolated
 * into it are NOT escaped, and the cursor arrives from the client, so a
 * crafted `id` / `scheduledFor` could rewrite the filter instead of
 * acting as a literal. Both parts are therefore strictly validated
 * against closed-form shapes before any interpolation.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 as PostgREST emits it: date T time [fractional] (Z | ±HH:MM).
// No spaces, quotes, commas, or parens can survive this shape.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export type QueuedCursorFilter =
  | { kind: "invalid" }
  /** Cursor sits in the nulls-last tail — only later-id null rows remain. */
  | { kind: "nullTail"; id: string }
  /** Strictly-after in (scheduled_for, id) order plus the nulls tail. */
  | { kind: "or"; expr: string };

/** Validate a client-supplied cursor and build the PostgREST filter. */
export function buildQueuedCursorFilter(
  cursor: QueuedPageCursor,
): QueuedCursorFilter {
  if (typeof cursor.id !== "string" || !UUID_RE.test(cursor.id)) {
    return { kind: "invalid" };
  }
  if (cursor.scheduledFor === null) {
    return { kind: "nullTail", id: cursor.id };
  }
  if (
    typeof cursor.scheduledFor !== "string" ||
    !ISO_TIMESTAMP_RE.test(cursor.scheduledFor)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "or",
    expr:
      `scheduled_for.gt."${cursor.scheduledFor}",` +
      `and(scheduled_for.eq."${cursor.scheduledFor}",id.gt.${cursor.id}),` +
      `scheduled_for.is.null`,
  };
}
