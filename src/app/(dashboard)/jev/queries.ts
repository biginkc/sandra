import "server-only";

import { createClient } from "@/lib/supabase/server";

export type JevQueueSource = "ai_disposition_review" | "jev_lead_decision" | "classifier_event";

/** Unified shape across all three backing sources. */
export type JevQueueItem = {
  id: string;
  source: JevQueueSource;
  propertyId: string;
  propertyAddress: string | null;
  conversationId: string | null;
  proposedOutcome: string;
  status: string;
  resolvedOutcome: string | null;
  correctedOutcome: string | null;
  nativeConfidence: number | null;
  thresholdAtDecision: number | null;
  evidenceBody: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  correctionReason: string | null;
  humanReviewedAt: string | null;
  /** true only for a row this app can act on further (confirm/correct/
   *  mark-reviewed). classifier_event rows never applied anything and
   *  have no review row to act on — informational only. */
  actionable: boolean;
  applicationState: "applied" | "not_applied" | "superseded" | "failed";
  model: string | null;
  schemaVersion: string | null;
  policyVersion: string | null;
  /** Full outcome taxonomy this row may be corrected to. Empty for
   *  classifier_event rows (nothing to correct — no decision was made). */
  correctionTargets: readonly string[];
};

const FULL_TAXONOMY = ["new_lead", "wrong_number", "not_interested", "nurture", "opted_out", "dnc"] as const;

type PropertyEmbed = { address: string | null; city: string | null; state: string | null } | null;
type MessageEmbed = { body: string | null } | null;

function formatAddress(properties: PropertyEmbed): string | null {
  if (!properties) return null;
  return [properties.address, properties.city, properties.state].filter(Boolean).join(", ") || null;
}

function readDecisionAudit(decision: unknown): { nativeConfidence: number | null; thresholdAtDecision: number | null } {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { nativeConfidence: null, thresholdAtDecision: null };
  }
  const obj = decision as Record<string, unknown>;
  const nativeConfidence = typeof obj.nativeConfidence === "number" ? obj.nativeConfidence : null;
  const thresholdAtDecision = typeof obj.thresholdAtDecision === "number" ? obj.thresholdAtDecision : null;
  return { nativeConfidence, thresholdAtDecision };
}

const AI_DISPOSITION_REVIEW_SELECT =
  "id, property_id, conversation_id, disposition, status, corrected_disposition, corrected_at, corrected_by, correction_reason, dispo_applied, resolved_at, reviewed_by, human_reviewed_at, source_inbound_message_id, model:sms_classification_runs!classification_run_id(model, schema_version, policy_version, decision), created_at, properties(address, city, state), messages(body)";

const JEV_LEAD_DECISION_SELECT =
  "id, property_id, conversation_id, proposed_outcome, status, resolved_outcome, resolved_at, resolved_by, resolution_reason, human_reviewed_at, native_confidence, threshold_at_decision, source_inbound_message_id, model:sms_classification_runs!classification_run_id(model, schema_version, policy_version), created_at, properties(address, city, state), messages(body)";

type AiDispositionReviewRow = {
  id: string;
  property_id: string;
  conversation_id: string;
  disposition: string;
  status: string;
  corrected_disposition: string | null;
  corrected_at: string | null;
  corrected_by: string | null;
  correction_reason: string | null;
  dispo_applied: boolean;
  resolved_at: string | null;
  reviewed_by: string | null;
  human_reviewed_at: string | null;
  source_inbound_message_id: string;
  model: { model: string; schema_version: string; policy_version: string; decision: unknown } | null;
  created_at: string;
  properties: PropertyEmbed;
  messages: MessageEmbed;
};

function mapAiDispositionReview(row: AiDispositionReviewRow): JevQueueItem {
  const audit = readDecisionAudit(row.model?.decision);
  const resolvedOutcome = row.status === "pending" ? null : row.corrected_disposition ?? row.disposition;
  const applicationState: JevQueueItem["applicationState"] =
    row.status === "superseded" ? "superseded" : row.dispo_applied ? "applied" : "not_applied";
  return {
    id: row.id,
    source: "ai_disposition_review",
    propertyId: row.property_id,
    propertyAddress: formatAddress(row.properties),
    conversationId: row.conversation_id,
    proposedOutcome: row.disposition,
    status: row.status,
    resolvedOutcome,
    correctedOutcome: row.corrected_disposition,
    nativeConfidence: audit.nativeConfidence,
    thresholdAtDecision: audit.thresholdAtDecision,
    evidenceBody: row.messages?.body ?? null,
    createdAt: row.created_at,
    resolvedAt: row.corrected_at ?? row.resolved_at,
    resolvedBy: row.corrected_by ?? row.reviewed_by,
    correctionReason: row.correction_reason,
    humanReviewedAt: row.human_reviewed_at,
    actionable: true,
    applicationState,
    model: row.model?.model ?? null,
    schemaVersion: row.model?.schema_version ?? null,
    policyVersion: row.model?.policy_version ?? null,
    correctionTargets: FULL_TAXONOMY,
  };
}

type JevLeadDecisionRow = {
  id: string;
  property_id: string;
  conversation_id: string;
  proposed_outcome: string;
  status: string;
  resolved_outcome: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_reason: string | null;
  human_reviewed_at: string | null;
  native_confidence: number | null;
  threshold_at_decision: number | null;
  source_inbound_message_id: string;
  model: { model: string; schema_version: string; policy_version: string } | null;
  created_at: string;
  properties: PropertyEmbed;
  messages: MessageEmbed;
};

function mapJevLeadDecision(row: JevLeadDecisionRow): JevQueueItem {
  const applicationState: JevQueueItem["applicationState"] =
    row.status === "superseded" ? "superseded" : row.status === "pending" ? "not_applied" : "applied";
  return {
    id: row.id,
    source: "jev_lead_decision",
    propertyId: row.property_id,
    propertyAddress: formatAddress(row.properties),
    conversationId: row.conversation_id,
    proposedOutcome: row.proposed_outcome,
    status: row.status,
    resolvedOutcome: row.resolved_outcome,
    correctedOutcome: row.status === "corrected" ? row.resolved_outcome : null,
    nativeConfidence: row.native_confidence,
    thresholdAtDecision: row.threshold_at_decision,
    evidenceBody: row.messages?.body ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    correctionReason: row.resolution_reason,
    humanReviewedAt: row.human_reviewed_at,
    actionable: true,
    applicationState,
    model: row.model?.model ?? null,
    schemaVersion: row.model?.schema_version ?? null,
    policyVersion: row.model?.policy_version ?? null,
    correctionTargets: FULL_TAXONOMY,
  };
}

type ClassifierEventRow = {
  id: string;
  property_id: string;
  conversation_id: string;
  resolved_outcome: string | null;
  fallback_reason: string | null;
  model: string;
  schema_version: string;
  policy_version: string;
  decision: unknown;
  created_at: string;
  properties: PropertyEmbed;
  messages: MessageEmbed;
};

function mapClassifierEvent(row: ClassifierEventRow): JevQueueItem {
  const audit = readDecisionAudit(row.decision);
  return {
    id: row.id,
    source: "classifier_event",
    propertyId: row.property_id,
    propertyAddress: formatAddress(row.properties),
    conversationId: row.conversation_id,
    proposedOutcome: row.resolved_outcome ?? (row.fallback_reason ? "classification_failed" : "unclear"),
    status: row.fallback_reason ? "failed" : "no_action",
    resolvedOutcome: null,
    correctedOutcome: null,
    nativeConfidence: audit.nativeConfidence,
    thresholdAtDecision: null,
    evidenceBody: row.messages?.body ?? null,
    createdAt: row.created_at,
    resolvedAt: null,
    resolvedBy: null,
    correctionReason: row.fallback_reason,
    humanReviewedAt: null,
    actionable: false,
    applicationState: row.fallback_reason ? "failed" : "not_applied",
    model: row.model,
    schemaVersion: row.schema_version,
    policyVersion: row.policy_version,
    correctionTargets: [],
  };
}

/**
 * Pending items only — the Needs-a-decision queue. Below-threshold/
 * human-gated wrong_number/not_interested/opted_out/dnc live in
 * ai_disposition_reviews (status='pending'); new_lead/nurture live in
 * jev_lead_decisions (status='pending'). classifier_event rows (failures/
 * unclear) never reach this queue — there is no property state at risk
 * and no decision to choose between; they are audit-only, in Review Jev.
 */
export async function getNeedsDecisionQueue(): Promise<{ items: JevQueueItem[]; error: string | null }> {
  const supabase = await createClient();

  const [reviewsRes, decisionsRes] = await Promise.all([
    supabase
      .from("ai_disposition_reviews")
      .select(AI_DISPOSITION_REVIEW_SELECT)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("jev_lead_decisions")
      .select(JEV_LEAD_DECISION_SELECT)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  // Query errors must not silently render as an empty queue — surface
  // them so the UI can say "could not load" instead of "nothing to do".
  if (reviewsRes.error || decisionsRes.error) {
    return {
      items: [],
      error: reviewsRes.error?.message ?? decisionsRes.error?.message ?? "Unknown query error",
    };
  }

  const reviews = (reviewsRes.data ?? []).map((row) => mapAiDispositionReview(row as unknown as AiDispositionReviewRow));
  const decisions = (decisionsRes.data ?? []).map((row) => mapJevLeadDecision(row as unknown as JevLeadDecisionRow));

  return {
    items: [...reviews, ...decisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    error: null,
  };
}

export type ReviewJevSummary = {
  /** Per-outcome counts among rows a human has actually reviewed
   *  (confirmed/corrected, or explicitly marked reviewed) — never among
   *  unreviewed auto-applied rows, which are NOT treated as correct just
   *  because nobody looked. Keyed by the ORIGINAL proposed outcome. */
  reviewedAgreement: Record<string, { agreed: number; corrected: number }>;
  coverage: {
    total: number;
    pending: number;
    autoAppliedUnreviewed: number;
    reviewedByHuman: number;
    superseded: number;
    failedOrHeld: number;
  };
};

export type ReviewJevData = {
  items: JevQueueItem[];
  summary: ReviewJevSummary;
  hasMore: boolean;
  error: string | null;
};

const REVIEW_PAGE_SIZE = 50;

/**
 * Full audit view, paginated (REVIEW_PAGE_SIZE per backing source per
 * page — three sources, so up to 3x that many items per page). Covers
 * every Jev decision: applied, held/pending, superseded, AND classifier
 * failures/unclear that never produced a review row at all (queried
 * directly from sms_classification_runs). Confidence/threshold are shown
 * as actually recorded (joined from sms_classification_runs' persisted
 * decision, or jev_lead_decisions' own columns) — never fabricated.
 */
export async function getReviewJevData(page = 0): Promise<ReviewJevData> {
  const supabase = await createClient();
  const from = page * REVIEW_PAGE_SIZE;
  const to = from + REVIEW_PAGE_SIZE - 1;

  const [reviewsRes, decisionsRes, eventsRes] = await Promise.all([
    supabase
      .from("ai_disposition_reviews")
      .select(AI_DISPOSITION_REVIEW_SELECT)
      .order("created_at", { ascending: false })
      .range(from, to),
    supabase
      .from("jev_lead_decisions")
      .select(JEV_LEAD_DECISION_SELECT)
      .order("created_at", { ascending: false })
      .range(from, to),
    // Classifier failures/unclear/bad_number: these never get a review
    // row (resolvePolicyOutcome routes them to no_action, and a failed
    // classify call never reaches resolvePolicyOutcome at all), so they
    // would otherwise be invisible to Review Jev entirely.
    supabase
      .from("sms_classification_runs")
      .select(
        "id, property_id, conversation_id, resolved_outcome, fallback_reason, model, schema_version, policy_version, decision, created_at, properties(address, city, state), messages(body)",
      )
      .eq("provider", "jev")
      .or("fallback_reason.not.is.null,resolved_outcome.in.(unclear,bad_number)")
      .order("created_at", { ascending: false })
      .range(from, to),
  ]);

  if (reviewsRes.error || decisionsRes.error || eventsRes.error) {
    return {
      items: [],
      summary: summarize([]),
      hasMore: false,
      error:
        reviewsRes.error?.message ?? decisionsRes.error?.message ?? eventsRes.error?.message ?? "Unknown query error",
    };
  }

  const reviews = (reviewsRes.data ?? []).map((row) => mapAiDispositionReview(row as unknown as AiDispositionReviewRow));
  const decisions = (decisionsRes.data ?? []).map((row) => mapJevLeadDecision(row as unknown as JevLeadDecisionRow));
  const events = (eventsRes.data ?? []).map((row) => mapClassifierEvent(row as unknown as ClassifierEventRow));

  const items = [...reviews, ...decisions, ...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const hasMore =
    (reviewsRes.data?.length ?? 0) === REVIEW_PAGE_SIZE ||
    (decisionsRes.data?.length ?? 0) === REVIEW_PAGE_SIZE ||
    (eventsRes.data?.length ?? 0) === REVIEW_PAGE_SIZE;

  return { items, summary: summarize(items), hasMore, error: null };
}

export function summarize(items: JevQueueItem[]): ReviewJevSummary {
  const reviewedAgreement: ReviewJevSummary["reviewedAgreement"] = {};
  let pending = 0;
  let autoAppliedUnreviewed = 0;
  let reviewedByHuman = 0;
  let superseded = 0;
  let failedOrHeld = 0;

  for (const item of items) {
    if (item.source === "classifier_event") {
      failedOrHeld += 1;
      continue;
    }
    if (item.status === "pending") {
      pending += 1;
      continue;
    }
    if (item.applicationState === "superseded") {
      superseded += 1;
      continue;
    }
    // A human either resolved this via confirm/correct (resolvedBy set)
    // or explicitly marked an auto-applied row as reviewed
    // (humanReviewedAt set) without changing its outcome.
    const humanReviewed = item.resolvedBy !== null || item.humanReviewedAt !== null;
    if (!humanReviewed) {
      autoAppliedUnreviewed += 1;
      continue;
    }
    reviewedByHuman += 1;
    const bucket = reviewedAgreement[item.proposedOutcome] ?? { agreed: 0, corrected: 0 };
    if (item.correctedOutcome && item.correctedOutcome !== item.proposedOutcome) {
      bucket.corrected += 1;
    } else {
      bucket.agreed += 1;
    }
    reviewedAgreement[item.proposedOutcome] = bucket;
  }

  return {
    reviewedAgreement,
    coverage: { total: items.length, pending, autoAppliedUnreviewed, reviewedByHuman, superseded, failedOrHeld },
  };
}
