import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { pauseEnrollmentsForCallerPhone } from "@/lib/norma/inbound-call-pause";
import type { Database, Json } from "@/lib/supabase/types";

import type { DropStatusStore } from "./status-updates";

/**
 * A seller calling back the voicemail drop number pauses their drips
 * (Decided by Jarrad 2026-10-20). The drop line forwards to Norma, and
 * forwarding replaces the caller ID, so Norma's inbound record shows the drop
 * line, not the seller. Drop Cowboy's `contact.call.ringing` event (fired when
 * an inbound call reaches a phone-line Forward step) carries the real caller
 * in `data.call.from` (WebhookCall) and the dialed line in `data.ivr_id`.
 */
export const DROPCOWBOY_CALL_RINGING_EVENT = "contact.call.ringing";

export type DropCowboyInboundCallEvent = {
  eventId: string;
  ivrId: string | null;
  direction: string | null;
  callerPhone: string | null;
  raw: Record<string, unknown>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function parseDropCowboyCallEvent(rawBody: string): DropCowboyInboundCallEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("dropcowboy call webhook: body is not JSON");
  }
  const body = obj(parsed);
  if (!body || body.event !== DROPCOWBOY_CALL_RINGING_EVENT) throw new Error("dropcowboy call webhook: not contact.call.ringing");
  const eventId = str(body.event_id);
  if (!eventId) throw new Error("dropcowboy call webhook: missing event_id");
  const data = obj(body.data);
  if (!data) throw new Error("dropcowboy call webhook: missing data");
  const call = obj(data.call);
  return {
    eventId,
    ivrId: str(data.ivr_id),
    direction: str(call?.call_direction) ?? str(data.call_direction),
    callerPhone: str(call?.from),
    raw: body,
  };
}

export type InboundCallOutcome = "ignored_other_line" | "ignored_not_inbound" | "duplicate" | "unmatched" | "paused";

export interface InboundCallPauseStore {
  /** Orgs that sent a voicemail drop to this E.164 number. */
  orgIdsForDropRecipient(phone: string): Promise<string[]>;
  pauseForCaller(orgId: string, phone: string): Promise<{ matchedContactIds: string[]; paused: number }>;
}

export function supabaseInboundCallPauseStore(client: SupabaseClient<Database>): InboundCallPauseStore {
  return {
    async orgIdsForDropRecipient(phone) {
      const { data, error } = await client.from("voicemail_drops").select("org_id").eq("to_phone", phone);
      if (error) throw new Error(`orgIdsForDropRecipient: ${error.message}`);
      return [...new Set((data ?? []).map((r) => r.org_id))];
    },
    pauseForCaller: (orgId, phone) => pauseEnrollmentsForCallerPhone(client, orgId, phone),
  };
}

/**
 * Signature is checked by the caller. Acts only on inbound calls to
 * DROPCOWBOY_PHONE_LINE_ID. The line is shared across Drop Cowboy, so the org
 * is any org that dropped a voicemail on the caller's number; within it the
 * caller is matched exactly as Norma's call-back pause matches.
 */
export async function handleDropCowboyInboundCall(
  events: Pick<DropStatusStore, "reserveEvent" | "finishEvent">,
  pauses: InboundCallPauseStore,
  event: DropCowboyInboundCallEvent,
  phoneLineId: string,
): Promise<InboundCallOutcome> {
  if (!event.ivrId || event.ivrId !== phoneLineId) return "ignored_other_line";
  if (event.direction === "outbound") return "ignored_not_inbound";
  const reservation = await events.reserveEvent(DROPCOWBOY_CALL_RINGING_EVENT, event.eventId, event.raw as Json);
  if (reservation === "skip") return "duplicate";
  try {
    const phone = normalizePhone(event.callerPhone);
    let matched = 0;
    if (phone) {
      for (const orgId of await pauses.orgIdsForDropRecipient(phone)) {
        matched += (await pauses.pauseForCaller(orgId, phone)).matchedContactIds.length;
      }
    }
    await events.finishEvent(DROPCOWBOY_CALL_RINGING_EVENT, event.eventId, "processed");
    return matched > 0 ? "paused" : "unmatched";
  } catch (error) {
    await events.finishEvent(DROPCOWBOY_CALL_RINGING_EVENT, event.eventId, "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
