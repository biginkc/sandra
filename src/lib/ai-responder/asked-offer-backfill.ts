import type { SupabaseClient } from "@supabase/supabase-js";

import { getConsentState } from "@/lib/messaging/consent";
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
 * lead's latest inbound, and only when that answer is `asked_offer` queues
 * Jarrad's approved text (NINE_HOT_REPLY_TEXTS.asked_offer, used byte for byte)
 * through the normal outbox. The outbox drain (sequence-tick) re-checks consent,
 * opt-out, suppression, human-owned dispositions and quiet hours at release and
 * sends through the configured provider.
 *
 * Idempotent: the queued row is an outbound after the inbound, so a second run
 * finds "we texted since" and skips. The row also carries `kind` + the source
 * inbound id for audit.
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
  needs_human_attention: boolean | null;
  assigned_user_id: string | null;
};

export type BackfillContact = {
  id: string;
  do_not_contact: boolean | null;
  sms_opted_out: boolean | null;
};

/** Everything the skip rule needs, gathered read-only. */
export type BackfillFacts = {
  property: BackfillProperty;
  latestInbound: BackfillMessage | null;
  /** Any outbound row (any status: queued, pending, sent, failed) after the latest inbound. */
  outboundSinceInbound: boolean;
  /** Any call logged after the latest inbound. */
  callSinceInbound: boolean;
  contact: BackfillContact | null;
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
  | "called_since"
  | "no_contact"
  | "dnc"
  | "opted_out"
  | "phone_suppressed"
  | "terminal_disposition"
  | "ai_responder_disabled";

/** Dispositions that still mean "nobody has decided this lead yet". */
const OPEN_DISPOS: ReadonlySet<string> = new Set(["needs_sequence"]);

/**
 * Pure skip rule, checked before any Jev call. Order is report order only:
 * any one reason skips the lead.
 */
export function backfillSkipReason(f: BackfillFacts): BackfillSkipReason | null {
  const thread = threadSkipReason(f);
  if (thread) return thread;
  if (f.callSinceInbound) return "called_since";
  if (!f.contact || !f.latestInbound?.contact_id) return "no_contact";
  if (f.contact.do_not_contact) return "dnc";
  if (f.contact.sms_opted_out || f.consentState === "opted_out") return "opted_out";
  if (f.phoneSuppressed) return "phone_suppressed";
  if (f.property.is_dnc_locked) return "dnc";
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

/** The latest inbound per property and whether anything outbound followed it. */
export function summarizeThread(messages: BackfillMessage[]): {
  latestInbound: BackfillMessage | null;
  outboundSinceInbound: boolean;
  ourLastTextBefore: string | null;
} {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let latestInbound: BackfillMessage | null = null;
  for (const m of sorted) if (m.direction === "inbound") latestInbound = m;
  if (!latestInbound) return { latestInbound: null, outboundSinceInbound: false, ourLastTextBefore: null };
  const inboundAt = latestInbound.created_at;
  const outboundSinceInbound = sorted.some((m) => m.direction === "outbound" && m.created_at > inboundAt);
  const before = sorted.filter((m) => m.direction === "outbound" && m.created_at < inboundAt && m.body);
  return { latestInbound, outboundSinceInbound, ourLastTextBefore: before.length ? before[before.length - 1]!.body : null };
}

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
  /** Apply only: the send path's outcome (`queued` on success), or `texted_since_recheck`. */
  queued?: { status: SendSmsOutcome["status"] | "texted_since_recheck"; messageId?: string; detail?: string };
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
      .select("id, org_id, address, city, state, status, outreach_dispo, ai_responder_disabled, is_dnc_locked, needs_human_attention, assigned_user_id")
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
        .select("id, property_id, contact_id, conversation_id, direction, status, body, from_address, to_address, created_at")
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

/** Fresh read for one property right before queueing: anything outbound after the inbound? */
async function outboundSince(supabase: SupabaseClient<Database>, propertyId: string, inboundAt: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .gt("created_at", inboundAt)
    .limit(1);
  if (error) throw new Error(`outbound re-check: ${error.message}`);
  return (data ?? []).length > 0;
}

async function callSince(supabase: SupabaseClient<Database>, propertyId: string, inboundAt: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("call_activities")
    .select("id")
    .eq("property_id", propertyId)
    .gt("created_at", inboundAt)
    .limit(1);
  if (error) throw new Error(`call lookup: ${error.message}`);
  return (data ?? []).length > 0;
}

function addressOf(p: BackfillProperty): string {
  return [p.address, p.city].filter(Boolean).join(", ") || p.id;
}

/**
 * Dry run (apply=false) is read-only: it reads the database and calls Jev, and
 * writes nothing. Apply re-reads "texted since" for each target right before
 * queueing the approved text.
 */
export async function runAskedOfferBackfill(
  supabase: SupabaseClient<Database>,
  o: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillRow[]> {
  const properties = await loadProperties(supabase, o);
  const messages = await loadMessages(supabase, properties.map((p) => p.id));
  const rows: BackfillRow[] = [];
  for (const property of properties) {
    const thread = summarizeThread(messages.get(property.id) ?? []);
    const inbound = thread.latestInbound;
    const base = {
      propertyId: property.id,
      address: addressOf(property),
      sellerText: inbound?.body ?? null,
      inboundAt: inbound?.created_at ?? null,
      inboundMessageId: inbound?.id ?? null,
      answer: null,
      askedOfferProbability: null,
      classifyError: null,
      target: false,
    };
    const cheap = threadSkipReason({
      latestInbound: inbound,
      outboundSinceInbound: thread.outboundSinceInbound,
      excluded: o.excludePropertyIds.has(property.id),
      window: { since: o.since, before: o.before },
    });
    // Leads with nothing waiting are not reported row by row (most of the list).
    if (cheap === "no_inbound" || cheap === "inbound_outside_window" || cheap === "texted_since") continue;
    if (cheap) {
      rows.push({ ...base, skip: cheap });
      continue;
    }
    const contactId = inbound!.contact_id;
    const { data: contact } = contactId
      ? await supabase.from("contacts").select("id, do_not_contact, sms_opted_out").eq("id", contactId).maybeSingle()
      : { data: null };
    const skip = backfillSkipReason({
      property,
      latestInbound: inbound,
      outboundSinceInbound: thread.outboundSinceInbound,
      callSinceInbound: await callSince(supabase, property.id, inbound!.created_at),
      contact: (contact as BackfillContact | null) ?? null,
      consentState: contactId ? await getConsentState(supabase, contactId, "sms") : null,
      phoneSuppressed: await isSmsPhoneSuppressed(supabase, inbound!.from_address, property.org_id),
      excluded: false,
      window: { since: o.since, before: o.before },
    });
    if (skip) {
      rows.push({ ...base, skip });
      continue;
    }
    let result: NineQuestionResult;
    try {
      result = await deps.classify({ our_last_text_to_homeowner: thread.ourLastTextBefore, homeowner_reply: inbound!.body ?? "" });
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
    if (row.target && o.apply) row.queued = await queueOne(supabase, property, inbound!, result, deps.now());
    rows.push(row);
  }
  return rows;
}

async function queueOne(
  supabase: SupabaseClient<Database>,
  property: BackfillProperty,
  inbound: BackfillMessage,
  result: NineQuestionResult,
  now: Date,
): Promise<NonNullable<BackfillRow["queued"]>> {
  // Re-read right before writing: a person (or a parallel run) may have texted since the scan.
  if (await outboundSince(supabase, property.id, inbound.created_at)) return { status: "texted_since_recheck" };
  const outcome: SendSmsOutcome = await sendSmsToContact(supabase, {
    origin: "automated",
    contactId: inbound.contact_id!,
    propertyId: property.id,
    body: ASKED_OFFER_BACKFILL_BODY,
    // Reply to the number the seller texted from, from the number they texted.
    to: inbound.from_address ?? undefined,
    requireStickyFrom: true,
    queueOnly: true,
    scheduledFor: now,
    metadata: {
      kind: ASKED_OFFER_BACKFILL_KIND,
      replyKind: "nine_hot_reply",
      reply: "asked_offer",
      sourceInboundMessageId: inbound.id,
      classifier: { answer: result.answer, chosen: result.chosen, model: result.model },
    } as Json,
  });
  const detail = "reason" in outcome ? String(outcome.reason) : "error" in outcome ? String(outcome.error) : undefined;
  return { status: outcome.status, ...("messageId" in outcome && outcome.messageId ? { messageId: outcome.messageId } : {}), ...(detail ? { detail } : {}) };
}

/** Production classifier: the same single Jev call the live nine-question engine makes. */
export function liveClassifier(apiKey: string): BackfillDeps["classify"] {
  return (state) => classifyNineQuestions(state, { fetch, apiKey });
}
