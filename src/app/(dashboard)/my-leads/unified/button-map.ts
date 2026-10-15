/**
 * Which buttons a unified-queue row offers (design v8 sections 2, 2.1 and 4).
 * Everything maps onto commands that already exist: the MyLeadAction kinds, the text composer, Call today,
 * Set drip and the broken-item actions. The per-stage "More" menu mirrors ACTIONS_BY_STAGE in
 * _components/queue-row.tsx exactly (no new stage commands).
 */
import { zillowUrl } from "@/lib/utils/zillow-url";
import type { MyLeadAction, MyLeadStage } from "../_components/types";
import type { BrokenAction, BrokenItem, WorkFacts } from "./contract";

/** What clicking a button does. The row turns each into one callback. */
export type ButtonCommand =
  | { type: "action"; action: MyLeadAction }
  | { type: "text" }
  | { type: "call-today" }
  | { type: "set-drip" }
  | { type: "broken"; item: BrokenItem }
  | { type: "coach" }
  | { type: "link"; href: string };

export type ButtonSpec = {
  id: string;
  label: string;
  command: ButtonCommand;
  /** True when the button cannot be used right now; `disabledReason` then says why. */
  disabled: boolean;
  disabledReason: string | null;
};

export type MoreItem = ButtonSpec & { danger?: boolean };

export const BROKEN_ACTION_LABELS: Record<BrokenAction, string> = {
  fix_drip: "Fix drip",
  send_text: "Send text",
  resend: "Resend",
  review: "Review",
  check_status: "Check status",
  open_campaign: "Open campaign",
};

/** Broken actions that send a text and therefore need a phone that may be texted. */
const TEXTING_BROKEN_ACTIONS: ReadonlySet<BrokenAction> = new Set(["send_text", "resend"]);

/** Why Call/Text cannot be used, or null. */
export function contactBlock(facts: Pick<WorkFacts, "hasPhone" | "contactDnc">): string | null {
  if (facts.contactDnc) return "Do not contact";
  if (!facts.hasPhone) return "No phone number";
  return null;
}

function spec(id: string, label: string, command: ButtonCommand, block: string | null = null): ButtonSpec {
  return { id, label, command, disabled: block !== null, disabledReason: block };
}

const callSpec = (facts: WorkFacts) => spec("call", "Call", { type: "action", action: "start-call" }, contactBlock(facts));

/**
 * The reason's primary button (the one on the collapsed row next to Open lead).
 * Null when the reason has none (Under contract, and every Waiting reason where nothing is asked of the rep).
 *  New lead / Call today / Due -> Call;  New reply -> Reply;  Broken -> the first item's fix;
 *  Offer -> Log offer when no offer is logged yet, Call for a follow-up due or missing;
 *  Gone quiet / Nothing planned -> Set drip, except Nothing planned with a waiting text -> Send text.
 */
export function primaryButton(facts: WorkFacts): ButtonSpec | null {
  switch (facts.reason) {
    case "new_lead":
    case "call_today":
    case "due":
      return callSpec(facts);
    case "new_reply":
      return spec("reply", "Reply", { type: "text" }, contactBlock(facts));
    case "broken": {
      const item = facts.broken[0];
      return item ? brokenButton(item, facts) : null;
    }
    case "offer": {
      const kind = (facts.headline as Record<string, unknown>)?.kind;
      return kind === "ready"
        ? spec("log-offer", "Log offer", { type: "action", action: "log-offer" })
        : callSpec(facts);
    }
    case "nothing_planned":
      // A text is waiting for the rep to send: the move is sending it, not planning a drip (design owner, round 3).
      if (facts.labels.includes("text_waiting")) return spec("send-text", "Send text", { type: "text" }, contactBlock(facts));
      return spec("set-drip", "Set drip", { type: "set-drip" });
    case "gone_quiet":
      return spec("set-drip", "Set drip", { type: "set-drip" });
    default:
      return null;
  }
}

/** The fix button for one broken item. Resend and Send text also need a phone that may be texted. */
export function brokenButton(item: BrokenItem, facts: Pick<WorkFacts, "hasPhone" | "contactDnc">): ButtonSpec {
  const block = TEXTING_BROKEN_ACTIONS.has(item.action) ? contactBlock(facts) : null;
  return spec(`broken-${item.action}`, BROKEN_ACTION_LABELS[item.action], { type: "broken", item }, block);
}

/** Dismiss is offered only for broken items that carry a reference id. A Norma review is never dismissed here:
 *  it clears through Norma's own Mark reviewed, not a rep_sms_failure_dismissed event. */
export function dismissableBroken(facts: Pick<WorkFacts, "broken">): BrokenItem[] {
  return facts.broken.filter((item) => item.refId !== null && item.kind !== "norma_needs_review");
}

/** Stage commands in the More menu, in design order, with the stages that offer each today. */
const MORE_BY_ACTION: readonly { action: MyLeadAction; label: string; stages: readonly MyLeadStage[]; danger?: boolean }[] = [
  { action: "ready-for-offer", label: "Ready to make an offer", stages: ["contacted"] },
  { action: "log-offer", label: "Log offer", stages: ["contacted", "needs_offer"] },
  { action: "schedule-next-step", label: "Schedule a callback", stages: ["contacted"] },
  { action: "contract-signed", label: "Contract signed", stages: ["not_contacted", "contacted", "needs_offer", "offer_sent"] },
  { action: "decline-offer", label: "Offer declined", stages: ["offer_sent"], danger: true },
  { action: "handoff", label: "Dead / Nurture", stages: ["not_contacted", "contacted", "needs_offer", "offer_sent"], danger: true },
  { action: "archive", label: "Archive", stages: ["under_contract"] },
];

/** Log attempt is offered by every stage except Under contract (queue-row ACTIONS_BY_STAGE). */
export function logAttemptAvailable(stage: MyLeadStage): boolean {
  return stage !== "under_contract";
}

export type RowButtons = {
  /** The reason's primary; full width in the expanded grid when it is not Call. */
  primary: ButtonSpec | null;
  call: ButtonSpec;
  /** Null for Under contract rows. */
  logAttempt: ButtonSpec | null;
  /** Disabled while the lead is already pinned (the row shows Undo then). */
  callToday: ButtonSpec;
  setDrip: ButtonSpec;
  /**
   * Stage-aware More menu, in design order: Text, the stage commands, Call with coach (only when
   * `coachAvailable`), Open in Zillow (a link item), Archive (Under contract only).
   */
  more: MoreItem[];
};

/**
 * The expanded row's buttons. `canAct` is false while an owner views a rep: every action button is disabled
 * (reason "Viewing another rep's queue"); Open lead stays a plain link and is not part of this map.
 * "Not today" does not exist.
 */
export function rowButtons(facts: WorkFacts, options: { canAct: boolean; coachAvailable?: boolean }): RowButtons {
  const readOnly = options.canAct ? null : "Viewing another rep's queue";
  const gate = (button: ButtonSpec): ButtonSpec => (readOnly ? { ...button, disabled: true, disabledReason: readOnly } : button);
  const stage = facts.stage;
  const block = contactBlock(facts);

  const more: MoreItem[] = [gate(spec("text", "Text", { type: "text" }, block))];
  const stageItem = (entry: (typeof MORE_BY_ACTION)[number]): MoreItem => ({
    ...gate(spec(entry.action, entry.label, { type: "action", action: entry.action })),
    danger: entry.danger,
  });
  for (const entry of MORE_BY_ACTION) {
    if (entry.action !== "archive" && entry.stages.includes(stage)) more.push(stageItem(entry));
  }
  if (options.coachAvailable) more.push(gate(spec("coach", "Call with coach", { type: "coach" }, block)));
  const href = zillowUrl({ address: facts.row.address, city: facts.row.city, state: facts.row.state });
  if (href) more.push(gate(spec("zillow", "Open in Zillow", { type: "link", href })));
  for (const entry of MORE_BY_ACTION) {
    if (entry.action === "archive" && entry.stages.includes(stage)) more.push(stageItem(entry));
  }

  const primary = primaryButton(facts);
  return {
    primary: primary ? gate(primary) : null,
    call: gate(callSpec(facts)),
    logAttempt: logAttemptAvailable(stage) ? gate(spec("log-attempt", "Log attempt", { type: "action", action: "log-attempt" })) : null,
    callToday: gate({
      ...spec("call-today", "Call today", { type: "call-today" }, facts.reason === "call_today" ? "Already pinned" : null),
    }),
    setDrip: gate(spec("set-drip", "Set drip", { type: "set-drip" })),
    more,
  };
}
