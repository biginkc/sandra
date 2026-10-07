import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { renderReviewedReply } from "@/lib/inbox/reply-template";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import type { Database } from "@/lib/supabase/types";
import {
  loadOrgThresholdMap,
  resolveThresholdDecision,
  type ThresholdMap,
} from "@/lib/sms-classification/thresholds";
import type {
  JevEscalationReason,
  JevOutcome,
  JevReplyIntent,
} from "@/lib/sms-classification/types";

/**
 * Template step for the AI responder (Messages v2 Phase 4, PLAN D5 / 4.6).
 *
 * The only text that may be sent automatically is a template a human approved
 * in the Templates UI. This module decides WHETHER a Jev outcome has one to
 * send and renders it; it never authors text, never reads an LLM draft, and
 * every send still goes through `sendResponderMessage` (Q8 gate, reservation,
 * fence, consent, quiet hours).
 *
 * Fail closed: any doubt (lookup error, label switched off, below the
 * threshold, template unapproved / edited / deleted, unrenderable) returns
 * `none`, and the dispatch falls through to today's behaviour.
 */

/**
 * Outcomes an owner may map to a template (mirrors the
 * `auto_reply_templates_outcome_check` constraint). new_lead (PLAN D5: a new
 * lead never auto-replies), opted_out, dnc and wrong_number are never
 * answered automatically.
 */
export const TEMPLATE_REPLY_OUTCOMES: ReadonlySet<JevOutcome> = new Set([
  "nurture",
  "not_interested",
]);

export type TemplateRow = {
  content: string;
  approved_for_auto_send: boolean;
  approved_content: string | null;
  deleted_at: string | null;
};

export type TemplateCandidate = {
  mappingId: string;
  templateId: string;
  replyIntent: string | null;
  priority: number;
  template: TemplateRow | null;
};

/** A template may be sent automatically only while the text equals the approved text. */
export function isTemplateSendable(template: TemplateRow | null): template is TemplateRow {
  return (
    template !== null &&
    template.deleted_at === null &&
    template.approved_for_auto_send === true &&
    template.approved_content !== null &&
    template.approved_content === template.content &&
    template.content.trim().length > 0
  );
}

export type TemplateSelection =
  | { kind: "selected"; candidate: TemplateCandidate & { template: TemplateRow } }
  | { kind: "none"; reason: "no_mapping" | "template_unavailable" };

/**
 * Pick the mapping for a reply intent. A mapping with a specific reply_intent
 * beats the any-intent (null) mapping; then lower priority number first; then
 * id for a stable order. Unsendable templates are skipped, so un-approving one
 * template never sends another that was not meant for this case.
 */
export function selectAutoReplyTemplate(
  candidates: readonly TemplateCandidate[],
  replyIntent: JevReplyIntent | null,
): TemplateSelection {
  const matching = candidates
    .filter((c) => c.replyIntent === null || (replyIntent !== null && c.replyIntent === replyIntent))
    .sort(
      (a, b) =>
        Number(b.replyIntent !== null) - Number(a.replyIntent !== null) ||
        a.priority - b.priority ||
        a.mappingId.localeCompare(b.mappingId),
    );
  if (matching.length === 0) return { kind: "none", reason: "no_mapping" };
  for (const candidate of matching) {
    if (isTemplateSendable(candidate.template)) {
      return { kind: "selected", candidate: { ...candidate, template: candidate.template } };
    }
  }
  return { kind: "none", reason: "template_unavailable" };
}

export type TemplateSkipReason =
  | "outcome_not_templatable"
  | "human_follow_up"
  | "automation_disabled"
  | "below_threshold"
  | "threshold_unavailable"
  | "no_mapping"
  | "template_unavailable"
  | "render_failed"
  | "lookup_failed";

export type TemplateReplyResolution =
  | {
      kind: "template";
      templateId: string;
      mappingId: string;
      body: string;
      outcome: JevOutcome;
    }
  | { kind: "none"; reason: TemplateSkipReason };

type MappingRow = {
  id: string;
  template_id: string;
  reply_intent: string | null;
  priority: number;
  sms_templates: TemplateRow | TemplateRow[] | null;
};

export async function resolveApprovedTemplateReply(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    propertyId: string;
    contactId: string;
    outcome: JevOutcome;
    outcomeConfidence: number | null;
    /**
     * Jev's human-follow-up answer for this message. REQUIRED (no default):
     * a template is sent ONLY when it is exactly `not_applicable`. Price /
     * offer, distress, call request, multi-property, third party, needs
     * review, `uncertain`, and a missing answer (null) all fail closed to "no
     * template" so a human sees the conversation (PLAN D5).
     */
    escalationReason: JevEscalationReason | null;
    replyIntent?: JevReplyIntent | null;
    /** Test seam: defaults to the live per-org thresholds. */
    thresholds?: ThresholdMap;
  },
): Promise<TemplateReplyResolution> {
  if (!TEMPLATE_REPLY_OUTCOMES.has(args.outcome)) {
    return { kind: "none", reason: "outcome_not_templatable" };
  }

  if (args.escalationReason !== "not_applicable") {
    return { kind: "none", reason: "human_follow_up" };
  }

  // The label's own switch and cutoff are re-read live: an owner who just
  // turned a label off stops its template replies on the very next inbound.
  const thresholds = args.thresholds ?? (await loadOrgThresholdMap(supabase, args.orgId));
  const decision = resolveThresholdDecision(
    { outcome: args.outcome, outcomeConfidence: args.outcomeConfidence },
    thresholds,
  );
  if (decision.status === "human_gated") {
    return {
      kind: "none",
      reason: decision.reason === "automation_disabled" ? "automation_disabled" : "threshold_unavailable",
    };
  }
  if (decision.status === "needs_decision") return { kind: "none", reason: "below_threshold" };

  const { data, error } = await supabase
    .from("auto_reply_templates")
    .select(
      "id, template_id, reply_intent, priority, sms_templates(content, approved_for_auto_send, approved_content, deleted_at)",
    )
    .eq("org_id", args.orgId)
    .eq("outcome", args.outcome)
    .eq("active", true);
  if (error || !data) {
    reportError(new Error(error?.message ?? "auto reply template lookup returned no data"), {
      tags: { surface: "ai_responder_template_lookup" },
      extra: { orgId: args.orgId },
    });
    return { kind: "none", reason: "lookup_failed" };
  }

  const candidates: TemplateCandidate[] = (data as unknown as MappingRow[]).map((row) => ({
    mappingId: row.id,
    templateId: row.template_id,
    replyIntent: row.reply_intent,
    priority: row.priority,
    template: Array.isArray(row.sms_templates) ? (row.sms_templates[0] ?? null) : row.sms_templates,
  }));
  const selection = selectAutoReplyTemplate(candidates, args.replyIntent ?? null);
  if (selection.kind === "none") return selection;

  const { candidate } = selection;
  try {
    // Existing variable resolution; `my_first_name` is the "Mel" persona.
    const vars = await loadTemplateVars(supabase, {
      propertyId: args.propertyId,
      contactId: args.contactId,
    });
    // Strict renderer: a missing variable without a fallback throws instead of
    // sending a message with a hole in it.
    const body = renderReviewedReply(candidate.template.content, vars);
    return {
      kind: "template",
      templateId: candidate.templateId,
      mappingId: candidate.mappingId,
      body,
      outcome: args.outcome,
    };
  } catch {
    return { kind: "none", reason: "render_failed" };
  }
}
