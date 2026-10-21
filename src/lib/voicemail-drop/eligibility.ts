import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Who gets a voicemail drop (plan RULING RVM-2 / RVM-3, build-order step 3).
 *
 * "Already spoken to", scoped to the same contact_id, any of:
 *   - acquisition_attempts.outcome = 'reached' (scoped to the contact through
 *     its call_activity_id; an attempt with no call activity cannot be tied to
 *     a contact and does not count)
 *   - call_activities.talk_duration_seconds > 0
 *   - an inbound messages row
 *   - an answered Norma (Bland) call (Jarrad, 2026-10-20). Norma calls never
 *     write call_activities, so they are read explicitly:
 *       norma_call_requests.outcome in NORMA_ANSWERED_OUTCOMES for the contact
 *       norma_inbound_calls (seller called Norma) with completed = true, same
 *       property, from_e164 saved on the contact
 *
 * Plus: a usable phone, do_not_contact false, sms_opted_out false, and the
 * same per-number "don't call" checks every other calling path uses
 * (norma_call_queue eligibility): the phone is not in
 * global_phone_dnc_registry and Norma never reached it as wrong_number. A
 * blocked phone is never chosen; if every saved phone is blocked the contact
 * is not eligible. The
 * outreach_dispo pause runs before the claim in tick.ts. Deliberately NOT
 * call_activities.outcome = 'connected_human' and NOT getConsentState(voice).
 *
 * Number: the phone from the most recent qualifying event when it is still
 * saved on the contact (non-landline), else the first mobile slot, else the
 * first non-landline slot of unknown type (Drop Cowboy's mobile_only filter
 * rejects landlines anyway).
 */

/** Norma outcomes that mean a person answered. wrong_number (wrong person),
 * no_answer, unknown and reviewed (original outcome overwritten) do not. */
export const NORMA_ANSWERED_OUTCOMES = [
  "callback_requested",
  "reached_no_callback",
  "not_interested",
] as const;

export type SpokenToBasis =
  | "acquisition_attempt_reached"
  | "call_talk_time"
  | "inbound_message"
  | "norma_answered_call"
  | "norma_inbound_call";

export type VoicemailDropEligibility =
  | { eligible: true; phone: string; basis: SpokenToBasis; phoneSource: "qualifying_event" | "contact_slot" }
  | {
      eligible: false;
      reason:
        | "contact_missing"
        | "do_not_contact"
        | "opted_out"
        | "no_phone"
        | "not_spoken_to"
        | DropPhoneBlockReason;
    };

export type DropPhoneBlockReason = "global_dnc_registry" | "wrong_number_flagged";

export function toE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

type QualifyingEvent = { basis: SpokenToBasis; phone: string | null; at: string | null };

export class EligibilityReadError extends Error {}

function check<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new EligibilityReadError(`${what}: ${result.error.message}`);
  return (result.data ?? ([] as unknown)) as T;
}

/**
 * Per-number blocks, mirroring norma_call_queue (20261009010100:2276-2300):
 * global_phone_dnc_registry for the org, and a completed Norma call with
 * outcome wrong_number. Phones must already be E.164 (+1XXXXXXXXXX). Returns
 * phone → reason for each blocked phone (registry wins). Throws
 * EligibilityReadError on a read failure.
 */
export async function findBlockedDropPhones(
  client: SupabaseClient<Database>,
  orgId: string,
  phones: string[],
): Promise<Map<string, DropPhoneBlockReason>> {
  const blocked = new Map<string, DropPhoneBlockReason>();
  if (phones.length === 0) return blocked;
  // global_phone_dnc_registry is not in the generated types.
  const untyped = client as unknown as SupabaseClient;
  const [registry, wrong] = await Promise.all([
    untyped.from("global_phone_dnc_registry").select("phone_e164").eq("org_id", orgId).in("phone_e164", phones),
    client
      .from("norma_call_requests")
      .select("phone_e164")
      .eq("org_id", orgId)
      .eq("status", "completed")
      .eq("outcome", "wrong_number")
      .in("phone_e164", phones),
  ]);
  for (const w of check(wrong, "norma wrong_number") as { phone_e164: string }[]) {
    blocked.set(w.phone_e164, "wrong_number_flagged");
  }
  for (const r of check(registry, "global_phone_dnc_registry") as { phone_e164: string }[]) {
    blocked.set(r.phone_e164, "global_dnc_registry");
  }
  return blocked;
}

/** Throws EligibilityReadError on any read failure (callers fail closed). */
export async function checkVoicemailDropEligibility(
  client: SupabaseClient<Database>,
  params: { orgId: string; contactId: string; propertyId: string },
): Promise<VoicemailDropEligibility> {
  const contactResult = await client
    .from("contacts")
    .select("id, do_not_contact, sms_opted_out, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type")
    .eq("id", params.contactId)
    .eq("org_id", params.orgId)
    .maybeSingle();
  if (contactResult.error) throw new EligibilityReadError(`contact: ${contactResult.error.message}`);
  const contact = contactResult.data;
  if (!contact) return { eligible: false, reason: "contact_missing" };
  if (contact.do_not_contact) return { eligible: false, reason: "do_not_contact" };
  if (contact.sms_opted_out) return { eligible: false, reason: "opted_out" };

  const slots = [
    { phone: toE164(contact.phone_1), type: contact.phone_1_type },
    { phone: toE164(contact.phone_2), type: contact.phone_2_type },
    { phone: toE164(contact.phone_3), type: contact.phone_3_type },
  ].filter((s): s is { phone: string; type: string } => Boolean(s.phone) && s.type !== "landline");
  if (slots.length === 0) return { eligible: false, reason: "no_phone" };
  const slotPhones = slots.map((s) => s.phone);
  const blocked = await findBlockedDropPhones(client, params.orgId, [...new Set(slotPhones)]);
  const usableSlots = slots.filter((s) => !blocked.has(s.phone));
  const usablePhones = usableSlots.map((s) => s.phone);

  const [calls, attempts, inbound, norma, normaInbound] = await Promise.all([
    client
      .from("call_activities")
      .select("phone_e164, started_at")
      .eq("org_id", params.orgId)
      .eq("contact_id", params.contactId)
      .gt("talk_duration_seconds", 0)
      .order("started_at", { ascending: false })
      .limit(5),
    client
      .from("acquisition_attempts")
      .select("call_activity_id, occurred_at")
      .eq("org_id", params.orgId)
      .eq("property_id", params.propertyId)
      .eq("outcome", "reached")
      .not("call_activity_id", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(20),
    client
      .from("messages")
      .select("from_address, created_at")
      .eq("org_id", params.orgId)
      .eq("contact_id", params.contactId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(5),
    client
      .from("norma_call_requests")
      .select("phone_e164, completed_at")
      .eq("org_id", params.orgId)
      .eq("contact_id", params.contactId)
      .in("outcome", [...NORMA_ANSWERED_OUTCOMES])
      .order("completed_at", { ascending: false })
      .limit(5),
    client
      .from("norma_inbound_calls")
      .select("from_e164, created_at")
      .eq("org_id", params.orgId)
      .eq("property_id", params.propertyId)
      .eq("completed", true)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const events: QualifyingEvent[] = [];
  for (const c of check(calls, "call_activities") as { phone_e164: string | null; started_at: string | null }[]) {
    events.push({ basis: "call_talk_time", phone: toE164(c.phone_e164), at: c.started_at });
  }
  for (const m of check(inbound, "messages") as { from_address: string | null; created_at: string }[]) {
    events.push({ basis: "inbound_message", phone: toE164(m.from_address), at: m.created_at });
  }
  for (const n of check(norma, "norma_call_requests") as { phone_e164: string; completed_at: string | null }[]) {
    events.push({ basis: "norma_answered_call", phone: toE164(n.phone_e164), at: n.completed_at });
  }
  for (const n of check(normaInbound, "norma_inbound_calls") as { from_e164: string; created_at: string }[]) {
    const phone = toE164(n.from_e164);
    // Inbound Norma calls carry no contact_id; tie them by a saved phone.
    if (phone && slotPhones.includes(phone)) {
      events.push({ basis: "norma_inbound_call", phone, at: n.created_at });
    }
  }
  const attemptRows = check(attempts, "acquisition_attempts") as {
    call_activity_id: string | null;
    occurred_at: string;
  }[];
  const attemptCallIds = attemptRows.map((a) => a.call_activity_id).filter((id): id is string => Boolean(id));
  if (attemptCallIds.length > 0) {
    const attemptCalls = check(
      await client
        .from("call_activities")
        .select("id, phone_e164")
        .eq("org_id", params.orgId)
        .eq("contact_id", params.contactId)
        .in("id", attemptCallIds),
      "acquisition_attempt call_activities",
    ) as { id: string; phone_e164: string | null }[];
    const byId = new Map(attemptCalls.map((c) => [c.id, c.phone_e164]));
    for (const a of attemptRows) {
      if (a.call_activity_id && byId.has(a.call_activity_id)) {
        events.push({
          basis: "acquisition_attempt_reached",
          phone: toE164(byId.get(a.call_activity_id)),
          at: a.occurred_at,
        });
      }
    }
  }

  if (events.length === 0) return { eligible: false, reason: "not_spoken_to" };

  if (usableSlots.length === 0) {
    const reasons = [...blocked.values()];
    return {
      eligible: false,
      reason: reasons.includes("global_dnc_registry") ? "global_dnc_registry" : "wrong_number_flagged",
    };
  }

  events.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const fromEvent = events.find((e) => e.phone && usablePhones.includes(e.phone));
  if (fromEvent?.phone) {
    return { eligible: true, phone: fromEvent.phone, basis: fromEvent.basis, phoneSource: "qualifying_event" };
  }
  const primary = usableSlots.find((s) => s.type === "mobile") ?? usableSlots[0];
  return { eligible: true, phone: primary.phone, basis: events[0].basis, phoneSource: "contact_slot" };
}

/** Plan: rendered script is at most 1,200 characters. */
export const VOICEMAIL_DROP_SCRIPT_MAX_CHARS = 1200;

/**
 * Start (and next start) of the calendar day in America/Chicago, for the
 * per-org daily cap. Day length is taken as 24h (DST days are an hour off,
 * which only shifts when a capped drop retries).
 */
export function chicagoDayWindow(now: Date): { start: Date; next: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const start = new Date(Date.UTC(get("year"), get("month") - 1, get("day")) - offsetMs);
  return { start, next: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * DROPCOWBOY_CALLER_ID: BYOC caller ID (the dedicated Telnyx number). Unset =
 * null (use the step's phone line). Set but not E.164 = throws.
 */
/**
 * DROPCOWBOY_BRAND_ID: optional registered brand, sent as `brand_id`.
 * Unset/blank = null (not sent).
 */
export function readDropBrandId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DROPCOWBOY_BRAND_ID?.trim() || null;
}

/**
 * Drop Cowboy spins "[Hi/Hello/Hey]" into one random option per message.
 * Sandra controls script choice, so square brackets holding a "/" must never
 * reach it.
 */
export function hasDropCowboyRandomVariant(text: string): boolean {
  return /\[[^\[\]]*\/[^\[\]]*\]/.test(text);
}

export function readDropCallerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DROPCOWBOY_CALLER_ID?.trim();
  if (!raw) return null;
  if (!/^\+[1-9]\d{1,14}$/.test(raw)) throw new Error("DROPCOWBOY_CALLER_ID must be E.164 (e.g. +18165550100)");
  return raw;
}

/**
 * VOICEMAIL_DROP_DAILY_CAP: non-negative integer, or null when unset (no cap).
 * Set but not an integer (negative, decimal, text) = throws, so a typo fails
 * closed instead of silently removing the cap.
 */
export function readDailyCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.VOICEMAIL_DROP_DAILY_CAP?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error("VOICEMAIL_DROP_DAILY_CAP must be a non-negative integer");
  return Number(raw);
}
