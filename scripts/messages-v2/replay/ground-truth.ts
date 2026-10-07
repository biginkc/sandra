/**
 * Ground truth for the classifier comparison: what a HUMAN actually decided for each inbound text.
 *
 * Mirrors the Phase 3 scorecard (fn_messages_v2_scorecard, 20261008160000_messages_v2_scorecard.sql)
 * definition of "agreed"/"corrected", turned from a verdict (0/1) into the human's LABEL so any
 * classifier can be scored against it. A message with no human decision gets NO truth and is excluded
 * from every score (it still counts toward volume/hold totals).
 *
 * Precedence per inbound (first match wins), all within 72h of the inbound, matching the scorecard:
 *   1. ai_disposition_reviews.corrected_disposition        -> that label            (explicit)
 *   2. jev_lead_decisions.status = 'corrected'             -> resolved_outcome       (explicit)
 *   3. a user dispo_set on the property within 72h whose target differs from Jev's disposition
 *      (nurture -> needs_sequence is NOT an override: Nurture is a parking step)     -> that label (explicit)
 *      With no Jev review/decision at all, the first user dispo_set within 72h is the label.
 *   4. review status 'confirmed' / decision confirmed by a human (resolved_by set)    -> Jev's label, human kept it (explicit)
 *   5. auto-applied (review auto_accepted / decision confirmed with no human) and at least 72h old at
 *      export time with no correction                                                 -> Jev's label (IMPLICIT, silence = agreement)
 * `needs_sequence` is folded into `nurture` (Jev cannot emit needs_sequence; the scorecard treats the pair as agreeing).
 * Any other human disposition (e.g. callback_requested) is kept as the label "other" and can never match a Jev outcome.
 */
import type { ReplayExport } from "./schema";

export const TRUTH_WINDOW_MS = 72 * 3_600_000;

export type TruthKind = "explicit" | "implicit";
export type Truth = { label: string; kind: TruthKind; source: string };

const KNOWN = new Set(["new_lead", "nurture", "not_interested", "wrong_number", "bad_number", "opted_out", "dnc", "unclear"]);

export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (raw === "needs_sequence") return "nurture";
  return KNOWN.has(raw) ? raw : "other";
}

const t = (v: unknown) => (v ? new Date(String(v)).getTime() : NaN);
const str = (v: unknown) => (v == null ? "" : String(v));

export function deriveGroundTruth(exp: ReplayExport, now: Date = new Date(exp.createdAt)): Map<string, Truth> {
  const he = exp.reference.humanEvents;
  const out = new Map<string, Truth>();
  if (!he) return out;
  for (const m of exp.inbound) {
    const at = t(m.receivedAt);
    const reviews = he.reviews.filter((r) => str(r.source_inbound_message_id) === m.id);
    const decisions = he.decisions.filter((d) => str(d.source_inbound_message_id) === m.id);
    const sets = he.dispoSets
      .filter((d) => m.propertyId && str(d.property_id) === m.propertyId && t(d.created_at) > at && t(d.created_at) <= at + TRUTH_WINDOW_MS)
      .sort((a, b) => t(a.created_at) - t(b.created_at));

    // 1. corrected review
    const corrected = reviews.filter((r) => r.corrected_disposition).sort((a, b) => t(b.corrected_at) - t(a.corrected_at))[0];
    if (corrected) { out.set(m.id, { label: normalizeLabel(corrected.corrected_disposition)!, kind: "explicit", source: "review_corrected" }); continue; }
    // 2. corrected decision
    const correctedDecision = decisions.filter((d) => d.status === "corrected" && d.resolved_outcome)[0];
    if (correctedDecision) { out.set(m.id, { label: normalizeLabel(correctedDecision.resolved_outcome)!, kind: "explicit", source: "decision_corrected" }); continue; }

    // Jev's own disposition for this message (what a human would be agreeing/disagreeing with)
    const reviewLabel = reviews.length ? normalizeLabel(reviews[reviews.length - 1].disposition) : null;
    const decisionLabel = decisions.length ? normalizeLabel(decisions[decisions.length - 1].proposed_outcome) : null;
    const jevLabel = reviewLabel ?? decisionLabel;
    const raw = (x: Record<string, unknown>) => str(x.to_dispo);

    // 3. dispo_set override (or sole signal when Jev left no review/decision)
    if (sets.length) {
      if (jevLabel === null) {
        const label = normalizeLabel(raw(sets[0]));
        if (label) { out.set(m.id, { label, kind: "explicit", source: "dispo_set_72h" }); continue; }
      } else if (decisionLabel !== "new_lead" || reviewLabel !== null) {
        const diff = sets.find((s) => {
          const to = raw(s);
          if (!to) return false;
          if (jevLabel === "nurture" && to === "needs_sequence") return false;
          return normalizeLabel(to) !== jevLabel;
        });
        if (diff) { out.set(m.id, { label: normalizeLabel(raw(diff))!, kind: "explicit", source: "dispo_set_override" }); continue; }
      }
    }

    // 4. human confirmed
    const confirmedReview = reviews.find((r) => r.status === "confirmed");
    if (confirmedReview) { out.set(m.id, { label: normalizeLabel(confirmedReview.disposition)!, kind: "explicit", source: "review_confirmed" }); continue; }
    const confirmedDecision = decisions.find((d) => d.status === "confirmed" && d.auto_resolved === false);
    if (confirmedDecision) { out.set(m.id, { label: normalizeLabel(confirmedDecision.proposed_outcome)!, kind: "explicit", source: "decision_confirmed" }); continue; }

    // 5. auto-applied, old enough, never corrected
    if (at <= now.getTime() - TRUTH_WINDOW_MS) {
      const autoReview = reviews.find((r) => r.status === "auto_accepted");
      if (autoReview) { out.set(m.id, { label: normalizeLabel(autoReview.disposition)!, kind: "implicit", source: "auto_uncorrected_72h" }); continue; }
      const autoDecision = decisions.find((d) => d.status === "confirmed" && d.auto_resolved === true);
      if (autoDecision) { out.set(m.id, { label: normalizeLabel(autoDecision.proposed_outcome)!, kind: "implicit", source: "auto_uncorrected_72h" }); continue; }
    }
  }
  return out;
}
