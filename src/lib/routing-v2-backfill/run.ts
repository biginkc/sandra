/**
 * Routing v2 backfill runner. Re-dispatches each selected OLD seller text through the same entry
 * the delay workflow uses (dispatchAiResponse, checkSuperseded: true), so the decision row, the
 * outbox, enrollments, holds, takeover fences and the send guard behave exactly as live.
 *
 * Modes
 * - dry_run (default): reads only. Counts the candidate set; writes nothing to the database.
 * - classify_only: Jev / Haiku + the routing decision are recorded (routing_v2_live_decisions,
 *   spend ledger); the dispatch stops before the transition, so nothing is sent, enrolled,
 *   alerted or held. Texts that would hit the up-front keyword hold are NOT dispatched
 *   (that hold is a side effect) and are reported as `keyword_hold`.
 * - apply: the full live treatment. A text classify-only already decided is carried out from
 *   that stored decision (no second model call).
 *
 * Every inbound the run touches carries messages.metadata.routingV2Backfill (run id, mode,
 * outcome). Rows the real path writes (decision, transition, outbox, enrollment, claim) are keyed
 * by that inbound id, so `inbound_message_id in (<run's inbound ids>)` finds all of them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  dispatchAiResponse,
  inboundStampOutcomeOf,
  ROUTING_V2_BACKFILL_CLASSIFY_KEYWORD_HOLD,
  ROUTING_V2_BACKFILL_CLASSIFY_ONLY,
  ROUTING_V2_BACKFILL_HOLD_ROADS,
  routingV2SortOnlyKind,
  runRoutingV2OutboxReplies,
  type AiDispatchInput,
  type AiDispatchOutcome,
} from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { hasAllowedPriceSignal, hasNonPriceEscalationPhrase, matchEscalationKeyword } from "@/lib/ai-responder/keywords";
import { isRetryOutcome, type AiRetryOutcome } from "@/lib/ai-responder/retry";
import { normalizePhone } from "@/lib/csv/normalize";
import { recordAiResponderOutcomeForThread } from "@/lib/messages/ai-responder-thread-state";
import { markInboundMessageState } from "@/lib/messaging/inbound-state";
import { recordRoutingV2Audit } from "@/lib/sms-classification/routing-v2/live-dispatch";
import type { Database, Json } from "@/lib/supabase/types";

import { loadSelectionFacts, type OrgV2State } from "./load";
import { selectCandidates, type BackfillMarker, type Candidate, type Selection } from "./select";

type Db = SupabaseClient<Database>;
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type BackfillMode = "dry_run" | "classify_only" | "apply";

export const DEFAULT_MAX_AGE_DAYS = 60;
export const DEFAULT_RATE_PER_MINUTE = 60;
/** Replies at most this many whole days old get the full treatment; older ones are sort-only. */
export const DEFAULT_TEXT_MAX_AGE_DAYS = 14;

export type Treatment = "full" | "sort_only";

/** Jarrad 2026-10-31: <= textMaxAgeDays whole days = full treatment; older = sort only (no reply, no drip). */
export function treatmentFor(ageDays: number, textMaxAgeDays: number): Treatment {
  return Math.floor(ageDays) <= textMaxAgeDays ? "full" : "sort_only";
}
const RESPONSE_KIND = "sms_ai_responder_v1";

export type BackfillOptions = {
  orgId: string;
  mode: BackfillMode;
  runId: string;
  limit?: number;
  maxAgeDays?: number;
  /** Full-treatment cutoff (default 14): older replies in the window are sort-only. */
  textMaxAgeDays?: number;
  /** Classification dispatches started per minute (sends are paced by the outbox itself). */
  ratePerMinute?: number;
  /** Run classify_only / apply with the org's replies or drips flag OFF (logged in the report). */
  forceFlags?: boolean;
  /** Only texts at most this many days old are dispatched (batching: e.g. 14 = newest two weeks first). */
  batchMaxAgeDays?: number;
};

export type BackfillDeps = {
  anthropic: AnthropicLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test seam; defaults to the real dispatch. */
  dispatch?: typeof dispatchAiResponse;
  /**
   * The database clock in ms (ages are measured on it, not on this machine's clock). The CLI
   * reads it from the API's Date header; default = this machine's clock (tests, local).
   */
  dbNowMs?: () => Promise<number>;
};

/** Per-text result row (CSV + report). Never carries a phone number or message text. */
export type ItemResult = {
  inboundId: string;
  propertyId: string;
  ageDays: number;
  bucket: string;
  mode: BackfillMode;
  treatment: Treatment;
  /** Road from the stored decision ("keyword_hold" / "not_dispatched" when none). */
  road: string;
  decisionStatus: string | null;
  outcome: string;
  jevCalls: number;
  haikuCalls: number;
  haikuUsd: number;
  repliesQueued: number;
  repliesSent: number;
  alertsQueued: number;
  dripsStarted: number;
  holdCreated: boolean;
  holdReason: string | null;
  suppressionCreated: boolean;
  /** classify_only: what apply would do, from the stored action steps. */
  wouldReply: boolean;
  wouldDrip: boolean;
  wouldAlert: boolean;
  wouldHold: boolean;
  wouldClose: boolean;
  /** Apply: classify-only reviewed this text under the other group (it crossed the cutoff since). */
  groupChanged: boolean;
  /** Apply: no stored classify-only decision, so it was classified fresh (Jarrad never reviewed it). */
  appliedWithoutStoredDecision: boolean;
  /** An error item whose effects could not be read back: counts are unknown, not zero. */
  effectsUnknown: boolean;
  error: string | null;
};

export type BackfillRunResult = {
  runId: string;
  orgId: string;
  mode: BackfillMode;
  startedAt: string;
  finishedAt: string;
  options: Required<Pick<BackfillOptions, "maxAgeDays" | "ratePerMinute" | "textMaxAgeDays">> & { limit: number | null; forceFlags: boolean; batchMaxAgeDays: number | null };
  flags: Record<string, boolean | number>;
  flagWarnings: string[];
  selection: Selection;
  /** Candidates this run dispatched (after --limit / batch filter), newest first. */
  dispatched: Candidate[];
  items: ItemResult[];
  supersededMarked: number;
  /** Interrupted backfill applies (applyStarted, no apply) in the window, before and after this run. */
  interruptedBefore: number;
  interruptedAfter: number;
};

export class BackfillRefusal extends Error {}

/**
 * Apply needs the backfill recorder (migration 20261031150000). Probe it with an empty row: the
 * function's own "is this the newest text" check finds no such text and returns without writing
 * (the advisory lock on a null key is a no-op). A missing function = PostgREST "function not
 * found" (PGRST202 / 42883). Same answer as to_regprocedure, through the REST client the CLI has.
 */
export async function backfillRecorderPresent(db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> }): Promise<boolean> {
  const { data, error } = await db.rpc("routing_v2_backfill_record_live_decision", { p_row: {}, p_hold_reason: null });
  if (!error) return data === "newer_inbound";
  if (error.code === "PGRST202" || error.code === "42883" || /Could not find the function|does not exist/i.test(error.message)) return false;
  throw new BackfillRefusal("could not check for routing_v2_backfill_record_live_decision");
}

function flagSummary(state: OrgV2State): Record<string, boolean | number> {
  const f = state.flags;
  return {
    engine_jev_automatic_nine_questions: state.engineOk,
    questions_live: f.questions_live, replies: f.replies, drips: f.drips, haiku: f.haiku, price_check: f.price_check,
    alert_on_time_only: f.alert_on_time_only, wrong_number_all: f.wrong_number_all, model_stop_suppression: f.model_stop_suppression,
    canary_percent: f.canaryPercent, canary_property_ids: f.canaryPropertyIds.size,
  };
}

/** Refusals and warnings for a mode that dispatches. dry_run never refuses. */
export function checkFlags(state: OrgV2State, mode: BackfillMode, forceFlags: boolean): { refuse: string | null; warnings: string[] } {
  if (mode === "dry_run") return { refuse: null, warnings: [] };
  // Never forceable: without the v2 engine live the dispatch would run TODAY's engine instead.
  if (!state.engineOk) return { refuse: "org is not on Jev automatic + nine_questions: the dispatch would not use routing v2", warnings: [] };
  if (!state.flags.questions_live) return { refuse: "routing_v2_flags.questions_live is off: the dispatch would not use routing v2", warnings: [] };
  const off = (["replies", "drips"] as const).filter((k) => !state.flags[k]);
  if (off.length === 0) return { refuse: null, warnings: [] };
  if (!forceFlags) return { refuse: `routing_v2_flags ${off.join(" + ")} off (pass --force-flags to run anyway)`, warnings: [] };
  return { refuse: null, warnings: [`--force-flags: ran with ${off.join(" + ")} OFF; those roads hold for a person exactly as live`] };
}

/**
 * The up-front keyword hold the dispatch writes before any classification (dispatch.ts step 2):
 * a non-price escalation phrase on a responder-on property. Conservative: may name a text the
 * real gate would let through; never misses one.
 */
export function keywordHoldLikely(body: string, escalationKeywords: ReadonlyArray<string> | null): boolean {
  const priceOnly = hasAllowedPriceSignal(body, escalationKeywords) && !hasNonPriceEscalationPhrase(body, { allowedPhrases: escalationKeywords ?? undefined });
  return !priceOnly && matchEscalationKeyword(body, { allowedPhrases: escalationKeywords ?? undefined }) !== null;
}

export async function writeMarker(db: Db, messageId: string, patch: Partial<BackfillMarker>): Promise<void> {
  const { data, error } = await db.from("messages").select("metadata").eq("id", messageId).maybeSingle();
  if (error || !data) throw new BackfillItemError("marker_write_failed");
  const meta = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? (data.metadata as Record<string, unknown>) : {};
  const prev = (meta.routingV2Backfill && typeof meta.routingV2Backfill === "object" ? meta.routingV2Backfill : {}) as BackfillMarker;
  const { data: updated, error: upErr } = await db.from("messages")
    .update({ metadata: { ...meta, routingV2Backfill: { ...prev, ...patch } } as Json })
    .eq("id", messageId).select("id").maybeSingle();
  if (upErr || !updated) throw new BackfillItemError("marker_write_failed");
}

/**
 * The legacy engine (or a classify-only run) already completed a claim for this inbound, which
 * would refuse the re-dispatch as `already_replied`. Move that claim aside, unchanged, under a
 * run-specific response_kind (reversible; see docs). Returns the moved claim's id, or null.
 */
export function backfillPriorKind(runId: string, claimId: string): string {
  // The claim's own id makes the name unique per claim row, so one run id can cover
  // classify-only -> apply batches -> --resume without ever colliding (Opus review B3).
  return `${RESPONSE_KIND}:backfill_prior:${runId}:${claimId}`;
}

export type ReopenResult =
  | { kind: "moved"; claimId: string }
  | { kind: "none" }
  /** A claim in an error state (a safety marker such as v2_safety_hold_failed, flag_failed...): never moved; the text is skipped. */
  | { kind: "skip"; reason: "claim_error_state" };

export async function reopenClaim(db: Db, inboundId: string, runId: string, nowMs: number = Date.now()): Promise<ReopenResult> {
  const { data, error } = await db.from("ai_response_claims")
    .select("id, status, lease_expires_at, updated_at").eq("inbound_message_id", inboundId).eq("response_kind", RESPONSE_KIND).maybeSingle();
  if (error) throw new BackfillItemError("claim_read_failed");
  if (!data) return { kind: "none" };
  if (data.status === "processing") {
    // A live lease: someone is dispatching this text right now. An expired one (a crashed run)
    // is reclaimed by the dispatch's own claim step, so it stays where it is.
    if (Date.parse(data.lease_expires_at) > nowMs) throw new BackfillItemError("claim_in_progress");
    return { kind: "none" };
  }
  // Only a finished claim is moved. An error claim can be a live safety barrier the apply gate
  // and the sweep read under this response_kind (Astra review 2): leave it, skip the text.
  if (data.status !== "completed") return { kind: "skip", reason: "claim_error_state" };
  const { data: moved, error: moveErr } = await db.from("ai_response_claims")
    .update({ response_kind: backfillPriorKind(runId, data.id), updated_at: new Date().toISOString() })
    // Compare-and-set: a concurrent reclaim / completion changes status or updated_at.
    .eq("id", data.id).eq("response_kind", RESPONSE_KIND).eq("status", "completed").eq("updated_at", data.updated_at)
    .select("id").maybeSingle();
  if (moveErr) throw new BackfillItemError("claim_move_failed");
  if (!moved) throw new BackfillItemError("claim_move_lost_race");
  return { kind: "moved", claimId: data.id };
}

/** Errors that end one text, as closed codes (never raw error text). */
export class BackfillItemError extends Error {
  constructor(readonly code: BackfillErrorCode) { super(code); }
}
export const BACKFILL_ERROR_CODES = [
  "claim_read_failed", "claim_in_progress", "claim_move_failed", "claim_move_lost_race",
  "inbound_read_failed", "marker_write_failed", "effects_read_failed", "unexpected_error",
] as const;
export type BackfillErrorCode = (typeof BACKFILL_ERROR_CODES)[number];

/** Closed mapping: a known backfill code, else "unexpected_error". No message text ever passes through. */
export function errorCode(e: unknown): BackfillErrorCode {
  return e instanceof BackfillItemError ? e.code : "unexpected_error";
}

type StoredDecision = { status: string; road: string | null; failure_reason: string | null; action: { road: string; steps?: Array<{ kind: string }> } | null };

/** What carrying out this stored decision would do under `treatment` (classify-only report). */
export function wouldDo(d: StoredDecision | null, treatment: Treatment): Pick<ItemResult, "wouldReply" | "wouldDrip" | "wouldAlert" | "wouldHold" | "wouldClose"> {
  if (!d) return { wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: false, wouldClose: false };
  const steps = d.action?.steps ?? [];
  const has = (k: string) => steps.some((s) => s.kind === k);
  if (treatment === "sort_only") {
    const kind = routingV2SortOnlyKind(d as never);
    return {
      wouldReply: false, wouldDrip: false,
      // alert_and_hold always alerts (a hot road with no alert of its own gets "Named a price").
      wouldAlert: kind === "alert_and_hold" || (has("alert") && (kind === "live_hold" || kind === "live_stop")),
      wouldHold: kind.startsWith("live_") || kind === "alert_and_hold",
      wouldClose: kind === "close_wrong_number" || kind === "close_not_interested",
    };
  }
  if (d.status === "failed") return { wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: true, wouldClose: false };
  if (d.action && ROUTING_V2_BACKFILL_HOLD_ROADS.has(d.action.road)) {
    return { wouldReply: false, wouldDrip: false, wouldAlert: has("alert"), wouldHold: true, wouldClose: false };
  }
  return {
    wouldReply: has("reply") || has("wrong_number_close"), wouldDrip: has("drip"), wouldAlert: has("alert"),
    wouldHold: has("hold"), wouldClose: has("wrong_number_close"),
  };
}

async function readEffects(db: Db, c: Candidate, orgId: string, startedIso: string, mode: BackfillMode, treatment: Treatment, classifiedRow: StoredDecision | null): Promise<Omit<ItemResult, "inboundId" | "propertyId" | "ageDays" | "bucket" | "mode" | "treatment" | "outcome" | "error" | "groupChanged" | "appliedWithoutStoredDecision" | "effectsUnknown">> {
  const loose = db as unknown as Loose;
  const reads = await Promise.all([
    loose.from("routing_v2_live_decisions").select("status, road, failure_reason, action").eq("inbound_message_id", c.id).maybeSingle(),
    loose.from("provider_spend_ledger").select("provider, cost").eq("inbound_message_id", c.id).gte("started_at", startedIso),
    loose.from("routing_v2_outbox").select("id, kind, status").eq("inbound_message_id", c.id),
    loose.from("sequence_enrollments").select("id").eq("routing_v2_inbound_id", c.id),
    loose.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", c.propertyId).maybeSingle(),
    // Every text to this seller since the item started, whatever sent it: the outbox consumer AND
    // the direct senders (the wrong-number reply goes out without the outbox).
    db.from("messages").select("id, status, idempotency_key").eq("property_id", c.propertyId).eq("direction", "outbound")
      .gte("created_at", startedIso).in("status", ["pending", "queued", "sent", "delivered"]),
  ]);
  // An unreadable effect is an error, never a zero (Astra review 2b-4).
  if (reads.some((r: { error: unknown }) => r.error)) throw new BackfillItemError("effects_read_failed");
  const [{ data: dec }, { data: spend }, { data: box }, { data: enr }, { data: prop }, { data: sentRows }] = reads as Array<{ data: unknown }> as never as [
    { data: unknown }, { data: unknown }, { data: unknown }, { data: unknown }, { data: unknown }, { data: Array<{ id: string; status: string; idempotency_key: string | null }> | null },
  ];
  // Classify-only writes no decision row: its decision is the row it handed back.
  const d = mode === "classify_only" ? classifiedRow : (dec as StoredDecision | null);
  const ledger = (spend ?? []) as Array<{ provider: string; cost: number | null }>;
  const outbox = (box ?? []) as Array<{ id: string; kind: string; status: string }>;
  const outboxIds = new Set(outbox.map((o) => o.id));
  const sellerTexts = sentRows ?? [];
  const directTexts = sellerTexts.filter((m) => !m.idempotency_key || !outboxIds.has(m.idempotency_key));
  let suppressionCreated = false;
  const phone = normalizePhone(c.fromAddress ?? "");
  if (phone && mode === "apply") {
    const { data: sup, error: supError } = await db.from("sms_phone_suppressions").select("id").eq("org_id", orgId).eq("phone_e164", phone).gte("created_at", startedIso).limit(1);
    if (supError) throw new BackfillItemError("effects_read_failed");
    suppressionCreated = (sup ?? []).length > 0;
  }
  const p = prop as { needs_human_attention?: boolean; last_ai_escalation_reason?: string | null } | null;
  return {
    road: d?.road ?? (d ? `(${d.status})` : "not_dispatched"),
    decisionStatus: d?.status ?? null,
    jevCalls: ledger.filter((l) => l.provider === "jev").length,
    haikuCalls: ledger.filter((l) => l.provider === "haiku").length,
    haikuUsd: ledger.filter((l) => l.provider === "haiku").reduce((s, l) => s + (Number(l.cost) || 0), 0),
    // Outbox replies + texts a direct sender queued; sent = texts that really went out.
    repliesQueued: outbox.filter((o) => o.kind === "reply").length + directTexts.length,
    repliesSent: sellerTexts.filter((m) => m.status === "sent" || m.status === "delivered").length,
    alertsQueued: outbox.filter((o) => o.kind === "alert").length,
    dripsStarted: ((enr ?? []) as unknown[]).length,
    // Candidates are never held at selection, so a hold now was written by this dispatch.
    // Measured in every mode: classify-only must show 0.
    holdCreated: p?.needs_human_attention === true,
    holdReason: p?.needs_human_attention ? (p.last_ai_escalation_reason ?? null) : null,
    suppressionCreated,
    ...wouldDo(d, treatment),
  };
}

async function loadDispatchInput(db: Db, c: Candidate): Promise<{ input: AiDispatchInput; escalationBody: string }> {
  const { data, error } = await db.from("messages").select("body, to_address, from_address, contact_id, conversation_id").eq("id", c.id).maybeSingle();
  if (error || !data?.contact_id) throw new BackfillItemError("inbound_read_failed");
  return {
    input: {
      propertyId: c.propertyId,
      contactId: data.contact_id,
      conversationId: data.conversation_id ?? null,
      inboundFromPhone: data.from_address ?? null,
      inboundToPhone: data.to_address ?? null,
      inboundBody: data.body ?? "",
      inboundMessageId: c.id,
    },
    escalationBody: data.body ?? "",
  };
}

/** The delay workflow's retry loop (aiReplyDelayWorkflow), minus the durable sleep. */
async function dispatchLikeWorkflow(
  db: Db,
  input: AiDispatchInput,
  deps: Required<Pick<BackfillDeps, "anthropic" | "sleep">> & { dispatch: typeof dispatchAiResponse },
): Promise<AiDispatchOutcome> {
  let current = input;
  let outcome: AiDispatchOutcome | AiRetryOutcome = await deps.dispatch(db, current, { anthropic: deps.anthropic, checkSuperseded: true });
  while (isRetryOutcome(outcome)) {
    await deps.sleep(outcome.delaySeconds * 1000);
    current = {
      ...current,
      retryAttempt: outcome.attempt,
      ...(outcome.reply ? { retryReply: outcome.reply } : {}),
      ...(outcome.nineDeferral ? { nineDeferral: outcome.nineDeferral } : {}),
    };
    outcome = await deps.dispatch(db, current, { anthropic: deps.anthropic, checkSuperseded: true });
  }
  return outcome;
}

export async function runBackfill(db: Db, opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillRunResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const dispatch = deps.dispatch ?? dispatchAiResponse;
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
  const textMaxAgeDays = opts.textMaxAgeDays ?? DEFAULT_TEXT_MAX_AGE_DAYS;
  if (!(ratePerMinute > 0)) throw new BackfillRefusal("--rate must be > 0");
  // Ages are measured on the database clock: skew = DB clock - this machine's clock.
  let skewMs = 0;
  const refreshSkew = async () => { if (deps.dbNowMs) skewMs = (await deps.dbNowMs()) - now(); };
  await refreshSkew();
  const dbNow = () => now() + skewMs;
  const startedAt = new Date(dbNow()).toISOString();
  const sinceIso = new Date(dbNow() - maxAgeDays * 86_400_000).toISOString();

  if (opts.mode === "apply" && !(await backfillRecorderPresent(db as unknown as Parameters<typeof backfillRecorderPresent>[0]))) {
    throw new BackfillRefusal("migration 20261031150000 (routing_v2_backfill_record_live_decision) is not applied: apply it through the normal migration workflow before --apply");
  }
  const { facts, state } = await loadSelectionFacts(db, opts.orgId, sinceIso, dbNow());
  const flagCheck = checkFlags(state, opts.mode, opts.forceFlags === true);
  if (flagCheck.refuse) throw new BackfillRefusal(flagCheck.refuse);
  const selection = selectCandidates(facts, { nowMs: dbNow(), maxAgeDays, mode: opts.mode });
  // Newest first, so --limit and batches always take the freshest replies.
  let queue = selection.candidates.slice().sort((a, b) => a.ageDays - b.ageDays);
  if (opts.batchMaxAgeDays !== undefined) queue = queue.filter((c) => c.ageDays <= opts.batchMaxAgeDays!);
  if (opts.limit !== undefined) queue = queue.slice(0, opts.limit);

  const result: BackfillRunResult = {
    runId: opts.runId, orgId: opts.orgId, mode: opts.mode, startedAt, finishedAt: startedAt,
    options: { maxAgeDays, ratePerMinute, textMaxAgeDays, limit: opts.limit ?? null, forceFlags: opts.forceFlags === true, batchMaxAgeDays: opts.batchMaxAgeDays ?? null },
    flags: flagSummary(state), flagWarnings: flagCheck.warnings, selection, dispatched: queue, items: [], supersededMarked: 0,
    interruptedBefore: 0, interruptedAfter: 0,
  };
  // Counted from the database markers, not from what this run selected (Astra 3rd pass, 2).
  const interruptedIds = new Set(facts.inbounds.filter((r) => r.marker?.applyStarted && !r.marker?.apply).map((r) => r.id));
  result.interruptedBefore = interruptedIds.size;
  result.interruptedAfter = interruptedIds.size;
  if (opts.mode === "dry_run") {
    result.finishedAt = new Date(now()).toISOString();
    return result;
  }

  const { data: config } = await db.from("ai_responder_configs").select("escalation_keywords").eq("org_id", opts.orgId).eq("active", true).maybeSingle();
  const escalationKeywords = (config?.escalation_keywords ?? null) as ReadonlyArray<string> | null;
  const intervalMs = 60_000 / ratePerMinute;
  let nextStart = now();

  for (const [i, c] of queue.entries()) {
    const wait = nextStart - now();
    if (wait > 0) await sleep(wait);
    nextStart = Math.max(now(), nextStart) + intervalMs;
    if (i > 0 && i % 50 === 0) await refreshSkew().catch(() => undefined);
    const itemStarted = new Date(dbNow()).toISOString();
    // Treatment is decided NOW, not at selection: a text that crossed the cutoff during a long
    // run drops to sort-only.
    const ageNow = (dbNow() - Date.parse(c.createdAt)) / 86_400_000;
    const treatment = treatmentFor(ageNow, textMaxAgeDays);
    const reviewed = c.marker?.classify;
    const base = {
      effectsUnknown: false,
      inboundId: c.id, propertyId: c.propertyId, ageDays: Math.round(ageNow * 10) / 10, bucket: c.bucket, mode: opts.mode, treatment,
      groupChanged: opts.mode === "apply" && !!reviewed?.decision && !!reviewed.treatment && reviewed.treatment !== treatment,
      appliedWithoutStoredDecision: opts.mode === "apply" && !reviewed?.decision,
    };
    try {
      const { input } = await loadDispatchInput(db, c);
      if (opts.mode === "classify_only" && keywordHoldLikely(input.inboundBody, escalationKeywords)) {
        await writeMarker(db, c.id, { classify: { runId: opts.runId, at: itemStarted, outcome: "keyword_hold_not_classified" } });
        result.items.push({ ...base, ...emptyEffects(), road: "keyword_hold", outcome: "not_dispatched:keyword_hold", wouldHold: true, wouldAlert: false, error: null });
        continue;
      }
      if (opts.mode === "apply") {
        // Newest wins: older unanswered texts on this property are never routed.
        for (const olderId of c.supersedes) {
          await recordRoutingV2Audit(db, { orgId: opts.orgId, propertyId: c.propertyId, inboundMessageId: olderId, conversationId: c.conversationId, note: `backfill_superseded:${opts.runId}` });
          await writeMarker(db, olderId, { superseded: { runId: opts.runId, at: itemStarted, byInboundId: c.id } });
          result.supersededMarked++;
        }
      }
      // Classify-only claims under its own key and never touches the live responder claim.
      const reopened: ReopenResult = opts.mode === "classify_only" ? { kind: "none" } : await reopenClaim(db, c.id, opts.runId, dbNow());
      if (reopened.kind === "skip") {
        result.items.push({ ...base, ...emptyEffects(), road: "not_dispatched", outcome: `skipped:${reopened.reason}`, error: null });
        continue;
      }
      const priorClaimId = reopened.kind === "moved" ? reopened.claimId : null;
      // An interrupted backfill apply: finish the decision it already recorded (its own hold included).
      const resumeRecordedDecision = opts.mode === "apply" && c.hasLiveDecision && !!c.marker?.applyStarted && !c.marker?.apply;
      if (opts.mode === "apply") await writeMarker(db, c.id, { applyStarted: { runId: opts.runId, at: itemStarted } });
      const storedRow = opts.mode === "apply" ? (c.marker?.classify?.decision ?? null) : null;
      const dispatchMode = opts.mode === "classify_only" ? "classify_only" : treatment === "full" ? "apply" : "sort_only";
      let classifiedRow: Record<string, unknown> | null = null;
      const onClassified = async (row: Record<string, unknown>) => {
        classifiedRow = row;
        // Saved before the claim completes, so a crash right after keeps the decision.
        await writeMarker(db, c.id, { classify: { runId: opts.runId, at: itemStarted, outcome: "classified", treatment, decision: row } });
      };
      const outcome = await dispatchLikeWorkflow(db, {
        ...input,
        routingV2Backfill: {
          runId: opts.runId,
          mode: dispatchMode,
          ...(storedRow ? { storedDecisionRow: storedRow } : {}),
          ...(resumeRecordedDecision ? { resumeRecordedDecision: true } : {}),
          ...(dispatchMode === "classify_only" ? { onClassified } : {}),
        },
      }, { anthropic: deps.anthropic, sleep, dispatch });
      if (opts.mode === "apply") {
        // The delay workflow's post-dispatch steps (dispatchStep + routingV2ShadowStep's audit).
        const completedAt = new Date(now()).toISOString();
        await recordAiResponderOutcomeForThread(db, { conversationId: input.conversationId, outcome, completedAt });
        await markInboundMessageState(db, c.id, {
          aiResponder: { ...outcome, outcome: inboundStampOutcomeOf(outcome), completedAt } as unknown as AiDispatchOutcome & { completedAt: string },
        });
        await recordRoutingV2Audit(db, { propertyId: c.propertyId, inboundMessageId: c.id, conversationId: input.conversationId, note: `dispatch:${outcome.outcome}` });
        // The live path kicks this property's outbox after the response; do it in-process.
        await runRoutingV2OutboxReplies(db, { propertyId: c.propertyId, limit: 5 });
      }
      const outcomeText = `${outcome.outcome}:${"reason" in outcome ? outcome.reason : ""}`;
      const effects = await readEffects(db, c, opts.orgId, itemStarted, opts.mode, treatment, classifiedRow as StoredDecision | null);
      if ("reason" in outcome && outcome.reason === ROUTING_V2_BACKFILL_CLASSIFY_KEYWORD_HOLD) {
        effects.road = "keyword_hold";
        effects.wouldHold = true;
      }
      await writeMarker(db, c.id, {
        [opts.mode === "apply" ? "apply" : "classify"]: {
          runId: opts.runId, at: itemStarted, outcome: outcomeText.slice(0, 200), treatment,
          ...(priorClaimId ? { priorClaimId } : {}),
          ...(classifiedRow ? { decision: classifiedRow } : {}),
        },
      } as Partial<BackfillMarker>);
      result.items.push({ ...base, ...effects, outcome: outcomeText, error: null });
      if (opts.mode === "classify_only" && !("reason" in outcome && outcome.reason === ROUTING_V2_BACKFILL_CLASSIFY_ONLY)) {
        log(`note: ${c.id} classify-only ended before the decision: ${outcomeText}`);
      }
    } catch (e) {
      // Reconcile from the database: an error after delivery must not report the send as zero (Astra review 6).
      let effects: ReturnType<typeof emptyEffects> = emptyEffects();
      let effectsUnknown = false;
      try { effects = await readEffects(db, c, opts.orgId, itemStarted, opts.mode, treatment, null); } catch { effectsUnknown = true; }
      result.items.push({ ...base, ...effects, effectsUnknown, road: effects.road === "not_dispatched" ? "error" : effects.road, outcome: "error", error: errorCode(e) });
    }
    if ((i + 1) % 25 === 0) log(`${i + 1}/${queue.length} dispatched`);
  }
  if (opts.mode === "apply") {
    for (const it of result.items) {
      if (it.error && it.outcome === "error") interruptedIds.add(it.inboundId);
      else if (!it.error && interruptedIds.has(it.inboundId)) interruptedIds.delete(it.inboundId);
    }
    result.interruptedAfter = interruptedIds.size;
  }
  result.finishedAt = new Date(now()).toISOString();
  return result;
}

function emptyEffects() {
  return {
    road: "not_dispatched", decisionStatus: null as string | null, jevCalls: 0, haikuCalls: 0, haikuUsd: 0, repliesQueued: 0, repliesSent: 0,
    alertsQueued: 0, dripsStarted: 0, holdCreated: false, holdReason: null as string | null, suppressionCreated: false,
    wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: false, wouldClose: false,
  };
}
