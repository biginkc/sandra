import type { SupabaseClient } from "@supabase/supabase-js";

import { err, ok, type Result } from "@/lib/errors/result";
import type { Database } from "@/lib/supabase/types";

type Admin = SupabaseClient<Database>;
type ItemSource = "ai_disposition_review" | "jev_lead_decision";

export type LunaResolveDeps = {
  /** Service-role client (luna_suggestions writes). */
  admin: Admin;
  orgId: string;
  userId: string;
  /** The EXISTING human decision paths in jev/actions.ts. */
  confirm: (source: ItemSource, id: string) => Promise<Result<{ status: string; warning?: string }>>;
  correct: (
    source: ItemSource,
    id: string,
    outcome: string,
    reason: string | null,
  ) => Promise<Result<{ status: string; resolvedOutcome: string }>>;
  reportError: (error: unknown, context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }) => void;
  now?: () => string;
};

type SuggestionRow = {
  id: string;
  org_id: string;
  inbound_message_id: string;
  outcome: string;
  accepted_at: string | null;
  rejected_at: string | null;
};

/** Outcomes that always need a person on the existing opt-out / legal confirm flow. */
export const HUMAN_CONFIRM_ONLY_OUTCOMES: ReadonlySet<string> = new Set(["opted_out", "dnc"]);
/** Outcomes the hold card can apply through the existing decision paths. */
export const APPLYABLE_OUTCOMES: ReadonlySet<string> = new Set([
  "new_lead",
  "nurture",
  "not_interested",
  "wrong_number",
]);

const fail = (code: string, message: string) => err({ code, message });

async function loadOpen(d: LunaResolveDeps, suggestionId: string): Promise<Result<SuggestionRow>> {
  const { data, error } = await d.admin
    .from("luna_suggestions")
    .select("id, org_id, inbound_message_id, outcome, accepted_at, rejected_at")
    .eq("id", suggestionId)
    .maybeSingle();
  if (error) return fail("LUNA_LOOKUP_FAILED", "Could not load that suggestion. Try again.");
  // Another org's row is indistinguishable from a missing one.
  if (!data || data.org_id !== d.orgId) return fail("LUNA_NOT_FOUND", "That suggestion no longer exists.");
  if (data.accepted_at || data.rejected_at) {
    return fail("LUNA_ALREADY_RESOLVED", "That suggestion was already handled. Refresh the page.");
  }
  return ok(data as SuggestionRow);
}

/**
 * "Apply": run Luna's pick through the SAME human decision path a person uses
 * on the held item (confirm when it matches what Jev proposed, otherwise the
 * outcome correction), then record the acceptance. Never writes a disposition
 * itself, never reaches opt-out / DNC (those stay on the human confirm flow).
 */
export async function applyLunaSuggestion(
  d: LunaResolveDeps,
  input: { suggestionId: string },
): Promise<Result<{ status: string; resolvedOutcome: string; warning?: string }>> {
  const loaded = await loadOpen(d, input.suggestionId);
  if (!loaded.ok) return loaded;
  const s = loaded.data;
  if (HUMAN_CONFIRM_ONLY_OUTCOMES.has(s.outcome)) {
    return fail(
      "LUNA_HUMAN_CONFIRM_REQUIRED",
      "Opt-out and do-not-contact need a person on the existing confirm flow. Nothing was applied.",
    );
  }
  if (!APPLYABLE_OUTCOMES.has(s.outcome)) {
    return fail("LUNA_NOT_ACTIONABLE", "That suggestion cannot be applied. Nothing was changed.");
  }

  // The pending item on the same inbound message (a decision for new_lead /
  // nurture, a disposition review for not_interested / wrong_number).
  const [decision, review] = await Promise.all([
    d.admin
      .from("jev_lead_decisions")
      .select("id, proposed_outcome")
      .eq("org_id", d.orgId)
      .eq("source_inbound_message_id", s.inbound_message_id)
      .eq("status", "pending")
      .maybeSingle(),
    d.admin
      .from("ai_disposition_reviews")
      .select("id, disposition")
      .eq("org_id", d.orgId)
      .eq("source_inbound_message_id", s.inbound_message_id)
      .eq("status", "pending")
      .maybeSingle(),
  ]);
  if (decision.error || review.error) {
    return fail("LUNA_LOOKUP_FAILED", "Could not find the pending decision. Nothing was applied.");
  }
  const item: { source: ItemSource; id: string; proposed: string } | null = decision.data
    ? { source: "jev_lead_decision", id: decision.data.id, proposed: decision.data.proposed_outcome }
    : review.data
      ? { source: "ai_disposition_review", id: review.data.id, proposed: review.data.disposition }
      : null;
  if (!item) {
    return fail("LUNA_NO_PENDING_ITEM", "Nothing is waiting on a decision for this message. Refresh the page.");
  }

  // The item can change between the lookup and the decision (superseded, already
  // handled): nothing was applied, so the suggestion must stay open and the card reloads.
  const stale = () =>
    fail("LUNA_NO_PENDING_ITEM", "Nothing is waiting on a decision for this message. Refresh the page.");
  let applied: { status: string; resolvedOutcome: string; warning?: string };
  if (item.proposed === s.outcome) {
    const confirmed = await d.confirm(item.source, item.id);
    if (!confirmed.ok) return confirmed;
    if (confirmed.data.status !== "confirmed") return stale();
    applied = { ...confirmed.data, resolvedOutcome: s.outcome };
  } else {
    const corrected = await d.correct(item.source, item.id, s.outcome, "Applied Luna suggestion");
    if (!corrected.ok) return corrected;
    if (corrected.data.status !== "corrected") return stale();
    applied = corrected.data;
  }

  // The decision already happened. Recording the acceptance must not undo or fail it.
  try {
    const { error } = await d.admin
      .from("luna_suggestions")
      .update({
        accepted_at: (d.now ?? (() => new Date().toISOString()))(),
        accepted_by: d.userId,
        applied_outcome: s.outcome,
      })
      .eq("id", s.id)
      .is("accepted_at", null)
      .is("rejected_at", null);
    if (error) throw new Error(error.message);
  } catch (e) {
    d.reportError(e, { tags: { surface: "luna_record_accept" }, extra: { suggestionId: s.id } });
  }
  return ok(applied);
}

/** "Not this": the suggestion was wrong; nothing else changes. */
export async function rejectLunaSuggestion(
  d: LunaResolveDeps,
  input: { suggestionId: string },
): Promise<Result<null>> {
  const loaded = await loadOpen(d, input.suggestionId);
  if (!loaded.ok) return loaded;
  const { data, error } = await d.admin
    .from("luna_suggestions")
    .update({ rejected_at: (d.now ?? (() => new Date().toISOString()))(), rejected_by: d.userId })
    .eq("id", loaded.data.id)
    .is("accepted_at", null)
    .is("rejected_at", null)
    .select("id");
  if (error) {
    d.reportError(new Error(error.message), { tags: { surface: "luna_record_reject" } });
    return fail("LUNA_REJECT_FAILED", "Could not record that. Try again.");
  }
  if (!Array.isArray(data) || data.length === 0) {
    return fail("LUNA_ALREADY_RESOLVED", "That suggestion was already handled. Refresh the page.");
  }
  return ok(null);
}
