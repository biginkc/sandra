import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { getConsentStateStrict } from "@/lib/messaging/consent";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import { sendSmsToContact, type SendSmsOutcome } from "@/lib/messaging/send";
import {
  classifyNineQuestions,
  NINE_HOT_REPLY_TEXTS,
  type NineQuestionResult,
  type NineQuestionState,
} from "@/lib/sms-classification/nine-questions";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * One-off backfill (2026-10-20): sellers who texted "what's your offer?" before
 * the approved asked_offer reply shipped (PR #909). Jev ran on those texts with
 * the old questions, promoted the lead and deliberately sent nothing
 * (`model:new_lead_promoted`), so nothing will ever answer them.
 *
 * For each lead this re-asks the CURRENT nine-question classifier about the
 * lead's latest inbound, and only when that answer is `asked_offer` sends
 * Jarrad's approved text (NINE_HOT_REPLY_TEXTS.asked_offer, used byte for byte)
 * NOW through the normal automated send path (strict consent, opt-out, phone
 * suppression, the property's quiet hours, the fresh automated-suppression
 * re-check, sticky sender, provider). Never queued: a text that waits can go
 * stale.
 *
 * Fences, in order:
 * - the scan's skip rule (backfillSkipReason) on fresh per-lead facts;
 * - beforeProviderSubmit: the same facts re-read after the pending row exists
 *   (ignoring that row), plus "the source inbound is still the latest" and the
 *   8:00–21:00 Chicago window, as the last step before the provider;
 * - one send per seller phone, ever, enforced by the database: a deterministic
 *   idempotency key (org + phone) on the unique (org_id, idempotency_key)
 *   outbound index, so a second or concurrent run, or a second property with the
 *   same seller, replays the first row instead of sending.
 *
 * History is read by property AND by the seller's phone across the org, so a
 * text, call or reply on another property with the same number counts.
 *
 * Fails closed: a send refused at the fence (or failed at the provider) leaves a
 * failed row that keeps the key and counts as "texted since", so this script
 * never retries that seller. Those show up in the apply report; follow up by hand.
 */

export const ASKED_OFFER_BACKFILL_KIND = "asked_offer_backfill";
export const ASKED_OFFER_BACKFILL_BODY = NINE_HOT_REPLY_TEXTS.asked_offer;

export type BackfillMessage = {
  id: string;
  property_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  direction: string;
  status: string | null;
  body: string | null;
  from_address: string | null;
  to_address: string | null;
  created_at: string;
  sent_at: string | null;
};

export type BackfillProperty = {
  id: string;
  org_id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  status: string;
  outreach_dispo: string | null;
  ai_responder_disabled: boolean | null;
  is_dnc_locked: boolean | null;
};

export type BackfillContact = {
  id: string;
  do_not_contact: boolean | null;
  sms_opted_out: boolean | null;
};

/** Everything the skip rule needs, read fresh for one lead. */
export type BackfillFacts = {
  property: BackfillProperty;
  latestInbound: BackfillMessage | null;
  /** Any outbound sent after the latest inbound, or still waiting to go (this property or this phone). */
  outboundSinceInbound: boolean;
  /** The seller texted again from this phone, on another property, after this inbound. */
  newerInboundElsewhere: boolean;
  /** The lead's current status is still one the run was told to scan. */
  statusInScope: boolean;
  /** This exact approved text exists on the property in any status, at any time. */
  approvedTextBefore: boolean;
  /** Any call logged after the latest inbound. */
  callSinceInbound: boolean;
  contact: BackfillContact | null;
  /** null = the consent lookup failed (fails closed). */
  consentState: string | null;
  phoneSuppressed: boolean;
  excluded: boolean;
  window: { since: Date; before: Date };
};

export type BackfillSkipReason =
  | "excluded"
  | "no_inbound"
  | "inbound_outside_window"
  | "texted_since"
  | "texted_elsewhere_since"
  | "status_changed"
  | "already_got_this_text"
  | "no_inbound_number"
  | "called_since"
  | "no_contact"
  | "consent_unreadable"
  | "dnc"
  | "opted_out"
  | "phone_suppressed"
  | "terminal_disposition"
  | "ai_responder_disabled";

/** Dispositions that still mean "nobody has decided this lead yet". */
const OPEN_DISPOS: ReadonlySet<string> = new Set(["needs_sequence"]);

/** Pure skip rule. Order is report order only: any one reason skips the lead. */
export function backfillSkipReason(f: BackfillFacts): BackfillSkipReason | null {
  const thread = threadSkipReason(f);
  if (thread) return thread;
  if (!f.statusInScope) return "status_changed";
  if (f.newerInboundElsewhere) return "texted_elsewhere_since";
  if (f.approvedTextBefore) return "already_got_this_text";
  if (!f.latestInbound?.from_address) return "no_inbound_number";
  if (f.callSinceInbound) return "called_since";
  if (!f.contact || !f.latestInbound.contact_id) return "no_contact";
  if (f.consentState === null) return "consent_unreadable";
  if (f.contact.do_not_contact || f.property.is_dnc_locked) return "dnc";
  if (f.contact.sms_opted_out || f.consentState === "opted_out") return "opted_out";
  if (f.phoneSuppressed) return "phone_suppressed";
  // Stricter than the automated-send suppression set on purpose: a person who set ANY
  // disposition (not interested, nurture, booked, wrong number...) owns what happens next.
  if (f.property.outreach_dispo !== null && !OPEN_DISPOS.has(f.property.outreach_dispo)) return "terminal_disposition";
  if (f.property.ai_responder_disabled) return "ai_responder_disabled";
  return null;
}

/** The part of the rule that needs only the thread (no per-lead lookups). */
export function threadSkipReason(
  f: Pick<BackfillFacts, "excluded" | "latestInbound" | "outboundSinceInbound" | "window">,
): "excluded" | "no_inbound" | "inbound_outside_window" | "texted_since" | null {
  if (f.excluded) return "excluded";
  if (!f.latestInbound) return "no_inbound";
  const at = new Date(f.latestInbound.created_at).getTime();
  if (!(at >= f.window.since.getTime() && at < f.window.before.getTime())) return "inbound_outside_window";
  if (f.outboundSinceInbound) return "texted_since";
  return null;
}

/** The latest inbound and what surrounds it. `ignoreId` drops our own pending row. */
export function summarizeThread(
  messages: BackfillMessage[],
  ignoreId: string | null = null,
): {
  latestInbound: BackfillMessage | null;
  outboundSinceInbound: boolean;
  approvedTextBefore: boolean;
  ourLastTextBefore: string | null;
} {
  const sorted = messages.filter((m) => m.id !== ignoreId).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const approvedTextBefore = sorted.some((m) => m.direction === "outbound" && m.body === ASKED_OFFER_BACKFILL_BODY);
  let latestInbound: BackfillMessage | null = null;
  for (const m of sorted) if (m.direction === "inbound") latestInbound = m;
  if (!latestInbound) return { latestInbound: null, outboundSinceInbound: false, approvedTextBefore, ourLastTextBefore: null };
  const inboundAt = latestInbound.created_at;
  const outboundSinceInbound = sorted.some((m) => m.direction === "outbound" && outboundCountsAfter(m, inboundAt));
  const before = sorted.filter((m) => m.direction === "outbound" && m.created_at < inboundAt && m.body);
  return {
    latestInbound,
    outboundSinceInbound,
    approvedTextBefore,
    ourLastTextBefore: before.length ? before[before.length - 1]!.body : null,
  };
}

/** Not sent yet: may still go out at any moment, whenever it was created. */
const UNSENT_STATUSES: ReadonlySet<string> = new Set(["queued", "pending", "paused"]);

/**
 * An outbound counts as "texted since" when it actually went (sent_at, else
 * created_at) after the inbound, or has not gone yet. Failed rows that never
 * sent fall back to created_at.
 */
export function outboundCountsAfter(m: Pick<BackfillMessage, "status" | "created_at" | "sent_at">, inboundAt: string): boolean {
  if (m.status && UNSENT_STATUSES.has(m.status)) return true;
  return new Date(m.sent_at ?? m.created_at).getTime() > new Date(inboundAt).getTime();
}

/** True from 08:00 up to (not including) 21:00 in Chicago. */
export function chicagoWindowOpen(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now),
  );
  return hour >= 8 && hour < 21;
}

/** One key per seller phone in the org, shaped as a v4 UUID (the send path's key format). */
export function idempotencyKeyFor(orgId: string, phone: string): string {
  const h = createHash("sha256").update(`${ASKED_OFFER_BACKFILL_KIND}:${orgId}:${phone}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type BackfillSendResult = {
  status: SendSmsOutcome["status"] | "window_closed";
  messageId?: string;
  detail?: string;
};

export type BackfillRow = {
  propertyId: string;
  address: string;
  sellerText: string | null;
  inboundAt: string | null;
  inboundMessageId: string | null;
  skip: BackfillSkipReason | null;
  /** Current classifier's answer; null when skipped before classifying or Jev failed. */
  answer: string | null;
  askedOfferProbability: number | null;
  classifyError: string | null;
  /** True only when skip is null and answer is asked_offer. */
  target: boolean;
  /** Apply only: the send path's outcome (`sent` on success). */
  sent?: BackfillSendResult;
};

export type BackfillDeps = {
  classify: (state: NineQuestionState) => Promise<NineQuestionResult>;
  now: () => Date;
};

export type BackfillOptions = {
  orgId: string;
  statuses: string[];
  since: Date;
  before: Date;
  excludePropertyIds: ReadonlySet<string>;
  onlyPropertyIds: ReadonlySet<string> | null;
  apply: boolean;
};

const MESSAGE_SELECT = "id, property_id, contact_id, conversation_id, direction, status, body, from_address, to_address, created_at, sent_at";
const PROPERTY_SELECT =
  "id, org_id, address, city, state, status, outreach_dispo, ai_responder_disabled, is_dnc_locked";
const CHUNK = 100;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function loadProperties(supabase: SupabaseClient<Database>, o: BackfillOptions): Promise<BackfillProperty[]> {
  const out: BackfillProperty[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("properties")
      .select(PROPERTY_SELECT)
      .eq("org_id", o.orgId)
      .in("status", o.statuses)
      .order("id")
      .range(from, from + 999);
    if (o.onlyPropertyIds) q = q.in("id", [...o.onlyPropertyIds]);
    const { data, error } = await q;
    if (error) throw new Error(`load properties: ${error.message}`);
    out.push(...((data ?? []) as BackfillProperty[]));
    if (!data || data.length < 1000) return out;
  }
}

async function loadMessages(supabase: SupabaseClient<Database>, ids: string[]): Promise<Map<string, BackfillMessage[]>> {
  const byProperty = new Map<string, BackfillMessage[]>();
  for (const part of chunks(ids)) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("messages")
        .select(MESSAGE_SELECT)
        .in("property_id", part)
        .eq("channel", "sms")
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(`load messages: ${error.message}`);
      for (const m of (data ?? []) as BackfillMessage[]) {
        const list = byProperty.get(m.property_id) ?? [];
        list.push(m);
        byProperty.set(m.property_id, list);
      }
      if (!data || data.length < 1000) break;
    }
  }
  return byProperty;
}

/**
 * Fresh facts for one lead, every lookup re-read. Throws on any read error
 * (callers treat a throw as "do not send").
 */
export async function loadLeadFacts(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  o: { excluded: boolean; window: BackfillFacts["window"]; statuses: readonly string[]; ignoreMessageId?: string | null },
): Promise<{ facts: BackfillFacts; ourLastTextBefore: string | null }> {
  const { data: property, error: propertyError } = await supabase.from("properties").select(PROPERTY_SELECT).eq("id", propertyId).maybeSingle();
  if (propertyError || !property) throw new Error(`property lookup: ${propertyError?.message ?? "not found"}`);
  const messages = await loadMessages(supabase, [propertyId]);
  const thread = summarizeThread(messages.get(propertyId) ?? [], o.ignoreMessageId ?? null);
  const inbound = thread.latestInbound;
  const orgId = (property as BackfillProperty).org_id;
  let outboundSinceInbound = thread.outboundSinceInbound;
  let approvedTextBefore = thread.approvedTextBefore;
  let newerInboundElsewhere = false;
  let callSinceInbound = false;
  let contact: BackfillContact | null = null;
  let consentState: string | null = null;
  let phoneSuppressed = false;
  if (inbound) {
    const phone = normalizePhone(inbound.from_address);
    const { data: calls, error: callError } = await supabase
      .from("call_activities")
      .select("id")
      .eq("property_id", propertyId)
      .gt("created_at", inbound.created_at)
      .limit(1);
    if (callError) throw new Error(`call lookup: ${callError.message}`);
    callSinceInbound = (calls ?? []).length > 0;
    if (phone) {
      // The same seller on any other property in the org.
      const [toPhone, fromPhone, phoneCalls] = await Promise.all([
        supabase.from("messages").select(MESSAGE_SELECT).eq("org_id", orgId).eq("channel", "sms").eq("direction", "outbound").eq("to_address", phone),
        supabase.from("messages").select(MESSAGE_SELECT).eq("org_id", orgId).eq("channel", "sms").eq("direction", "inbound").eq("from_address", phone),
        supabase.from("call_activities").select("id").eq("org_id", orgId).eq("phone_e164", phone).gt("created_at", inbound.created_at).limit(1),
      ]);
      if (toPhone.error || fromPhone.error || phoneCalls.error) {
        throw new Error(`phone history lookup: ${(toPhone.error ?? fromPhone.error ?? phoneCalls.error)!.message}`);
      }
      const sentToPhone = ((toPhone.data ?? []) as BackfillMessage[]).filter((m) => m.id !== o.ignoreMessageId);
      outboundSinceInbound ||= sentToPhone.some((m) => outboundCountsAfter(m, inbound.created_at));
      approvedTextBefore ||= sentToPhone.some((m) => m.body === ASKED_OFFER_BACKFILL_BODY);
      newerInboundElsewhere = ((fromPhone.data ?? []) as BackfillMessage[]).some(
        (m) => m.property_id !== propertyId && m.created_at > inbound.created_at,
      );
      callSinceInbound ||= (phoneCalls.data ?? []).length > 0;
    }
    if (inbound.contact_id) {
      const { data, error } = await supabase.from("contacts").select("id, do_not_contact, sms_opted_out").eq("id", inbound.contact_id).maybeSingle();
      if (error) throw new Error(`contact lookup: ${error.message}`);
      contact = (data as BackfillContact | null) ?? null;
      const consent = await getConsentStateStrict(supabase, inbound.contact_id, "sms");
      consentState = consent.ok ? consent.state : null;
    }
    phoneSuppressed = await isSmsPhoneSuppressed(supabase, inbound.from_address, orgId);
  }
  return {
    facts: {
      property: property as BackfillProperty,
      latestInbound: inbound,
      outboundSinceInbound,
      newerInboundElsewhere,
      statusInScope: o.statuses.includes((property as BackfillProperty).status),
      approvedTextBefore,
      callSinceInbound,
      contact,
      consentState,
      phoneSuppressed,
      excluded: o.excluded,
      window: o.window,
    },
    ourLastTextBefore: thread.ourLastTextBefore,
  };
}

function addressOf(p: BackfillProperty): string {
  return [p.address, p.city].filter(Boolean).join(", ") || p.id;
}

/**
 * Dry run (apply=false) reads the database and calls Jev, and writes nothing.
 * Apply sends to each target immediately, re-checking everything at the
 * provider boundary (see the module comment).
 */
export async function runAskedOfferBackfill(
  supabase: SupabaseClient<Database>,
  o: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillRow[]> {
  const window = { since: o.since, before: o.before };
  const properties = await loadProperties(supabase, o);
  const messages = await loadMessages(supabase, properties.map((p) => p.id));
  const rows: BackfillRow[] = [];
  for (const property of properties) {
    const scan = summarizeThread(messages.get(property.id) ?? []);
    const excluded = o.excludePropertyIds.has(property.id);
    const cheap = threadSkipReason({ latestInbound: scan.latestInbound, outboundSinceInbound: scan.outboundSinceInbound, excluded, window });
    // Leads with nothing waiting are not reported row by row (most of the list).
    if (cheap === "no_inbound" || cheap === "inbound_outside_window" || cheap === "texted_since") continue;
    const { facts, ourLastTextBefore } = await loadLeadFacts(supabase, property.id, { excluded, window, statuses: o.statuses });
    const inbound = facts.latestInbound;
    const base = {
      propertyId: property.id,
      address: addressOf(facts.property),
      sellerText: inbound?.body ?? null,
      inboundAt: inbound?.created_at ?? null,
      inboundMessageId: inbound?.id ?? null,
      answer: null,
      askedOfferProbability: null,
      classifyError: null,
      target: false,
    };
    const skip = backfillSkipReason(facts);
    if (skip) {
      rows.push({ ...base, skip });
      continue;
    }
    let result: NineQuestionResult;
    try {
      result = await deps.classify({ our_last_text_to_homeowner: ourLastTextBefore, homeowner_reply: inbound!.body ?? "" });
    } catch (e) {
      rows.push({ ...base, skip: null, classifyError: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const row: BackfillRow = {
      ...base,
      skip: null,
      answer: result.answer,
      askedOfferProbability: result.probabilities.asked_offer,
      target: result.answer === "asked_offer",
    };
    if (row.target && o.apply) {
      row.sent = await sendOne(supabase, facts.property, inbound!, result, { excluded, window, statuses: o.statuses }, deps.now);
    }
    rows.push(row);
  }
  return rows;
}

async function sendOne(
  supabase: SupabaseClient<Database>,
  property: BackfillProperty,
  inbound: BackfillMessage,
  result: NineQuestionResult,
  factOptions: { excluded: boolean; window: BackfillFacts["window"]; statuses: readonly string[] },
  now: () => Date,
): Promise<BackfillSendResult> {
  if (!chicagoWindowOpen(now())) return { status: "window_closed" };
  const phone = normalizePhone(inbound.from_address);
  if (!phone) return { status: "blocked_no_phone", detail: "inbound number does not normalize" };
  const lastLook = async (ctx?: { messageId: string }): Promise<boolean> => {
    if (!ctx?.messageId || !chicagoWindowOpen(now())) return false;
    try {
      const { facts } = await loadLeadFacts(supabase, property.id, { ...factOptions, ignoreMessageId: ctx.messageId });
      const ok = facts.latestInbound?.id === inbound.id && backfillSkipReason(facts) === null;
      // The reads above take time: the window must still be open as permission is given.
      return ok && chicagoWindowOpen(now());
    } catch {
      return false;
    }
  };
  const outcome: SendSmsOutcome = await sendSmsToContact(supabase, {
    origin: "automated",
    contactId: inbound.contact_id!,
    propertyId: property.id,
    body: ASKED_OFFER_BACKFILL_BODY,
    // The number the seller texted from, from the number they texted (fails closed if unsaved).
    to: inbound.from_address!,
    requireStickyFrom: true,
    idempotencyKey: idempotencyKeyFor(property.org_id, phone),
    beforeProviderSubmit: lastLook,
    metadata: {
      kind: ASKED_OFFER_BACKFILL_KIND,
      replyKind: "nine_hot_reply",
      reply: "asked_offer",
      sourceInboundMessageId: inbound.id,
      classifier: { answer: result.answer, chosen: result.chosen, model: result.model },
    } as Json,
  });
  const detail = "reason" in outcome ? String(outcome.reason) : "error" in outcome ? String(outcome.error) : undefined;
  return {
    status: outcome.status,
    ...("messageId" in outcome && outcome.messageId ? { messageId: outcome.messageId } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Production classifier: the same single Jev call the live nine-question engine makes. */
export function liveClassifier(apiKey: string): BackfillDeps["classify"] {
  return (state) => classifyNineQuestions(state, { fetch, apiKey });
}
