import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

/**
 * TCPA consent state for a given (contact, channel). Computed from the
 * `consent_events` event log rather than a boolean on `contacts` so we
 * have an audit trail for every state transition.
 *
 * Rule: the most recent `opt_in_*` or `opt_out` event wins. `help_request`
 * is logged but doesn't mutate state — it's informational per TCPA.
 *
 * Marketing vs informational split matters for real-estate wholesaling:
 *  - "We'd like to buy your house" = marketing → needs WRITTEN consent
 *  - "Your signing appointment is at 2pm" = informational → express is enough
 */
export type ConsentState =
  | "can_send_marketing"
  | "can_send_informational_only"
  | "opted_out"
  | "no_consent";

export type ConsentChannel = "sms" | "email" | "voice";

/** Event types as stored in `consent_events.event_type`. */
export type ConsentEventType =
  | "opt_in_marketing_written"
  | "opt_in_informational"
  | "opt_in_confirmed"
  | "opt_out"
  | "help_request"
  | "provider_auto_opt_out";

export type RecordConsentEventOutcome =
  | { inserted: true; id: string }
  | { inserted: false; id: string | null };

/**
 * Map a sequence of events (most-recent-first is fine, we sort here) to
 * the current effective state. Pure function — DB-free and testable.
 */
export function computeConsentState(
  events: ReadonlyArray<{ event_type: string; occurred_at: string }>,
): ConsentState {
  const sorted = [...events].sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at),
  );
  for (const e of sorted) {
    const type = e.event_type as ConsentEventType;
    switch (type) {
      case "help_request":
        // Informational — skip.
        continue;
      case "opt_out":
      case "provider_auto_opt_out":
        return "opted_out";
      case "opt_in_marketing_written":
      case "opt_in_confirmed":
        return "can_send_marketing";
      case "opt_in_informational":
        return "can_send_informational_only";
      default:
        continue;
    }
  }
  return "no_consent";
}

/**
 * Read the latest consent state for a (contact, channel). Queries the
 * indexed `(contact_id, channel, occurred_at desc)` path.
 */
export async function getConsentState(
  supabase: SupabaseClient<Database>,
  contactId: string,
  channel: ConsentChannel,
): Promise<ConsentState> {
  const { data, error } = await supabase
    .from("consent_events")
    .select("event_type, occurred_at")
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .order("occurred_at", { ascending: false })
    .limit(20);
  if (error) {
    // Conservative default — without state, treat as no consent. Caller
    // presents a clear UI message; data issues never cause silent sends.
    return "no_consent";
  }
  return computeConsentState(data ?? []);
}

/**
 * Append a consent event. Used both by app code (e.g. a manual opt-in
 * capture on the UI) and by the inbound webhook (STOP → opt_out).
 */
export async function recordConsentEvent(
  supabase: SupabaseClient<Database>,
  params: {
    contactId: string;
    channel: ConsentChannel;
    eventType: ConsentEventType;
    source: string;
    sourceDetail?: unknown;
    occurredAt?: Date;
    idempotencyKey?: string;
  },
): Promise<RecordConsentEventOutcome> {
  // `consent_events` is protected by a composite (contact_id, org_id) FK.
  // Never rely on the table's legacy default org: webhook/service-role callers
  // can write for any tenant, so the contact row is the authoritative source.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("org_id")
    .eq("id", params.contactId)
    .maybeSingle();
  if (contactError || !contact?.org_id) {
    throw new Error(
      `recordConsentEvent contact lookup: ${contactError?.message ?? "contact not found"}`,
    );
  }

  const rowId = crypto.randomUUID();
  const row = {
    id: rowId,
    org_id: contact.org_id,
    contact_id: params.contactId,
    channel: params.channel,
    event_type: params.eventType,
    source: params.source,
    source_detail: buildConsentSourceDetail(
      params.sourceDetail,
      params.idempotencyKey,
    ) as Json,
    occurred_at: (params.occurredAt ?? new Date()).toISOString(),
  };
  if (params.idempotencyKey) {
    const { data: existing, error: lookupError } = await supabase
      .from("consent_events")
      .select("id")
      .eq("org_id", contact.org_id)
      .eq("contact_id", params.contactId)
      .eq("channel", params.channel)
      .eq("event_type", params.eventType)
      .eq("source", params.source)
      .contains("source_detail", { externalId: params.idempotencyKey })
      .limit(1);
    if (lookupError) {
      throw new Error(`recordConsentEvent lookup: ${lookupError.message}`);
    }
    if ((existing ?? []).length > 0) {
      return { inserted: false, id: existing?.[0]?.id ?? null };
    }
  }

  const { error } = await supabase.from("consent_events").insert(row);
  if (!error) return { inserted: true, id: rowId };
  if (params.idempotencyKey && isConsentIdempotencyDuplicate(error)) {
    return { inserted: false, id: null };
  }
  throw new Error(`recordConsentEvent: ${error.message}`);
}

function buildConsentSourceDetail(
  sourceDetail: unknown,
  idempotencyKey?: string,
): Json | null {
  if (!idempotencyKey) {
    return sourceDetail == null ? null : (sourceDetail as Json);
  }

  const base =
    sourceDetail && typeof sourceDetail === "object" && !Array.isArray(sourceDetail)
      ? (sourceDetail as Record<string, unknown>)
      : {};

  return {
    ...base,
    externalId: idempotencyKey,
  } as Json;
}

function isConsentIdempotencyDuplicate(error: { code?: string; message: string }): boolean {
  return (
    error.code === "23505" ||
    error.message.includes("idx_consent_events_external_idempotency") ||
    error.message.includes("source_external_id")
  );
}
