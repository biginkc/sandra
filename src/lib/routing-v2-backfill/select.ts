/**
 * Routing v2 backfill: candidate selection (pure, no database).
 *
 * Input = every inbound seller SMS for one org inside the window, plus per-property facts read
 * by ./load. Output = one candidate per property (its NEWEST unanswered seller text), the older
 * texts it supersedes, and every skip with its reason. The rules are Jarrad's (2026-10-31):
 * - newest seller text per property wins; older unanswered texts are `backfill_superseded`;
 * - out of scope: any outbound on the property after the newest text (answered);
 * - skipped: needs a person already, terminal disposition, suppressed / DNC / opted out phone or
 *   contact, test-tagged rows, a person took over after the text, v2 not live for the property,
 *   a webhook keyword exit, and anything a previous backfill run (or the live engine) already
 *   routed (idempotence / --resume).
 */

export const AGE_BUCKETS = ["0-7d", "8-14d", "15-30d", "31-60d", "61d+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

const DAY_MS = 86_400_000;

export function ageDays(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

/** 0–7d, 8–14d, 15–30d, 31–60d by whole days elapsed (day 7.5 is still "0-7d"). */
export function ageBucket(days: number): AgeBucket {
  const d = Math.floor(days);
  if (d <= 7) return "0-7d";
  if (d <= 14) return "8-14d";
  if (d <= 30) return "15-30d";
  if (d <= 60) return "31-60d";
  return "61d+";
}

/** What a previous backfill run left on the inbound (messages.metadata.routingV2Backfill). */
export type BackfillMarker = {
  /** `decision`: the decision row classify-only built (never written to routing_v2_live_decisions). */
  classify?: { runId: string; at: string; outcome?: string; treatment?: string; priorClaimId?: string; decision?: Record<string, unknown> };
  apply?: { runId: string; at: string; outcome?: string; treatment?: string; priorClaimId?: string };
  superseded?: { runId: string; at: string; byInboundId: string };
  skipped?: { runId: string; at: string; reason: string };
  /** Written just before an apply dispatch: a decision row with this and no `apply` is an interrupted backfill apply (resumable). */
  applyStarted?: { runId: string; at: string };
};

export type InboundRow = {
  id: string;
  propertyId: string;
  contactId: string | null;
  conversationId: string | null;
  createdAt: string;
  fromAddress: string | null;
  /** messages.metadata.keyword: the webhook already handled it (STOP, HELP...). */
  webhookKeyword: string | null;
  marker: BackfillMarker | null;
  /** A routing_v2_live_decisions row exists for this inbound. */
  hasLiveDecision: boolean;
  /** The webhook scheduled the delayed live reply (aiResponder stamp 'delayed') and it is still live-owned (< 24 h). */
  livePending?: boolean;
};

export type PropertyFacts = {
  id: string;
  needsHumanAttention: boolean;
  /** shouldSuppressAutomatedSend(outreach_dispo) (nurture / callback / booked / closed...). */
  terminalDisposition: boolean;
  isDncLocked: boolean;
  aiResponderDisabled: boolean;
  testRunId: string | null;
  lastPersonTakeoverAt: string | null;
  /** routingV2LiveForSweep(org, property) === "yes" (flags + canary + Jev automatic nine questions). */
  v2Live: boolean;
};

export type ContactFacts = { doNotContact: boolean; smsOptedOut: boolean; consentOptedOut: boolean };

/** Newest answering outbound per property, and the newest one a person sent. */
export type LatestOutbound = { at: string; humanAt: string | null };

export type SelectionFacts = {
  inbounds: ReadonlyArray<InboundRow>;
  properties: ReadonlyMap<string, PropertyFacts>;
  /** Newest outbound per property inside the window (any author). */
  latestOutbound: ReadonlyMap<string, LatestOutbound>;
  contacts: ReadonlyMap<string, ContactFacts>;
  /** Inbound ids whose seller phone is in sms_phone_suppressions. */
  suppressedInboundIds: ReadonlySet<string>;
};

export type SkipReason =
  | "answered_by_human"
  | "answered_by_automation"
  | "needs_human_attention"
  | "terminal_disposition"
  | "dnc_locked"
  | "phone_suppressed"
  | "contact_do_not_contact"
  | "opted_out"
  | "test_tagged"
  | "human_takeover_after_inbound"
  | "ai_responder_disabled"
  | "v2_not_live"
  | "webhook_keyword"
  | "no_contact"
  | "property_missing"
  | "already_backfilled"
  | "already_routed_live"
  | "live_pending"
  | "outside_window";

export const SKIP_REASONS: ReadonlyArray<SkipReason> = [
  "answered_by_human", "answered_by_automation", "needs_human_attention", "terminal_disposition", "dnc_locked",
  "phone_suppressed", "contact_do_not_contact", "opted_out", "test_tagged", "human_takeover_after_inbound",
  "ai_responder_disabled", "v2_not_live", "webhook_keyword", "no_contact", "property_missing",
  "already_backfilled", "already_routed_live", "live_pending", "outside_window",
];

export type Candidate = InboundRow & { ageDays: number; bucket: AgeBucket; supersedes: string[] };
export type Skip = { inboundId: string; propertyId: string; ageDays: number; bucket: AgeBucket; reason: SkipReason };
export type Superseded = { inboundId: string; propertyId: string; byInboundId: string; ageDays: number; bucket: AgeBucket };

export type Selection = { candidates: Candidate[]; superseded: Superseded[]; skipped: Skip[] };

export type SelectionMode = "dry_run" | "classify_only" | "apply";

/**
 * Has a previous run already handled this inbound for `mode`?
 * - apply never re-routes a text any backfill APPLY run routed or superseded;
 * - classify-only never re-classifies a text any backfill run classified, applied or superseded;
 * - dry-run counts everything a real run would still pick (same rule as apply).
 * A classify-only decision does NOT block apply: apply carries out that stored decision.
 */
export function alreadyBackfilled(marker: BackfillMarker | null, mode: SelectionMode): boolean {
  if (!marker) return false;
  if (marker.apply || marker.superseded) return true;
  return mode === "classify_only" && !!marker.classify;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

export function selectCandidates(
  facts: SelectionFacts,
  opts: { nowMs: number; maxAgeDays: number; mode: SelectionMode },
): Selection {
  const out: Selection = { candidates: [], superseded: [], skipped: [] };
  const byProperty = new Map<string, InboundRow[]>();
  for (const row of facts.inbounds) {
    const list = byProperty.get(row.propertyId) ?? [];
    list.push(row);
    byProperty.set(row.propertyId, list);
  }
  // Deterministic: properties in id order, texts newest first (ties broken by id).
  for (const propertyId of [...byProperty.keys()].sort()) {
    const rows = byProperty.get(propertyId)!.slice().sort((a, b) => {
      const d = ms(b.createdAt) - ms(a.createdAt);
      return d !== 0 ? d : (a.id < b.id ? 1 : -1);
    });
    const inWindow = rows.filter((r) => ageDays(r.createdAt, opts.nowMs) <= opts.maxAgeDays);
    for (const r of rows) {
      if (!inWindow.includes(r)) {
        const days = ageDays(r.createdAt, opts.nowMs);
        out.skipped.push({ inboundId: r.id, propertyId, ageDays: days, bucket: ageBucket(days), reason: "outside_window" });
      }
    }
    if (inWindow.length === 0) continue;
    const newest = inWindow[0];
    const older = inWindow.slice(1);
    const days = ageDays(newest.createdAt, opts.nowMs);
    const bucket = ageBucket(days);
    const reason = skipReasonFor(newest, facts, opts.mode);
    if (reason) {
      out.skipped.push({ inboundId: newest.id, propertyId, ageDays: days, bucket, reason });
      continue;
    }
    // Newest wins: older unanswered texts on this property are superseded (never routed), unless
    // an earlier run already marked them.
    const supersedes: string[] = [];
    for (const o of older) {
      if (o.marker?.superseded || o.marker?.apply) continue;
      const od = ageDays(o.createdAt, opts.nowMs);
      out.superseded.push({ inboundId: o.id, propertyId, byInboundId: newest.id, ageDays: od, bucket: ageBucket(od) });
      supersedes.push(o.id);
    }
    out.candidates.push({ ...newest, ageDays: days, bucket, supersedes });
  }
  return out;
}

/** First matching skip rule for a property's newest text, or null = candidate. Order is the report order. */
export function skipReasonFor(row: InboundRow, facts: SelectionFacts, mode: SelectionMode): SkipReason | null {
  if (alreadyBackfilled(row.marker, mode)) return "already_backfilled";
  // A live (or flag-on) v2 decision that no backfill classify-only run wrote: the engine owns it.
  // An interrupted backfill apply (applyStarted, no apply) is resumable, not "routed live".
  const interrupted = row.hasLiveDecision && !!row.marker?.applyStarted && !row.marker?.apply;
  if (row.hasLiveDecision && !row.marker?.classify && !row.marker?.applyStarted) return "already_routed_live";
  // The delayed live workflow still owns this text: never touched (Astra review 2b-1).
  if (row.livePending && !interrupted) return "live_pending";
  const latest = facts.latestOutbound.get(row.propertyId);
  if (latest && ms(latest.humanAt) > ms(row.createdAt)) return "answered_by_human";
  if (latest && ms(latest.at) > ms(row.createdAt)) return "answered_by_automation";
  const p = facts.properties.get(row.propertyId);
  if (!p) return "property_missing";
  if (p.testRunId) return "test_tagged";
  if (!row.contactId) return "no_contact";
  if (p.lastPersonTakeoverAt && ms(p.lastPersonTakeoverAt) >= ms(row.createdAt)) return "human_takeover_after_inbound";
  // An interrupted apply's own safety hold is not a reason to abandon it (Astra review 2b-3): the
  // dispatch finishes that decision only if the hold is the one written for this text.
  if (p.needsHumanAttention && !interrupted) return "needs_human_attention";
  if (p.isDncLocked) return "dnc_locked";
  if (facts.suppressedInboundIds.has(row.id)) return "phone_suppressed";
  const c = facts.contacts.get(row.contactId);
  if (c?.doNotContact) return "contact_do_not_contact";
  if (c?.smsOptedOut || c?.consentOptedOut) return "opted_out";
  if (p.terminalDisposition) return "terminal_disposition";
  if (p.aiResponderDisabled) return "ai_responder_disabled";
  if (row.webhookKeyword) return "webhook_keyword";
  if (!p.v2Live) return "v2_not_live";
  return null;
}
