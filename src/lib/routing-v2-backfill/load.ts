/**
 * Routing v2 backfill: read-only loaders that turn the database into SelectionFacts.
 * Every read is error-checked: an unreadable fact aborts the run (never a silent "no").
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { readClassifierEngine } from "@/lib/ai-responder/nine-questions-engine";
import { getConsentStateStrict } from "@/lib/messaging/consent";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import { shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import { isV2Eligible, readRoutingV2FlagsResult, type RoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import type { Database } from "@/lib/supabase/types";

import type { BackfillMarker, ContactFacts, InboundRow, LatestOutbound, PropertyFacts, SelectionFacts } from "./select";

type Db = SupabaseClient<Database>;
// The new routing v2 tables are not in the generated types yet (same pattern as dispatch.ts).
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const PAGE = 1000;
const BATCH = 150;
/** An outbound in one of these statuses answered the seller (the send gate's evidence statuses). */
const ANSWERING_STATUSES = ["pending", "queued", "sent", "delivered"];
const AUTOMATED_GENERATORS = new Set(["ai_responder_v1", "sequence_tick", "norma_precall"]);

function chunks<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fail(what: string, error: { message: string } | null | undefined): never {
  throw new Error(`routing v2 backfill: could not read ${what}: ${error?.message ?? "no data"}`);
}

export type OrgV2State = {
  flags: RoutingV2Flags;
  /** Active config is Jev automatic + nine_questions engine (what routingV2LiveForSweep requires). */
  engineOk: boolean;
};

/** The org-level half of routingV2LiveForSweep, read once (the per-property half is isV2Eligible). */
export async function readOrgV2State(db: Db, orgId: string): Promise<OrgV2State> {
  const flags = await readRoutingV2FlagsResult(db, orgId);
  if (!flags.ok) throw new Error("routing v2 backfill: routing_v2_flags unreadable");
  const { data: config, error } = await db.from("ai_responder_configs")
    .select("classifier_provider, classifier_mode").eq("org_id", orgId).eq("active", true).maybeSingle();
  if (error) fail("ai_responder_configs", error);
  let engineOk = config?.classifier_provider === "jev" && config.classifier_mode === "automatic";
  if (engineOk) {
    const engine = await readClassifierEngine(db, orgId);
    if (engine === "unreadable") throw new Error("routing v2 backfill: classifier engine unreadable");
    engineOk = engine === "nine_questions";
  }
  return { flags: flags.flags, engineOk };
}

export function propertyV2Live(state: OrgV2State, propertyId: string): boolean {
  return state.engineOk && state.flags.questions_live && isV2Eligible(state.flags, propertyId);
}

type RawInbound = {
  id: string; property_id: string; contact_id: string | null; conversation_id: string | null;
  created_at: string; from_address: string | null; keyword: string | null; backfill: BackfillMarker | null; ai_outcome: string | null;
};

export async function loadInbounds(db: Db, orgId: string, sinceIso: string, nowMs: number = Date.now()): Promise<Array<InboundRow & { orgId: string }>> {
  const rows: RawInbound[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("messages")
      .select("id, property_id, contact_id, conversation_id, created_at, from_address, keyword:metadata->>keyword, backfill:metadata->routingV2Backfill, ai_outcome:metadata->processing->aiResponder->>outcome")
      .eq("org_id", orgId).eq("direction", "inbound").eq("channel", "sms")
      .not("property_id", "is", null).gte("created_at", sinceIso)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) fail("inbound messages", error);
    rows.push(...((data ?? []) as unknown as RawInbound[]));
    if ((data ?? []).length < PAGE) break;
  }
  const decided = new Set<string>();
  for (const ids of chunks(rows.map((r) => r.id))) {
    const { data, error } = await (db as unknown as Loose).from("routing_v2_live_decisions")
      .select("inbound_message_id").in("inbound_message_id", ids);
    if (error) fail("routing_v2_live_decisions", error);
    for (const d of (data ?? []) as Array<{ inbound_message_id: string }>) decided.add(d.inbound_message_id);
  }
  return rows.map((r) => ({
    id: r.id, orgId, propertyId: r.property_id, contactId: r.contact_id, conversationId: r.conversation_id,
    createdAt: r.created_at, fromAddress: r.from_address, webhookKeyword: r.keyword ?? null,
    marker: r.backfill && typeof r.backfill === "object" ? r.backfill : null,
    hasLiveDecision: decided.has(r.id),
    // 'delayed' = the webhook scheduled the live reply workflow; inside a day the live path (or
    // its sweep) still owns it. Older than that the workflow is long dead.
    livePending: r.ai_outcome === "delayed" && Date.parse(r.created_at) > nowMs - 86_400_000,
  }));
}

export async function loadPropertyFacts(db: Db, propertyIds: readonly string[], state: OrgV2State): Promise<Map<string, PropertyFacts>> {
  const out = new Map<string, PropertyFacts>();
  for (const ids of chunks(propertyIds)) {
    const { data, error } = await (db as unknown as Loose).from("properties")
      .select("id, needs_human_attention, outreach_dispo, is_dnc_locked, ai_responder_disabled, test_run_id, last_person_takeover_at")
      .in("id", ids);
    if (error) fail("properties", error);
    for (const p of (data ?? []) as Array<Record<string, unknown>>) {
      const id = p.id as string;
      out.set(id, {
        id,
        needsHumanAttention: p.needs_human_attention === true,
        terminalDisposition: shouldSuppressAutomatedSend({ outreachDispo: (p.outreach_dispo ?? null) as never }),
        isDncLocked: p.is_dnc_locked === true,
        aiResponderDisabled: p.ai_responder_disabled === true,
        testRunId: (p.test_run_id as string | null) ?? null,
        lastPersonTakeoverAt: (p.last_person_takeover_at as string | null) ?? null,
        v2Live: propertyV2Live(state, id),
      });
    }
  }
  return out;
}

/**
 * Newest answering outbound per property at or after `sinceIso` (only properties' newest inbound
 * matters, so the caller passes the window start). Human = not a campaign, drip, AI or reminder row.
 */
export async function loadLatestOutbound(db: Db, propertyIds: readonly string[], sinceIso: string): Promise<Map<string, LatestOutbound>> {
  const out = new Map<string, LatestOutbound>();
  for (const ids of chunks(propertyIds, 50)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from("messages")
        .select("property_id, created_at, sent_at, campaign_id, generated_by:metadata->>generated_by, kind:metadata->>kind")
        .in("property_id", ids).eq("direction", "outbound").in("status", ANSWERING_STATUSES).gte("created_at", sinceIso)
        .order("created_at", { ascending: false }).range(from, from + PAGE - 1);
      if (error) fail("outbound messages", error);
      for (const m of (data ?? []) as unknown as Array<{ property_id: string; created_at: string; sent_at: string | null; campaign_id: string | null; generated_by: string | null; kind: string | null }>) {
        const at = m.sent_at && Date.parse(m.sent_at) > Date.parse(m.created_at) ? m.sent_at : m.created_at;
        const human = !m.campaign_id && !m.kind && !(m.generated_by && AUTOMATED_GENERATORS.has(m.generated_by));
        const prev = out.get(m.property_id) ?? { at: at, humanAt: null };
        const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
        out.set(m.property_id, { at: later(prev.at, at)!, humanAt: human ? later(prev.humanAt, at) : prev.humanAt });
      }
      if ((data ?? []).length < PAGE) break;
    }
  }
  return out;
}

export async function loadContactFacts(db: Db, contactIds: readonly string[]): Promise<Map<string, ContactFacts>> {
  const out = new Map<string, ContactFacts>();
  for (const ids of chunks(contactIds)) {
    const { data, error } = await db.from("contacts").select("id, do_not_contact, sms_opted_out").in("id", ids);
    if (error) fail("contacts", error);
    for (const c of data ?? []) {
      out.set(c.id, { doNotContact: c.do_not_contact === true, smsOptedOut: c.sms_opted_out === true, consentOptedOut: false });
    }
  }
  for (const id of contactIds) {
    const consent = await getConsentStateStrict(db, id, "sms");
    if (!consent.ok) throw new Error(`routing v2 backfill: consent unreadable: ${consent.error}`);
    const c = out.get(id);
    if (c && consent.state === "opted_out") c.consentOptedOut = true;
  }
  return out;
}

export async function loadSuppressedInboundIds(db: Db, orgId: string, rows: ReadonlyArray<{ id: string; fromAddress: string | null }>): Promise<Set<string>> {
  const out = new Set<string>();
  const byPhone = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.fromAddress) continue;
    let s = byPhone.get(r.fromAddress);
    if (s === undefined) {
      s = await isSmsPhoneSuppressed(db, r.fromAddress, orgId);
      byPhone.set(r.fromAddress, s);
    }
    if (s) out.add(r.id);
  }
  return out;
}

/**
 * All facts for one org. Expensive per-contact / per-phone reads are done only for each
 * property's NEWEST text (the only one that can become a candidate).
 */
export async function loadSelectionFacts(
  db: Db,
  orgId: string,
  sinceIso: string,
  nowMs: number = Date.now(),
): Promise<{ facts: SelectionFacts; state: OrgV2State }> {
  const state = await readOrgV2State(db, orgId);
  const inbounds = await loadInbounds(db, orgId, sinceIso, nowMs);
  const newest = new Map<string, InboundRow>();
  for (const r of inbounds) {
    const prev = newest.get(r.propertyId);
    if (!prev || Date.parse(r.createdAt) > Date.parse(prev.createdAt) || (r.createdAt === prev.createdAt && r.id > prev.id)) newest.set(r.propertyId, r);
  }
  const propertyIds = [...newest.keys()];
  const heads = [...newest.values()];
  const [properties, latestOutbound] = [await loadPropertyFacts(db, propertyIds, state), await loadLatestOutbound(db, propertyIds, sinceIso)];
  const contactIds = [...new Set(heads.map((h) => h.contactId).filter((c): c is string => !!c))];
  const contacts = await loadContactFacts(db, contactIds);
  const suppressedInboundIds = await loadSuppressedInboundIds(db, orgId, heads);
  return { facts: { inbounds, properties, latestOutbound, contacts, suppressedInboundIds }, state };
}
