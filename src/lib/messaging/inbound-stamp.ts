/**
 * Reply-to stamp for human SMS sends. The composer captures the newest inbound
 * message id it showed when it opened; the outbound row carries it as top-level
 * `metadata.inbound_message_id` (same key the AI responder writes).
 *
 * The browser supplies the id, so it is never trusted: it must reference an
 * inbound message in the same org and the same property.
 * Anything else is dropped silently (logged once) and the send proceeds
 * unstamped. Ordering is never derived from the id itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InboundStampScope = {
  orgId: string;
  propertyId: string;
};

export function normalizeInboundMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID.test(trimmed) ? trimmed : null;
}

type StampRow = {
  direction: string | null;
  org_id: string | null;
  property_id: string | null;
};

/** Returns the id when valid for this send, otherwise null. Never throws. */
export async function resolveInboundStamp(
  // Structural so both the user-scoped and admin clients fit without the
  // generated Database generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: any) => any },
  inboundMessageId: unknown,
  scope: InboundStampScope,
): Promise<string | null> {
  if (inboundMessageId === undefined || inboundMessageId === null || inboundMessageId === "") return null;
  const id = normalizeInboundMessageId(inboundMessageId);
  if (!id) {
    console.warn("[inbound-stamp] dropped: malformed inbound_message_id");
    return null;
  }
  try {
    const { data, error } = await client
      .from("messages")
      .select("direction, org_id, property_id")
      .eq("id", id)
      .maybeSingle();
    const row = data as StampRow | null;
    if (
      error ||
      !row ||
      row.direction !== "inbound" ||
      row.org_id !== scope.orgId ||
      row.property_id !== scope.propertyId
    ) {
      console.warn("[inbound-stamp] dropped: inbound_message_id failed validation");
      return null;
    }
    return id;
  } catch {
    console.warn("[inbound-stamp] dropped: validation lookup failed");
    return null;
  }
}

/**
 * Newest inbound SMS id in a thread: highest `created_at`, ties broken by the
 * larger id so the result is the same for any input order. The id is only a
 * deterministic tie-break between rows with identical timestamps, matching the
 * `(created_at, id)` order the classifier uses.
 */
export function latestInboundMessageId(
  messages: ReadonlyArray<{ id: string; direction: string | null; channel?: string | null; created_at: string | null }>,
): string | null {
  let best: { id: string; at: number } | null = null;
  for (const message of messages) {
    if (message.direction !== "inbound") continue;
    if (message.channel !== undefined && message.channel !== null && message.channel !== "sms") continue;
    const at = message.created_at ? Date.parse(message.created_at) : NaN;
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at || (at === best.at && message.id > best.id)) best = { id: message.id, at };
  }
  return best?.id ?? null;
}
