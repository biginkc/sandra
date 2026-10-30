import type { JevChoiceQuestion, JevNoulQuestion } from "../providers/jev-gateway";

/**
 * SMS reply routing v2 — the question set (PR-A, shadow only).
 *
 * BUSINESS RULES. Every text below was approved by Jarrad word for word. Sources:
 * - vault note "2026-10-29 — Sandra SMS reply routing plan (Jev + Haiku)", section
 *   "Approved Jev questions" (stop = the Oct-1 wording, legal, listed, said they'll call,
 *   reason to sell, which property, location, future action, text only, how it works,
 *   property type and its five choices);
 * - memory note `jev-approved-questions` (the two opportunity questions, 2026-10-30;
 *   the FINAL "different property" wording);
 * - live `nine-questions.ts` texts reused verbatim where the same question is meant.
 * These are exactly the texts the pinned v7 replay asked Jev (scratchpad final/jev.py,
 * newq2.py, newq.py, newq6.py, newq8.py).
 *
 * No LLM or engineer may edit, reword, add or remove a text without Jarrad approving that
 * exact text. `routing-v2.test.ts` pins every byte. The live engine does NOT read this file.
 */
export const V2_QUESTION_IDS = [
  "asked_stop",
  "legal",
  "hostile",
  "wrong_person",
  "already_sold",
  "tenant",
  "listed",
  "asked_call",
  "inbound_call",
  "reason_to_sell",
  "named_price",
  "talked_price",
  "asked_offer",
  "open_to_selling",
  "maybe_later",
  "not_interested",
  "asked_who",
  "which_property",
  "where_located",
  "future_action",
  "confirmed_owner",
  "just_ok",
  "text_only",
  "how_it_works",
  "own_other_property",
  "someone_else_property",
] as const;

export type V2QuestionId = (typeof V2_QUESTION_IDS)[number];

export const V2_QUESTIONS: Record<V2QuestionId, string> = {
  asked_stop: "Did the homeowner ask to stop receiving texts?",
  legal:
    "Explicit formal/legal demand: attorney/lawyer, legal action, Do Not Call registry, TCPA, or a legal demand to cease all contact. Hostility alone is not dnc. Takes precedence over earlier selling interest.",
  hostile: "Was the homeowner rude or hostile?",
  wrong_person: "Did the homeowner say we have the wrong person, or that they don't own the property?",
  already_sold: "Did the homeowner say they already sold the property?",
  tenant: "Did the homeowner say they are a tenant who rents the property, not the owner?",
  listed: "Did the seller mention the property is listed or working with a REALTOR?",
  asked_call: "Did the homeowner ask us to call them or give a time to talk?",
  inbound_call: "Did the seller indicate that they or someone would place an inbound call to us to discuss an offer?",
  reason_to_sell:
    "Did the seller mention anything that could be causing them to sell, or a reason why they may be accepting of an offer?",
  named_price: "Did the homeowner name a price or amount they want?",
  talked_price: "Did the homeowner mention a price or ask how much we would pay?",
  asked_offer: "Did the homeowner ask what our offer is or how much we would pay?",
  open_to_selling: "Did the homeowner say they are open to selling the property or want an offer?",
  maybe_later: "Did the homeowner say they might sell later, but not right now?",
  not_interested: "Did the homeowner say they are not interested in selling?",
  asked_who: "Did the homeowner ask who is texting them or why?",
  which_property: "Is the seller unclear which property we're messaging about?",
  where_located: "Did the seller ask where our company was located or where I was calling from?",
  future_action: "Did the seller indicate they would take a future action and get back to us?",
  confirmed_owner: "Did the homeowner confirm they are the person or owner we asked about?",
  just_ok: "Did the homeowner just acknowledge or agree to our message without adding anything new?",
  text_only: "Did the seller indicate interest but only want to communicate via text messaging/SMS?",
  how_it_works: "Did the seller ask how the process works or ask about next steps?",
  own_other_property: "Did the seller mention another property that they own and are interested in selling?",
  someone_else_property:
    "Did the seller mention a different property, not the one we asked about and not one they own, that may be for sale?",
};

/** The pick-one property type question and its five approved choices. */
export const PROPERTY_TYPE_QUESTION_ID = "property_type" as const;
export const PROPERTY_TYPE_OPTIONS = ["residential", "lot", "commercial", "rental", "didnt_say"] as const;
export type PropertyTypeOption = (typeof PROPERTY_TYPE_OPTIONS)[number];

export const PROPERTY_TYPE_INSTRUCTIONS = "Did the owner indicate the property type?";
export const PROPERTY_TYPE_CHOICES: Record<PropertyTypeOption, string> = {
  residential: "Residential (house, townhouse, condo)",
  lot: "Lot or vacant land",
  commercial: "Commercial (business, church, commercial building)",
  rental: "Rental",
  didnt_say: "Didn't say",
};

export type V2State = {
  our_last_text_to_homeowner: string | null;
  homeowner_reply: string;
};

/** One Jev call: every v2 yes/no question plus the property type choice (same shape as the v7 replay). */
export function buildV2JevRequest(state: V2State): {
  state: V2State;
  questions: Record<string, JevNoulQuestion | JevChoiceQuestion>;
} {
  const questions: Record<string, JevNoulQuestion | JevChoiceQuestion> = {};
  for (const id of V2_QUESTION_IDS) questions[id] = { type: "noul", instructions: V2_QUESTIONS[id] };
  questions[PROPERTY_TYPE_QUESTION_ID] = {
    type: "choice",
    instructions: PROPERTY_TYPE_INSTRUCTIONS,
    criteria: { ...PROPERTY_TYPE_CHOICES },
  };
  return { state, questions };
}
