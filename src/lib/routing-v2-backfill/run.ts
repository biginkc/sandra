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
};

export class BackfillRefusal extends Error {}

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
  if (error || !data) throw new Error(`backfill marker read: ${error?.message ?? "no row"}`);
  const meta = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? (data.metadata as Record<string, unknown>) : {};
  const prev = (meta.routingV2Backfill && typeof meta.routingV2Backfill === "object" ? meta.routingV2Backfill : {}) as BackfillMarker;
  const { data: updated, error: upErr } = await db.from("messages")
    .update({ metadata: { ...meta, routingV2Backfill: { ...prev, ...patch } } as Json })
    .eq("id", messageId).select("id").maybeSingle();
  if (upErr || !updated) throw new Error(`backfill marker write: ${upErr?.message ?? "no row"}`);
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

export async function reopenClaim(db: Db, inboundId: string, runId: string, nowMs: number = Date.now()): Promise<string | null> {
  const { data, error } = await db.from("ai_response_claims")
    .select("id, status, lease_expires_at").eq("inbound_message_id", inboundId).eq("response_kind", RESPONSE_KIND).maybeSingle();
  if (error) throw new Error(`claim read: ${error.message}`);
  if (!data) return null;
  if (data.status === "processing") {
    // A live lease: someone is dispatching this text right now. An expired one (a crashed run)
    // is reclaimed by the dispatch's own claim step, so it stays where it is.
    if (Date.parse(data.lease_expires_at) > nowMs) throw new Error("claim_in_progress");
    return null;
  }
  const { data: moved, error: moveErr } = await db.from("ai_response_claims")
    .update({ response_kind: backfillPriorKind(runId, data.id), updated_at: new Date().toISOString() })
    .eq("id", data.id).eq("response_kind", RESPONSE_KIND).select("id").maybeSingle();
  if (moveErr || !moved) throw new Error(moveErr ? `claim_move_failed:${moveErr.code ?? "unknown"}` : "claim_move_lost_race");
  return data.id;
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

async function readEffects(db: Db, c: Candidate, orgId: string, startedIso: string, mode: BackfillMode, treatment: Treatment, classifiedRow: StoredDecision | null): Promise<Omit<ItemResult, "inboundId" | "propertyId" | "ageDays" | "bucket" | "mode" | "treatment" | "outcome" | "error" | "groupChanged" | "appliedWithoutStoredDecision">> {
  const loose = db as unknown as Loose;
  const [{ data: dec }, { data: spend }, { data: box }, { data: enr }, { data: prop }] = await Promise.all([
    loose.from("routing_v2_live_decisions").select("status, road, failure_reason, action").eq("inbound_message_id", c.id).maybeSingle(),
    loose.from("provider_spend_ledger").select("provider, cost").eq("inbound_message_id", c.id).gte("created_at", startedIso),
    loose.from("routing_v2_outbox").select("kind, status").eq("inbound_message_id", c.id),
    loose.from("sequence_enrollments").select("id").eq("routing_v2_inbound_id", c.id),
    loose.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", c.propertyId).maybeSingle(),
  ]);
  // Classify-only writes no decision row: its decision is the row it handed back.
  const d = mode === "classify_only" ? classifiedRow : (dec as StoredDecision | null);
  const ledger = (spend ?? []) as Array<{ provider: string; cost: number | null }>;
  const outbox = (box ?? []) as Array<{ kind: string; status: string }>;
  let suppressionCreated = false;
  const phone = normalizePhone(c.fromAddress ?? "");
  if (phone && mode === "apply") {
    const { data: sup } = await db.from("sms_phone_suppressions").select("id").eq("org_id", orgId).eq("phone_e164", phone).gte("created_at", startedIso).limit(1);
    suppressionCreated = (sup ?? []).length > 0;
  }
  const p = prop as { needs_human_attention?: boolean; last_ai_escalation_reason?: string | null } | null;
  return {
    road: d?.road ?? (d ? `(${d.status})` : "not_dispatched"),
    decisionStatus: d?.status ?? null,
    jevCalls: ledger.filter((l) => l.provider === "jev").length,
    haikuCalls: ledger.filter((l) => l.provider === "haiku").length,
    haikuUsd: ledger.filter((l) => l.provider === "haiku").reduce((s, l) => s + (Number(l.cost) || 0), 0),
    repliesQueued: outbox.filter((o) => o.kind === "reply").length,
    repliesSent: outbox.filter((o) => o.kind === "reply" && o.status === "sent").length,
    alertsQueued: outbox.filter((o) => o.kind === "alert").length,
    dripsStarted: (enr ?? []).length,
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
  if (error || !data?.contact_id) throw new Error(`inbound read: ${error?.message ?? "no contact"}`);
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

  const { facts, state } = await loadSelectionFacts(db, opts.orgId, sinceIso);
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
  };
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
      const priorClaimId = await reopenClaim(db, c.id, opts.runId, dbNow());
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
      result.items.push({ ...base, ...emptyEffects(), road: "error", outcome: "error", error: errorCode(e) });
    }
    if ((i + 1) % 25 === 0) log(`${i + 1}/${queue.length} dispatched`);
  }
  result.finishedAt = new Date(now()).toISOString();
  return result;
}

/** Errors become short codes: never a database "Key (...)=(...)" detail or a value from a row. */
export function errorCode(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/\(.*?\)=\(.*?\)/g, "(…)").replace(/\+?\d[\d\s().-]{6,}\d/g, "…").slice(0, 120);
}

function emptyEffects() {
  return {
    road: "not_dispatched", decisionStatus: null, jevCalls: 0, haikuCalls: 0, haikuUsd: 0, repliesQueued: 0, repliesSent: 0,
    alertsQueued: 0, dripsStarted: 0, holdCreated: false, holdReason: null, suppressionCreated: false,
    wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: false, wouldClose: false,
  };
}
