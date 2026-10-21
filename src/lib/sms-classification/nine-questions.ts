import { askJev, JevProviderError, type JevAskDeps, type JevNoulQuestion } from "./providers/jev-gateway";

/**
 * Jarrad's nine yes/no questions (Messages v2 redesign, PR 3).
 *
 * The question texts, the 0.6 cutoff and the tie-breaker order are business
 * rules approved by Jarrad word for word (memory note `jev-approved-questions`,
 * 2026-10-14). No LLM or engineer may edit, reword, add or remove one without a
 * human approving that exact text. `nine-questions.test.ts` pins every byte.
 */
export const NINE_QUESTION_IDS = [
  "open_to_selling",
  "maybe_later",
  "asked_who",
  "not_interested",
  "wrong_person",
  "asked_stop",
  "hostile",
  "confirmed_owner",
  "talked_price",
  // Added 2026-10-20 (approved verbatim by Jarrad); asked in the same single Jev call.
  "asked_offer",
  "named_price",
  "asked_call",
] as const;

export type NineQuestionId = (typeof NINE_QUESTION_IDS)[number];

export const NINE_QUESTIONS: Record<NineQuestionId, string> = {
  open_to_selling: "Did the homeowner say they are open to selling the property or want an offer?",
  maybe_later: "Did the homeowner say they might sell later, but not right now?",
  asked_who: "Did the homeowner ask who is texting them or why?",
  not_interested: "Did the homeowner say they are not interested in selling?",
  wrong_person: "Did the homeowner say we have the wrong person, or that they don't own the property?",
  asked_stop: "Did the homeowner ask to stop receiving texts?",
  hostile: "Was the homeowner rude or hostile?",
  confirmed_owner: "Did the homeowner confirm they are the person or owner we asked about?",
  talked_price: "Did the homeowner mention a price or ask how much we would pay?",
  asked_offer: "Did the homeowner ask what our offer is or how much we would pay?",
  named_price: "Did the homeowner name a price or amount they want?",
  asked_call: "Did the homeowner ask us to call them or give a time to talk?",
};

/** A "yes" needs at least this probability (Jarrad 2026-10-14). */
export const NINE_QUESTION_CUTOFF = 0.6;

/**
 * First yes wins, in this order. `asked_stop` and `hostile` share the top group;
 * inside it the higher probability is reported, ties go to `asked_stop`. Both
 * lead to the same action (wait for a person).
 *
 * Order history: Jarrad set the original order 2026-10-14. On 2026-10-20 he
 * approved the three new questions (asked_call, asked_offer, named_price) and
 * delegated their place in the order to Claude, based on a replay of 252 real
 * seller replies (asked_offer 96% accurate, named_price 98%, asked_call 100%).
 * Stop / hostile / wrong person still beat every reply.
 */
export const NINE_QUESTION_GROUPS: ReadonlyArray<ReadonlyArray<NineQuestionId>> = [
  ["asked_stop", "hostile"],
  ["wrong_person"],
  ["asked_call"],
  ["asked_offer"],
  ["named_price"],
  ["talked_price"],
  ["open_to_selling"],
  ["maybe_later"],
  ["not_interested"],
  ["asked_who"],
  ["confirmed_owner"],
];

/** No question reached the cutoff: a person reads it ("Can't read it"). */
export type NineAnswer = NineQuestionId | "needs_person";

export type NineQuestionDecision = {
  answer: NineAnswer;
  /** Probability of "yes" per question; null when Jev returned nothing usable. */
  probabilities: Record<NineQuestionId, number | null>;
  /** The winning question's probability; null for needs_person. */
  chosen: { id: NineQuestionId; probability: number } | null;
  cutoff: number;
};

export type NineQuestionState = {
  our_last_text_to_homeowner: string | null;
  homeowner_reply: string;
};

const probability = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;

/** Pure tie-breaker. Missing/invalid probabilities are never a yes (fail closed). */
export function decideNineQuestions(
  raw: Partial<Record<NineQuestionId, unknown>>,
  cutoff: number = NINE_QUESTION_CUTOFF,
): NineQuestionDecision {
  const probabilities = Object.fromEntries(
    NINE_QUESTION_IDS.map((id) => [id, probability(raw[id])]),
  ) as Record<NineQuestionId, number | null>;
  for (const group of NINE_QUESTION_GROUPS) {
    let best: { id: NineQuestionId; probability: number } | null = null;
    for (const id of group) {
      const p = probabilities[id];
      if (p !== null && p >= cutoff && (!best || p > best.probability)) best = { id, probability: p };
    }
    if (best) return { answer: best.id, probabilities, chosen: best, cutoff };
  }
  return { answer: "needs_person", probabilities, chosen: null, cutoff };
}

export function buildNineQuestionRequest(state: NineQuestionState): {
  state: NineQuestionState;
  questions: Record<NineQuestionId, JevNoulQuestion>;
} {
  const questions = Object.fromEntries(
    NINE_QUESTION_IDS.map((id) => [id, { type: "noul", instructions: NINE_QUESTIONS[id] }]),
  ) as Record<NineQuestionId, JevNoulQuestion>;
  return { state, questions };
}

export type NineQuestionResult = NineQuestionDecision & {
  latencyMs: number;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
};

/** One HTTP call: every question (the nine plus the three added 2026-10-20) in a single System One request. */
export async function classifyNineQuestions(
  state: NineQuestionState,
  deps: JevAskDeps,
): Promise<NineQuestionResult> {
  const result = await askJev(buildNineQuestionRequest(state), deps);
  const answers = result.answers ?? {};
  const raw = Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, answers[id]?.noul]));
  // All nine must come back as numbers in [0,1]. A partial answer must never act (a missing
  // stop / hostile / wrong-person read could hide the very thing that should have won).
  const incomplete = NINE_QUESTION_IDS.filter((id) => probability(raw[id]) === null);
  if (incomplete.length > 0) {
    throw new JevProviderError(`Jev response missing or invalid answers: ${incomplete.join(",")}`, "invalid_response");
  }
  return {
    ...decideNineQuestions(raw),
    latencyMs: result.latencyMs,
    model: result.model ?? null,
    usage: result.usage
      ? { inputTokens: result.usage.input_tokens ?? null, outputTokens: result.usage.output_tokens ?? null }
      : null,
  };
}

/** Tape/card words for each answer (Jarrad's words, Messages v2 brief). */
export const NINE_ANSWER_LABELS: Record<NineAnswer, string> = {
  open_to_selling: "Wants an offer",
  maybe_later: "Maybe later",
  asked_who: "Asked who is texting",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
  asked_stop: "Asked to stop",
  hostile: "Hostile",
  confirmed_owner: "Confirmed owner",
  talked_price: "Talked price",
  asked_offer: "Asked for offer",
  named_price: "Named a price",
  asked_call: "Asked for a call", // label approved verbatim by Jarrad 2026-10-20
  needs_person: "Can't read it",
};

/**
 * Jarrad's repeat-no rule, approved word for word 2026-10-20. Shown in the rules
 * panel under "Not interested"; implemented in ai-responder/dispatch.ts
 * (routeNineRepeatNotInterested). Never reword.
 */
export const NINE_REPEAT_NOT_INTERESTED_RULE =
  "If the homeowner says no again after already getting our not-interested reply, stop their drip, mark them Not interested, and send nothing.";

export type NineRuleGroup = "jarrad" | "alone" | "person";

/** Rules-panel grouping (Jarrad 2026-10-14). */
export const NINE_ANSWER_GROUP: Record<NineQuestionId, NineRuleGroup> = {
  open_to_selling: "jarrad",
  talked_price: "jarrad",
  asked_offer: "jarrad",
  named_price: "jarrad",
  asked_call: "jarrad",
  maybe_later: "alone",
  asked_who: "alone",
  not_interested: "alone",
  wrong_person: "alone",
  confirmed_owner: "alone",
  asked_stop: "person",
  hostile: "person",
};

/**
 * Reply texts for three hot answers, approved verbatim by Jarrad 2026-10-20.
 * Character for character; never reword, add or remove (`nine-questions.test.ts`
 * pins every byte). Sent as fixed approved text by ai-responder/dispatch.ts
 * (sendNineHotReply) only after the hot hand-off succeeded.
 */
export const NINE_HOT_REPLY_TEXTS = {
  asked_offer:
    "Thanks for your reply. I'm not authorized to provide offers via SMS, but I'd love to put you in touch with an acquisitions manager. When's a good time to chat?",
  said_yes: "Fantastic. When's a good time for a quick call with an acquisitions manager?",
  named_price: "Thanks, I'll update our records. When's a good time for a quick call with an acquisitions manager?",
} as const;

export type NineHotReply = keyof typeof NINE_HOT_REPLY_TEXTS;

/** The approved names of the three reply texts (Jarrad 2026-10-20). */
export const NINE_HOT_REPLY_NAMES: Record<NineHotReply, string> = {
  asked_offer: "Asked for offer",
  said_yes: "Said yes",
  named_price: "Named a price",
};

/** What Sandra does for each answer (ACTIONS, Jarrad 2026-10-14/15/20). */
export type NineAction =
  | { kind: "hot"; reply: NineHotReply | null }
  | { kind: "reply_and_drip"; reply: "nurture" | "identity" | "not_interested"; drip: NineDripName; skipFirstStep: boolean }
  | { kind: "drip_only"; drip: NineDripName }
  | { kind: "reply_and_close_wrong_person" }
  | { kind: "wait_for_person"; reason: "asked_stop" | "hostile" | "needs_person" };

/** Exact names of Jarrad's drips in the `sequences` table. */
export type NineDripName = "Maybe later" | "Asked who is texting" | "Not interested" | "Confirmed owner";

export function actionForNineAnswer(answer: NineAnswer): NineAction {
  switch (answer) {
    case "open_to_selling":
      return { kind: "hot", reply: "said_yes" };
    case "asked_offer":
      return { kind: "hot", reply: "asked_offer" };
    case "named_price":
      return { kind: "hot", reply: "named_price" };
    case "asked_call":
    case "talked_price":
      return { kind: "hot", reply: null };
    case "maybe_later":
      return { kind: "reply_and_drip", reply: "nurture", drip: "Maybe later", skipFirstStep: false };
    case "asked_who":
      return { kind: "reply_and_drip", reply: "identity", drip: "Asked who is texting", skipFirstStep: true };
    case "not_interested":
      return { kind: "reply_and_drip", reply: "not_interested", drip: "Not interested", skipFirstStep: false };
    case "wrong_person":
      return { kind: "reply_and_close_wrong_person" };
    case "confirmed_owner":
      return { kind: "drip_only", drip: "Confirmed owner" };
    case "asked_stop":
    case "hostile":
    case "needs_person":
      return { kind: "wait_for_person", reason: answer };
  }
}
