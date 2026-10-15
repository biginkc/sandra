/**
 * Display text for the unified work queue (design v8 sections 2, 2.1, 3, 4 and 8).
 * Pure functions: WorkFacts + `now` in, strings out. Every time shows in America/Chicago.
 * The bold line always starts with the chip word, exactly as the chip is named in the toolbar.
 */
import type {
  BrokenItem,
  BrokenKind,
  WorkChip,
  WorkFacts,
  WorkLabel,
  WorkReason,
  WorkTab,
} from "./contract";

const ZONE = "America/Chicago";
const DAY_MS = 86_400_000;

/** The first words of the bold line, and the chip names, per reason. */
export const CHIP_WORDS: Record<WorkReason, string> = {
  new_lead: "New lead",
  call_today: "Call today",
  due: "Due",
  new_reply: "New reply",
  broken: "Broken",
  offer: "Offer",
  gone_quiet: "Gone quiet",
  nothing_planned: "Nothing planned",
  in_drip: "In a drip",
  texted_last: "Texted last",
  offer_out: "Offer out",
  callback_booked: "Callback booked",
  under_contract: "Under contract",
};

/** Chip button text: the reason word, or All reasons / All waiting for the catch-all chip. */
export function chipLabel(chip: WorkChip, tab: WorkTab): string {
  if (chip === "all") return tab === "waiting" ? "All waiting" : "All reasons";
  return CHIP_WORDS[chip];
}

export type HeadlineTone = "info" | "danger" | "warn" | "offer" | "calm" | "success" | "muted";

/** Colour family of the bold line, by reason. */
export const REASON_TONE: Record<WorkReason, HeadlineTone> = {
  new_lead: "info",
  call_today: "info",
  due: "danger",
  new_reply: "info",
  broken: "danger",
  offer: "warn",
  gone_quiet: "muted",
  nothing_planned: "muted",
  in_drip: "calm",
  texted_last: "calm",
  offer_out: "offer",
  callback_booked: "success",
  under_contract: "success",
};

export type RowHeadline = {
  /** The reason's chip word. `text` always starts with it. */
  chipWord: string;
  /** The whole bold line. */
  text: string;
  tone: HeadlineTone;
};

// ---------------------------------------------------------------------------
// Time helpers (America/Chicago)
// ---------------------------------------------------------------------------

type Parts = { year: number; month: number; day: number };

function chicagoParts(date: Date): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "numeric", day: "numeric" });
  const out: Record<string, number> = {};
  for (const part of f.formatToParts(date)) if (part.type !== "literal") out[part.type] = Number(part.value);
  return { year: out.year, month: out.month, day: out.day };
}

/** Whole Chicago calendar days from `a` to `b` (positive when `b` is later). */
function dayDiff(a: Date, b: Date): number {
  const pa = chicagoParts(a);
  const pb = chicagoParts(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS);
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** "2:30 PM" */
export function timeLabel(iso: string): string {
  const date = toDate(iso);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Oct 20" (adds the year when it is not the current Chicago year). */
export function dateLabel(iso: string, now: Date): string {
  const date = toDate(iso);
  if (!date) return "";
  const sameYear = chicagoParts(date).year === chicagoParts(now).year;
  return new Intl.DateTimeFormat("en-US", { timeZone: ZONE, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

function weekdayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short" }).format(date);
}

/**
 * A moment as a person would say it: "2:30 PM" today, "tomorrow 9:00 AM", "Thu 10:00 AM" within five days,
 * "yesterday 2:30 PM", otherwise "Oct 16 9:00 AM". `todayPrefix` makes today read "today 9:12 AM".
 */
export function whenLabel(iso: string, now: Date, options: { todayPrefix?: boolean } = {}): string {
  const date = toDate(iso);
  if (!date) return "";
  const time = timeLabel(iso);
  const diff = dayDiff(now, date);
  if (diff === 0) return options.todayPrefix ? `today ${time}` : time;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  if (diff >= 2 && diff <= 5) return `${weekdayLabel(date)} ${time}`;
  return `${dateLabel(iso, now)} ${time}`;
}

/** "Mon" within the last five days, "today", otherwise "Oct 9". */
function dayWord(iso: string, now: Date): string {
  const date = toDate(iso);
  if (!date) return "";
  const diff = dayDiff(date, now);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff >= 2 && diff <= 5) return weekdayLabel(date);
  return dateLabel(iso, now);
}

/** "just now", "2m ago", "3h ago", "2d ago". */
export function agoLabel(iso: string, now: Date): string {
  const date = toDate(iso);
  if (!date) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${dayDiff(date, now)}d ago`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whole Chicago days since `iso` (never negative). */
function daysSince(iso: string, now: Date): number {
  const date = toDate(iso);
  return date ? Math.max(0, dayDiff(date, now)) : 0;
}

/** "assigned today" / "assigned 3d ago"; null when the assignment time is unknown. */
export function assignedLabel(assignedAt: string | null, now: Date): string | null {
  if (!assignedAt || !toDate(assignedAt)) return null;
  const days = daysSince(assignedAt, now);
  return days === 0 ? "assigned today" : `assigned ${days}d ago`;
}

// ---------------------------------------------------------------------------
// Headline field readers (the headline jsonb varies by decision row)
// ---------------------------------------------------------------------------

const str = (h: Record<string, unknown>, key: string): string | null => (typeof h[key] === "string" ? (h[key] as string) : null);
const bool = (h: Record<string, unknown>, key: string): boolean => h[key] === true;
const num = (h: Record<string, unknown>, key: string): number | null => (typeof h[key] === "number" && Number.isFinite(h[key]) ? (h[key] as number) : null);

/** "text 2 of 4" / "text 2" (total unknown) / "a text". */
function textNofM(step: number | null | undefined, total: number | null | undefined): string {
  if (!step) return "a text";
  return total ? `text ${step} of ${total}` : `text ${step}`;
}

/** The part after "Broken · " for one broken item (design section 2.1). */
export function brokenText(kind: BrokenKind, facts: Pick<WorkFacts, "drip">): string {
  switch (kind) {
    case "drip_paused": {
      const drip = facts.drip;
      return `drip couldn't send ${textNofM(drip?.step, drip?.stepsTotal)}`;
    }
    case "drip_stuck": return "drip is stuck";
    case "followup_text_not_sent": return "follow-up text not sent";
    case "followup_text_not_delivered": return "follow-up text didn't deliver";
    case "followup_text_status_unknown": return "follow-up text status unknown";
    case "followup_text_blocked": return "follow-up text blocked";
    case "text_not_sent": return "text didn't send";
    case "text_not_delivered": return "text didn't deliver";
    case "text_status_unknown": return "text status unknown";
    case "text_blocked": return "text blocked";
    case "scheduled_text_overdue": return "scheduled text overdue";
    case "ai_reply_failed": return "AI reply failed";
    case "norma_needs_review": return "Norma call needs review";
  }
}

// ---------------------------------------------------------------------------
// The bold line
// ---------------------------------------------------------------------------

/** The kind word of a due task: callback, appointment or offer follow-up (callback when the task kind is unknown). */
function taskWord(h: Record<string, unknown>): string {
  const kind = str(h, "taskKind");
  if (kind === "appointment") return "appointment";
  if (kind === "offer_follow_up") return "offer follow-up";
  return "callback";
}

const SNOOZED = " (snoozed)";
const snoozedSuffix = (h: Record<string, unknown>): string => (bool(h, "snoozed") ? SNOOZED : "");

function dueText(h: Record<string, unknown>, now: Date): string {
  const at = str(h, "at");
  const word = taskWord(h);
  const snoozed = snoozedSuffix(h);
  if (!at) return `Due${snoozed}`;
  if (bool(h, "soon")) return `Due soon · ${word} ${whenLabel(at, now)}${snoozed}`;
  const date = toDate(at);
  if (!date) return `Due${snoozed}`;
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes >= 1 && minutes < 60) return `Due · ${word} ${minutes} min overdue${snoozed}`;
  const days = dayDiff(date, now);
  if (days >= 1) return `Due · ${word} ${plural(days, "day")} overdue${snoozed}`;
  return `Due · ${word} ${timeLabel(at)}${snoozed}`;
}

function dripRunningText(facts: WorkFacts, h: Record<string, unknown>, now: Date): string {
  const nextRunAt = str(h, "nextRunAt");
  const scheduledAt = str(h, "scheduledAt");
  const drip = facts.drip;
  const total = drip?.stepsTotal ?? null;
  if (bool(h, "callInProgress")) {
    const resumeBy = str(h, "resumeBy");
    return `In a drip · call in progress${resumeBy ? `, resumes by ${whenLabel(resumeBy, now)}` : ""}`;
  }
  if (nextRunAt) {
    const parts = ["In a drip"];
    if (drip?.name) parts.push(drip.name);
    if (drip?.lastSentAt) {
      const sentCount = Math.max((drip.step ?? 1) - 1, 0);
      parts.push(sentCount > 0
        ? `${textNofM(sentCount, total)} sent ${dayWord(drip.lastSentAt, now)}`
        : `last text sent ${dayWord(drip.lastSentAt, now)}`);
      parts.push(`next ${whenLabel(nextRunAt, now)}`);
    } else {
      parts.push(`starts ${whenLabel(nextRunAt, now)}`);
      parts.push(textNofM(drip?.step ?? 1, total));
    }
    return parts.join(" · ");
  }
  if (scheduledAt) return `In a drip · Text scheduled ${whenLabel(scheduledAt, now)}`;
  return drip?.name ? `In a drip · ${drip.name}` : "In a drip";
}

/** The bold reason line for a row. `text` starts with `chipWord`. */
export function rowHeadline(facts: WorkFacts, now: Date): RowHeadline {
  const chipWord = CHIP_WORDS[facts.reason];
  const tone = REASON_TONE[facts.reason];
  const h = (facts.headline ?? {}) as Record<string, unknown>;
  const make = (text: string): RowHeadline => ({ chipWord, text, tone });

  switch (facts.rowNo) {
    case "1": {
      const signedAt = facts.contractSignedAt;
      return make(signedAt && toDate(signedAt) ? `Under contract · signed ${dateLabel(signedAt, now)}` : "Under contract");
    }
    case "2": {
      const pinnedAt = str(h, "pinnedAt");
      if (!pinnedAt) return make("Call today");
      const date = toDate(pinnedAt);
      const same = date ? dayDiff(date, now) === 0 : false;
      return make(`Call today · you pinned this ${same ? `at ${timeLabel(pinnedAt)}` : whenLabel(pinnedAt, now)}`);
    }
    case "3": {
      const assigned = assignedLabel(str(h, "assignedAt"), now);
      return make(`New lead · ${assigned ? `${assigned}, ` : ""}not called yet${bool(h, "firstCallOverdue") ? " · first call overdue" : ""}`);
    }
    case "4":
      return make(dueText(h, now));
    case "9": {
      const days = num(h, "overdueDays");
      const word = taskWord(h);
      return make(days === null ? `Due · missed ${word}${snoozedSuffix(h)}` : `Due · ${word} ${plural(days, "day")} overdue${snoozedSuffix(h)}`);
    }
    case "5": {
      const at = str(h, "at");
      const missedCall = h.kind === "call";
      if (!at) return make("New reply");
      return make(`New reply · ${missedCall ? `missed call ${whenLabel(at, now)}` : whenLabel(at, now, { todayPrefix: true })}`);
    }
    case "6": {
      const kind = (str(h, "kind") ?? facts.broken[0]?.kind) as BrokenKind | undefined;
      return make(kind ? `Broken · ${brokenText(kind, facts)}` : "Broken");
    }
    case "6a":
      return make("Nothing planned (Text waiting for you to send)");
    case "7": {
      const since = str(h, "since");
      if (!since) return make("Offer · marked ready, no offer logged");
      const days = daysSince(since, now);
      return make(`Offer · you marked them ready ${days === 0 ? "today" : `${plural(days, "day")} ago`}`);
    }
    case "8": {
      const at = str(h, "at");
      if (h.kind === "follow_up_missing" || !at) return make("Offer · follow-up missing");
      return make(`Offer · follow-up due ${whenLabel(at, now)}`);
    }
    case "10":
      return make(dripRunningText(facts, h, now));
    case "11": {
      const at = str(h, "at");
      if (facts.reason === "offer_out") return make(`Offer out${at ? ` · follow-up ${dateLabel(at, now)}` : ""}`);
      return make(`Callback booked${at ? ` · ${whenLabel(at, now)}` : ""}${snoozedSuffix(h)}`);
    }
    case "12": {
      const at = str(h, "at");
      return make(`Offer out${at ? ` · follow-up ${dateLabel(at, now)}` : ""}`);
    }
    case "13": {
      const at = str(h, "at");
      const ago = at ? agoLabel(at, now) : "";
      const by = str(h, "by");
      const who = by === "human" ? "you texted" : by === "ai" ? "Sandra replied" : "campaign text sent";
      return make(`Texted last${ago ? ` · ${who} ${ago}` : ""}`);
    }
    case "14": {
      const at = str(h, "at");
      if (h.kind === "drip_finished" && at) {
        return make(`Gone quiet · drip finished ${dateLabel(at, now)}, no reply in ${plural(daysSince(at, now), "day")}`);
      }
      return make("Gone quiet · no reply in 3 business days");
    }
    default:
      return make(h.variant === "check_texts" ? "Nothing planned (check texts)" : "Nothing planned");
  }
}

// ---------------------------------------------------------------------------
// Label chips ("Norma calling", "No phone", ...)
// ---------------------------------------------------------------------------

export type LabelChip = { key: WorkLabel; text: string; tone: HeadlineTone };

/**
 * Chips that never change placement. A label the bold line already says is left out
 * (the Broken line carries the broken label; "Text waiting for you to send" and "check texts" ride in the
 * Nothing planned line).
 */
export function labelChips(facts: WorkFacts): LabelChip[] {
  const h = (facts.headline ?? {}) as Record<string, unknown>;
  const out: LabelChip[] = [];
  for (const label of facts.labels) {
    switch (label) {
      case "norma_calling": out.push({ key: label, text: "Norma calling", tone: "info" }); break;
      case "norma_task": out.push({ key: label, text: "Norma task", tone: "muted" }); break;
      case "do_not_contact": out.push({ key: label, text: "Do not contact", tone: "danger" }); break;
      case "text_waiting":
        if (facts.rowNo !== "6a") out.push({ key: label, text: "Text waiting for you to send", tone: "warn" });
        break;
      case "check_texts":
        if (!(facts.rowNo === "15" && h.variant === "check_texts")) out.push({ key: label, text: "check texts", tone: "warn" });
        break;
      case "broken": {
        if (facts.rowNo === "6") break;
        const first = facts.broken[0];
        out.push({ key: label, text: first ? `Broken · ${brokenText(first.kind, facts)}` : "Broken", tone: "danger" });
        break;
      }
      case "ai_draft_waiting": out.push({ key: label, text: "AI reply needs your OK", tone: "warn" }); break;
      case "no_phone": out.push({ key: label, text: "No phone", tone: "danger" }); break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expanded row: labeled lines
// ---------------------------------------------------------------------------

export type LineLabel = "DRIP" | "NEXT STEP" | "LAST TOUCH" | "ATTEMPTS" | "MOTIVATION" | "PHONE" | "CLEARS";
export type LabeledLine = { label: LineLabel; text: string; tone?: HeadlineTone };

/** Why a paused drip is paused, in the owner's words (design-owner answer 3). */
const PAUSED_PHRASE: Record<string, string> = {
  inbound_reply: "paused — they replied",
  appointment_booked: "paused — callback booked",
  call_in_progress: "paused while you call",
  manual: "paused by you",
  rep_sms_human_takeover: "paused by you",
  norma_call: "paused — Norma call",
  person_took_over: "paused — needs a person",
};
/** Pause reasons that mean the drip hit a problem. */
const PROBLEM_PAUSES = new Set([
  "provider_failed", "reconciliation_required", "template_missing", "step_misconfigured",
  "no_phone", "consent_unavailable", "no_approved_sender",
]);

/** DRIP line: "none", "starts Thu 10:00 AM · Warm check-in", "running · text 2 of 4 · next Fri 10:00 AM", paused / stopped / finished. */
export function dripLine(facts: WorkFacts, now: Date): string {
  const drip = facts.drip;
  if (!drip) return "none";
  switch (drip.status) {
    case "active": {
      if (!drip.nextRunAt) return "running";
      if (!drip.lastSentAt && (drip.step ?? 1) <= 1) {
        return `starts ${whenLabel(drip.nextRunAt, now)}${drip.name ? ` · ${drip.name}` : ""}`;
      }
      return `running · ${textNofM(drip.step, drip.stepsTotal)} · next ${whenLabel(drip.nextRunAt, now)}`;
    }
    case "paused": {
      const problem = facts.broken.some((item) => item.kind === "drip_paused") || (drip.pauseReason !== null && PROBLEM_PAUSES.has(drip.pauseReason));
      if (problem) return "stopped on a problem";
      return (drip.pauseReason && PAUSED_PHRASE[drip.pauseReason]) || "paused";
    }
    case "completed":
      return `finished${drip.completedAt ? ` ${dateLabel(drip.completedAt, now)}` : ""}, no reply`;
    case "opted_out":
      return "stopped, seller opted out";
    default:
      return drip.status;
  }
}

/** LAST TOUCH: what it was and when. "drip text" and "campaign text" give the weekday; the rest are relative. */
export function lastTouchLine(facts: WorkFacts, now: Date): string {
  const touch = facts.lastTouch;
  if (!touch || !toDate(touch.at)) return facts.lastTouchAt ? agoLabel(facts.lastTouchAt, now) : "none yet";
  const ago = agoLabel(touch.at, now);
  switch (touch.kind) {
    case "your_text": return `your text · ${ago}`;
    case "sandra_reply": return `Sandra's reply · ${ago}`;
    case "drip_text": return `drip text · ${weekdayLabel(toDate(touch.at) as Date)}`;
    case "campaign_text": return `campaign text · ${weekdayLabel(toDate(touch.at) as Date)}`;
    case "call_reached": return `call, reached · ${ago}`;
    case "call_no_answer": return `call, no answer · ${ago}`;
    case "voicemail": return `voicemail · ${ago}`;
    case "note": return `note · ${ago}`;
    case "other": return ago;
  }
}

function nextStepLine(facts: WorkFacts, now: Date): string {
  const parts: string[] = [];
  const next = facts.nextStep;
  if (next?.callbackAt) parts.push(`${facts.row.nextStepType === "appointment" ? "Appointment" : "Callback"} ${whenLabel(next.callbackAt, now)}`);
  if (next?.offerFollowUpAt) parts.push(`Offer follow-up ${whenLabel(next.offerFollowUpAt, now)}`);
  return parts.length ? parts.join(" · ") : "None";
}

function motivationLine(facts: WorkFacts): string {
  const { temperature, motivationKind, motivationText } = facts.row;
  const temp = temperature ? temperature.charAt(0).toUpperCase() + temperature.slice(1) : null;
  if (motivationKind === "specified") return [temp, motivationText].filter(Boolean).join(" · ") || "Motivation provided";
  if (motivationKind === "no_motivation") return temp ? `${temp} · No motivation provided` : "No motivation provided";
  return temp ?? "Not asked yet";
}

/** The labeled lines of the expanded row, in design order. CLEARS appears only on Call today. */
export function expandedLines(facts: WorkFacts, now: Date): LabeledLine[] {
  const lines: LabeledLine[] = [
    { label: "DRIP", text: dripLine(facts, now) },
    { label: "NEXT STEP", text: nextStepLine(facts, now) },
    { label: "LAST TOUCH", text: lastTouchLine(facts, now) },
  ];
  const assigned = assignedLabel(facts.assignedAt, now);
  lines.push({ label: "ATTEMPTS", text: `${plural(facts.attemptsCount, "attempt")}${assigned ? ` · ${assigned}` : ""}` });
  const phoneProblems = [!facts.hasPhone ? "No phone number" : null, facts.contactDnc ? "Do not contact" : null].filter((v): v is string => Boolean(v));
  if (phoneProblems.length) lines.push({ label: "PHONE", text: phoneProblems.join(" · "), tone: "danger" });
  else lines.push({ label: "MOTIVATION", text: motivationLine(facts) });
  if (facts.reason === "call_today") lines.push({ label: "CLEARS", text: "when you log the call · Undo" });
  return lines;
}

/** Every broken item, for the expanded view (the first one is the headline). */
export function brokenLines(facts: WorkFacts, now: Date): { item: BrokenItem; text: string }[] {
  return facts.broken.map((item) => ({
    item,
    text: `${brokenText(item.kind, facts)}${item.at ? ` · ${whenLabel(item.at, now, { todayPrefix: true })}` : ""}`,
  }));
}
