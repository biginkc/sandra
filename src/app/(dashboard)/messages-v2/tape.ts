/**
 * Plain-English reading of a pipeline run for the Messages v2 tape.
 *
 * Display only: this maps the engine's words (outcomes, escalation reasons,
 * terminal steps) to the tape vocabulary and one plain sentence. It never
 * decides anything and never surfaces step names such as `claim` or
 * `resolve_threshold`.
 */
import { nineTapeTag } from "./nine-tape";
import { chicagoClock } from "./chicago-time";
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
    case "not_selling":
      return TAGS.no;
    case "wrong_number":
    case "wrong_number_keyword":
      return TAGS.wrong;
    case "opted_out":
    case "opt_out":
    case "dnc":
    case "threat_dnc":
    case "optout_phrase_needs_confirm":
    case "stop_keyword":
    case "dnc_keyword":
      return TAGS.stop;
    case "hostile_needs_confirm":
    case "hostile":
      return TAGS.hostile;
    case "unclear":
    case "bad_number":
    case "needs_review":
    case "jev_unclear_no_action":
    case "low_confidence":
      return TAGS.unclear;
    case "nine_asked_stop":
      return TAGS.stop;
    case "nine_needs_person":
      return TAGS.unclear;
    case "nine_reply_not_sent":
    case "reply_text_not_approved":
      return NEUTRAL_TAG;
    default:
      return null;
  }
}

/** Reason formats whose SECOND part is the word that matters (`<prefix>:<outcome or kind>`). */
const WORD_AFTER_PREFIX = new Set(["nine_automation_disabled", "model", "keyword", "jev_below_threshold", "automation_disabled", "human_only_outcome", "not_applicable"]);

/**
 * The word that matters in an engine reason, for every format the engine writes:
 * "model:price_or_offer", "keyword:price_offer", "jev_below_threshold:nurture", "automation_disabled:<outcome>",
 * "human_only_outcome:<outcome>", "not_applicable:<outcome>" -> the second part; "hostile_needs_confirm:<id>",
 * "optout_phrase_needs_confirm:<id>", "low_confidence:0.82" -> the first part. A free-text model reason that starts
 * with "hostile" ("model:hostile sentiment, ...") reads as "hostile".
 */
export function reasonWord(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const parts = reason.split(":");
  if (WORD_AFTER_PREFIX.has(parts[0])) {
    const word = (parts[1] ?? "").trim();
    if (/^hostile\b/i.test(word)) return "hostile";
    return word || null;
  }
  return parts[0] || null;
}

const hasStep = (steps: readonly PipelineRunStep[], name: string, result?: PipelineRunStep["result"]) =>
  steps.some((s) => s.name === name && (result === undefined || s.result === result));

function classifyOutcome(steps: readonly PipelineRunStep[]): string | null {
  const step = steps.find((s) => s.kind === "jev" && s.name === "classify" && !(s.detail && "shadow_engine" in s.detail));
  const outcome = step?.detail?.outcome;
  return typeof outcome === "string" ? outcome : null;
}

/** The tag for a run: escalation reason first (it is more specific), then the classifier outcome, then the terminal action. */
export function tapeTagForRun(run: Pick<RunWithSteps, "reason" | "steps">, pinnedReason?: string | null): TapeTag | null {
  // A reason frozen by the waiting-list snapshot beats anything the run itself says (old reason or old outcome).
  const pinned = pinnedReason ? tapeTagForWord(reasonWord(pinnedReason)) : null;
  if (pinned) return pinned;
  const word = reasonWord(run.reason);
  // A hostile or hot hold says what the text IS, whichever engine ran: it beats the nine-question answer
  // (so a hostile-held text is never tagged "Maybe later").
  if (word === "price_or_offer" || word === "price_offer" || word === "hot_lead" || word === "call_request" || word === "hostile_needs_confirm" || word === "hostile") {
    return tapeTagForWord(word);
  }
  // Nine-question engine: its answer is the tag (old-engine runs fall through to the mapping below).
  const nine = nineTapeTag(run.steps);
  if (nine) return nine;
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
  const handoff = run.steps.find((s) => s.name === "assign_hot_lead" && s.result === "applied");
  const handoffStatus = (handoff?.detail as { status?: string } | null | undefined)?.status;
  if (handoffStatus === "owned_by_someone_else") {
    parts.push("Already a lead, left for the person who owns it");
  } else if (handoffStatus === "already_owned") {
    parts.push(
      run.hotAlertSentAt
        ? `Already on My Leads under Jarrad · Slack and text sent ${chicagoClock(run.hotAlertSentAt)}`
        : "Already on My Leads under Jarrad",
    );
  } else if (handoffStatus === "assigned_unrecorded") {
    const note = (handoff?.detail as { note?: string } | null | undefined)?.note ?? "";
    parts.push(
      note.startsWith("hot text")
        ? "Already on My Leads under Jarrad, but the note about it couldn't be saved"
        : "On My Leads under Jarrad, but the note about it couldn't be saved",
    );
  } else if (handoff) {
    parts.push(
      run.hotAlertSentAt
        ? `Handed to Jarrad · now on My Leads · Slack and text sent ${chicagoClock(run.hotAlertSentAt)}`
        : "Handed to Jarrad · now on My Leads",
    );
  } else if (hasStep(run.steps, "assign_hot_lead", "error")) {
    parts.push("Couldn't hand this to Jarrad, so it waits for a person");
  } else if (hasStep(run.steps, "promote_new_lead", "applied")) {
    parts.push("Marked as a lead");
  }
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
  // `pinned`: the reason is the waiting-list snapshot's frozen display reason, and it wins over the run's own reason
  // and outcome (a pinned null stays neutral).
  const run = pinned ? { ...rawRun, reason: flagReason ?? null } : withEffectiveReason(rawRun, flagReason);
  // A snapshot run reads like its card whatever the run's own status: pinned tag + sentence, and the run's
  // skipped / errored status as the separate "what she did" line.
  if (pinned && (run.status === "skipped" || run.status === "error")) {
    return {
      kind: "decided",
      tag: pinnedTag(flagReason),
      stage: "waiting",
      sentence: holdReasonSentence(run, run.reason, who, true),
      did: run.status === "skipped" ? quietSkip(run) : "Something went wrong reading this one",
    };
  }
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
      // A snapshot run reads exactly like its card, whatever its status (the status is in the "did" line).
      sentence: pinned
        ? holdReasonSentence(run, run.reason, who, true)
        : sentenceFor(tag, who, { replySent, closed: false, waiting: false, handed: false }),
      did: didLine(run, stage, replySent),
    };
  }

  const waiting = run.status === "held" || run.status === "escalated";
  const closed =
    run.status === "closed" ||
    hasStep(run.steps, "not_interested", "applied") ||
    hasStep(run.steps, "wrong_number", "applied");
  const handed = hasStep(run.steps, "promote_new_lead", "applied") && !hasStep(run.steps, "assign_hot_lead", "error");
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
  if (word === "nine_reply_not_sent" || flagReason?.endsWith(":template_already_sent")) {
    return "The reply was not sent. A person should take a look.";
  }
  if (word === "reply_text_not_approved") return "There is no approved reply for this one. A person should take a look.";
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
