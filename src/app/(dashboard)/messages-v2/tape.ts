/**
 * Plain-English reading of a pipeline run for the Messages v2 tape.
 *
 * Display only: this maps the engine's words (outcomes, escalation reasons,
 * terminal steps) to the tape vocabulary and one plain sentence. It never
 * decides anything and never surfaces step names such as `claim` or
 * `resolve_threshold`.
 */
import { dripEnrollmentSummary } from "./run-card";
import type { PipelineRunStep, RunWithSteps } from "./types";

export type TapeTone = "hot" | "no" | "later" | "who" | "stop" | "unclear";
export type TapeTag = { label: string; tone: TapeTone };

const TAGS = {
  offer: { label: "Wants an offer", tone: "hot" },
  price: { label: "Talked price", tone: "hot" },
  later: { label: "Maybe later", tone: "later" },
  no: { label: "Not interested", tone: "no" },
  wrong: { label: "Wrong person", tone: "no" },
  stop: { label: "Asked to stop", tone: "stop" },
  hostile: { label: "Hostile", tone: "stop" },
  unclear: { label: "Can't read it", tone: "unclear" },
} as const satisfies Record<string, TapeTag>;

/** Engine word (Jev outcome or escalation reason) to its tape tag; null when unknown. */
export function tapeTagForWord(word: string | null | undefined): TapeTag | null {
  switch (word) {
    case "new_lead":
    case "new_lead_promoted":
    case "hot_lead":
    case "call_request":
      return TAGS.offer;
    case "price_or_offer":
    case "price_offer":
      return TAGS.price;
    case "nurture":
      return TAGS.later;
    case "not_interested":
      return TAGS.no;
    case "wrong_number":
      return TAGS.wrong;
    case "opted_out":
    case "opt_out":
    case "dnc":
    case "threat_dnc":
      return TAGS.stop;
    case "hostile_needs_confirm":
      return TAGS.hostile;
    case "unclear":
    case "bad_number":
    case "needs_review":
      return TAGS.unclear;
    default:
      return null;
  }
}

/** "model:price_or_offer", "keyword:price_offer", "jev_below_threshold:nurture", "hostile_needs_confirm:<id>" -> the word that matters. */
export function reasonWord(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const parts = reason.split(":");
  if (parts[0] === "model" || parts[0] === "keyword" || parts[0] === "jev_below_threshold") {
    return parts[1] ?? null;
  }
  return parts[0] || null;
}

const hasStep = (steps: readonly PipelineRunStep[], name: string, result?: PipelineRunStep["result"]) =>
  steps.some((s) => s.name === name && (result === undefined || s.result === result));

function classifyOutcome(steps: readonly PipelineRunStep[]): string | null {
  const step = steps.find((s) => s.kind === "jev" && s.name === "classify");
  const outcome = step?.detail?.outcome;
  return typeof outcome === "string" ? outcome : null;
}

/** The tag for a run: escalation reason first (it is more specific), then the classifier outcome, then the terminal action. */
export function tapeTagForRun(run: Pick<RunWithSteps, "reason" | "steps">, pinnedReason?: string | null): TapeTag | null {
  // A reason frozen by the waiting-list snapshot beats anything the run itself says (old reason or old outcome).
  const pinned = pinnedReason ? tapeTagForWord(reasonWord(pinnedReason)) : null;
  if (pinned) return pinned;
  const word = reasonWord(run.reason);
  if (word === "price_or_offer" || word === "price_offer" || word === "hot_lead" || word === "call_request" || word === "hostile_needs_confirm") {
    return tapeTagForWord(word);
  }
  const fromClassifier = tapeTagForWord(classifyOutcome(run.steps));
  if (fromClassifier) return fromClassifier;
  const fromReason = tapeTagForWord(word);
  if (fromReason) return fromReason;
  if (hasStep(run.steps, "promote_new_lead", "applied")) return TAGS.offer;
  if (hasStep(run.steps, "apply_nurture", "applied")) return TAGS.later;
  for (const name of ["not_interested", "wrong_number", "opted_out"]) {
    if (hasStep(run.steps, name, "applied")) return tapeTagForWord(name);
  }
  return null;
}

export type TapeStage = "reading" | "decided" | "replying" | "sent" | "waiting";

export type TapeView =
  | { kind: "reading" }
  | { kind: "quiet"; text: string }
  | { kind: "error"; sentence: string }
  | {
      kind: "decided";
      tag: TapeTag | null;
      stage: TapeStage;
      sentence: string;
      /** The "what she did" line; null while nothing has happened yet. */
      did: string | null;
    };

const TERMINAL: ReadonlySet<string> = new Set(["replied", "held", "escalated", "closed", "skipped", "error"]);

function quietSkip(run: RunWithSteps): string {
  const blob = [run.reason ?? "", ...run.steps.filter((s) => s.kind === "gate" && s.result === "block").map((s) => s.name)].join(" ");
  if (blob.includes("already_terminal")) return "Already a lead, left for the person who owns it";
  if (blob.includes("no_property")) return "Couldn't match this number to a property, so Sandra left it alone";
  if (blob.includes("takeover") || blob.includes("rep_sms")) return "A person took over this thread, so Sandra stayed out";
  if (blob.includes("business_hours") || blob.includes("quiet_hours") || blob.includes("outside")) return "Outside business hours, so Sandra didn't reply";
  return "Sandra left this one alone";
}

function didLine(run: RunWithSteps, stage: TapeStage, replySent: boolean): string | null {
  const parts: string[] = [];
  if (stage === "replying") return "Replying in a few minutes, like a person would";
  if (replySent) parts.push("Reply sent");
  const drip = run.steps.map(dripEnrollmentSummary).find((s) => s !== null);
  if (drip) parts.push(`Drip started: ${drip}`);
  if (hasStep(run.steps, "promote_new_lead", "applied")) parts.push("Marked as a lead");
  if (!replySent && !drip && hasStep(run.steps, "opted_out", "applied")) parts.push("Stopped texting this number");
  if (parts.length === 0 && stage === "waiting") parts.push('Moved to "Waiting for a person"');
  if (parts.length === 0 && (hasStep(run.steps, "not_interested", "applied") || hasStep(run.steps, "wrong_number", "applied"))) {
    parts.push("Closed it");
  }
  return parts.length ? parts.join(" · ") : null;
}

function sentenceFor(tag: TapeTag | null, who: string, o: { replySent: boolean; closed: boolean; waiting: boolean; handed: boolean }): string {
  if (!tag) return o.replySent ? "Sent a reply." : o.waiting ? "Nothing sent. Left for a person." : "Looked at this one.";
  if (o.waiting && tag.tone !== "stop" && tag.tone !== "unclear") {
    return `${who} ${tag.label === "Talked price" ? "asked about price" : tag.label === "Wants an offer" ? "might want an offer" : "replied"}. Nothing sent. Left for a person.`;
  }
  switch (tag.label) {
    case "Wants an offer":
      return `${who} is open to selling. That's a hot seller.`;
    case "Talked price":
      return `${who} talked price. That's a hot seller.`;
    case "Maybe later":
      return o.replySent ? `${who} might sell later, not now. Sent the reply.` : `${who} might sell later, not now.`;
    case "Not interested":
      return o.replySent && o.closed ? `${who} said no. Sent the thank-you and closed it.` : o.closed ? `${who} said no. Closed it.` : `${who} said no.`;
    case "Wrong person":
      return o.replySent && o.closed ? `${who} isn't the owner. Sent the reply and closed it.` : o.closed ? `${who} isn't the owner. Closed it.` : `${who} isn't the owner.`;
    case "Asked to stop":
      return o.waiting ? `${who} asked to stop. Nothing sent.` : `${who} asked to stop. Stopped texting this number.`;
    case "Hostile":
      return "That text was hostile. Nothing sent.";
    case "Can't read it":
      return `I can't tell what ${who === "They" ? "they mean" : `${who} means`}. Nothing sent.`;
    default:
      return `${who} replied.`;
  }
}

/**
 * The ONE effective reason for a held run: the run's own reason, else the property's flag reason.
 * Both the tape card and the "Waiting for a person" card read it from here, so they cannot disagree.
 */
/** The neutral tag for a waiting hold whose snapshot reason is empty or not one Sandra has words for. */
export const NEUTRAL_TAG: TapeTag = { label: "Waits for a person", tone: "unclear" };
export const pinnedTag = (reason: string | null | undefined): TapeTag => tapeTagForWord(reasonWord(reason)) ?? NEUTRAL_TAG;

export function withEffectiveReason<T extends { reason: string | null }>(run: T, flagReason?: string | null): T {
  return run.reason || !flagReason ? run : { ...run, reason: flagReason };
}

/** Plain-English view of one run, ready for the tape card. `who` is the seller's first name, or "They". `flagReason` is the hold's flag reason when this run is the hold's current run. */
export function deriveTape(rawRun: RunWithSteps, who: string, flagReason?: string | null, pinned = false): TapeView {
  // `pinned`: the reason is the waiting-list snapshot's, and it wins over the run's own reason and outcome.
  const run = pinned ? { ...rawRun, reason: flagReason ?? null } : withEffectiveReason(rawRun, flagReason);
  if (run.status === "skipped") return { kind: "quiet", text: quietSkip(run) };
  if (run.status === "error") return { kind: "error", sentence: "Something went wrong reading this one. A person should take a look." };

  // Pinned: the snapshot reason is the ONLY source of the tag. Null or unmapped -> the neutral tag, never the run's
  // old reason or classifier outcome (so the tape cannot say more than the card).
  const tag = pinned ? pinnedTag(flagReason) : tapeTagForRun(run);
  const terminal = TERMINAL.has(run.status);
  const delayed = hasStep(run.steps, "reply_delay_scheduled", "applied");
  const replySent = run.status === "replied" || run.steps.some((s) => s.kind === "reply" && s.result === "sent");

  if (!terminal) {
    if (!tag && !delayed) return { kind: "reading" };
    const stage: TapeStage = delayed && !replySent ? "replying" : replySent ? "sent" : "decided";
    return {
      kind: "decided",
      tag,
      stage,
      sentence: sentenceFor(tag, who, { replySent, closed: false, waiting: false, handed: false }),
      did: didLine(run, stage, replySent),
    };
  }

  const waiting = run.status === "held" || run.status === "escalated";
  const closed =
    run.status === "closed" ||
    hasStep(run.steps, "not_interested", "applied") ||
    hasStep(run.steps, "wrong_number", "applied");
  const handed = hasStep(run.steps, "promote_new_lead", "applied");
  const stage: TapeStage = waiting ? "waiting" : replySent ? "sent" : "decided";
  return {
    kind: "decided",
    tag,
    stage,
    // A held run reads exactly like its card in "Waiting for a person": what Sandra thought and why it waited.
    sentence:
      pinned || (waiting && !handed)
        ? holdReasonSentence(run, run.reason, who, pinned)
        : sentenceFor(tag, who, { replySent, closed, waiting: false, handed }),
    did: didLine(run, stage, replySent),
  };
}

/** Plain reason sentence for a hold in the "Waiting for a person" column. */
export function holdReasonSentence(
  run: Pick<RunWithSteps, "reason" | "steps"> | null,
  flagReason: string | null | undefined,
  who: string,
  pinned = false,
): string {
  // Pinned: only the snapshot reason counts (null or unmapped -> the neutral sentence).
  const tag = pinned ? null : run ? tapeTagForRun(run) : null;
  const word = reasonWord(flagReason);
  const t = tag ?? tapeTagForWord(word);
  switch (t?.label) {
    case "Asked to stop":
      return `${who} asked to stop. Nothing sent.`;
    case "Hostile":
      return "Hostile text. Nothing sent.";
    case "Can't read it":
      return `I can't tell what ${who === "They" ? "they mean" : `${who} means`}. Nothing sent.`;
    case "Talked price":
      return `${who} asked about price. Nothing sent.`;
    case "Wants an offer":
      return `${who} may want an offer. Nothing sent.`;
    case "Maybe later":
      return `${who} might sell later. Not sure enough to act, so it waits.`;
    case "Not interested":
      return `${who} may have said no. Not sure enough to close it.`;
    case "Wrong person":
      return `${who} may not be the owner. Not sure enough to close it.`;
    default:
      return "Needs a person to look at it. Nothing sent.";
  }
}
