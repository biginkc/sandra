import { hotTextKey } from "@/lib/hot-sellers/hot";

import type { V2DripName, V2DripTransition } from "./drip-transition";
import { ALL_OFF, alertOnTimeOnlyInForce, v2SliceAllowed, type RoutingV2Flags, type V2Slice } from "./flags";
import type { V2Road } from "./order";
import type { V2Decision } from "./route";
import { v2ReplyText, type V2AnyReplyKey } from "./reply-texts";

/**
 * Routing v2 (PR-B): road -> action, and a flag-guarded executor.
 *
 * Not wired into the live dispatch (the cutover PR does that). Every side effect goes
 * through injected deps that wrap the EXISTING paths: approved-template send
 * (`runApprovedTemplateStep`, exact-text check), the existing wait_for_person hold, the
 * existing wrong-number close, and the hold-alerts/hot machinery. Drips go through the
 * PR-C transition seam (no-op until PR-C merges).
 */

/** Alert reasons Jarrad sees. Labels are owner-facing alert copy, never seller text. */
export const V2_ALERT_LABELS = {
  call_me: "Asked us to call / gave a time",
  said_theyll_call: "Said they'll call",
  reason_to_sell: "Gave a reason to sell",
  commercial: "Commercial property",
  land_price: "Vacant lot, named a price",
  named_price: "Named a price",
  /** Today's hot alert for a yes (kept while alert_on_time_only is OFF). */
  hot_yes: "Hot seller — said yes / asked for offer",
  haiku_unsure: "Couldn't tell what they meant — please check",
  haiku_error: "Haiku error — please check",
  possible_stop: "Possible stop request — please check",
} as const;
export type V2AlertReason = keyof typeof V2_ALERT_LABELS;

export type V2Step =
  | { kind: "reply"; key: V2AnyReplyKey }
  | { kind: "drip"; drip: V2DripName; skipFirstStep?: boolean }
  /**
   * `whenTimeOnlyOff`: today's hot alert on a yes. Decided at SEND time from the fresh flags:
   * sent only while alert_on_time_only is OFF (PR-F), skipped while it is ON.
   */
  | { kind: "alert"; reason: V2AlertReason; whenTimeOnlyOff?: true }
  /**
   * PR-F: retire the current drip and start nothing (a picked time / asked for a call while
   * alert_on_time_only is in force stops the Book appointment drip). Decided at SEND time
   * from the fresh flags: skipped (a no-op, never a cancel) while the mode is not in force,
   * so flag-off behaviour is unchanged.
   */
  | { kind: "stop_drip"; whenTimeOnlyOn: true }
  /** Existing wait_for_person hold (stop: suppression is PR-I, not here). */
  | { kind: "hold"; reason: "asked_stop" | "bad_number" | "needs_person" }
  /** Existing wrong-number path: approved reply + close this property. */
  | { kind: "wrong_number_close" };

export type V2Action = { road: V2Road | "haiku_unsure" | "haiku_error" | "possible_stop"; steps: readonly V2Step[] };

const r = (key: V2AnyReplyKey): V2Step => ({ kind: "reply", key });
const d = (drip: V2DripName, skipFirstStep = false): V2Step => ({ kind: "drip", drip, skipFirstStep });
const a = (reason: V2AlertReason): V2Step => ({ kind: "alert", reason });

/** Book-appointment reply: asked_offer gets the asked-for-offer text, every other yes the said-yes text. */
function bookReply(decision: V2Decision): V2AnyReplyKey {
  return decision.provenance.by === "jev" && decision.provenance.signal === "asked_offer" ? "asked_offer" : "said_yes";
}

/**
 * Yes-family roads carry a conditional hot alert. Whether it goes out is decided at send
 * time from the fresh flags (never from a value read at decision time), so a flip of
 * alert_on_time_only between decision and send can neither send a stale alert nor drop a
 * needed one.
 */
const HOT_YES: V2Step = { kind: "alert", reason: "hot_yes", whenTimeOnlyOff: true };
/** PR-F: the alert goes FIRST, so a drip stop that fails can never lose it. */
const STOP_DRIP_ON_TIME: V2Step = { kind: "stop_drip", whenTimeOnlyOn: true };

/**
 * Alerts that share today's classifier hot-alert identity, hotTextKey(inbound): the yes alert
 * and the call-me alert. Both reconcile with the classifier's own hot alert for that inbound,
 * so every flag state ends in at most one hot alert per inbound.
 */
const HOT_KEYED_ALERTS: ReadonlySet<V2AlertReason> = new Set<V2AlertReason>(["hot_yes", "call_me"]);

export const V2_ROAD_ACTIONS: Record<V2Road, (decision: V2Decision) => readonly V2Step[]> = {
  stop: () => [{ kind: "hold", reason: "asked_stop" }],
  ALERT_call_me: () => [a("call_me"), STOP_DRIP_ON_TIME],
  wrong_number_close: () => [{ kind: "wrong_number_close" }],
  vacant_land_drip: () => [d("Vacant land")],
  ALERT_land_price: () => [a("land_price")],
  ALERT_commercial: () => [a("commercial")],
  listed_drip: () => [d("Listed, not selling")],
  text_only_reply: () => [r("text_only")],
  how_it_works_reply: () => [r("how_it_works")],
  ALERT_said_theyll_call: () => [a("said_theyll_call"), d("Said they'd call")],
  ALERT_reason_to_sell: () => [a("reason_to_sell")],
  // price_check flag off (PR-E not merged) = today's price alert + named-price reply.
  price_check: () => [r("named_price"), a("named_price")],
  // hot_yes goes BEFORE the reply: a reply that cannot send (template unapproved) must never lose the alert.
  book_appointment: (dec) => [HOT_YES, r(bookReply(dec)), d("Book appointment")],
  maybe_later_drip: () => [r("nurture"), d("Maybe later")],
  not_interested_drip: () => [r("not_interested"), d("Not interested")],
  who_reply_drip: () => [r("identity"), d("Asked who is texting", true)],
  which_property_reply: () => [r("where_property")],
  location_reply: () => [r("where_located")],
  confirmed_owner_drip: () => [d("Confirmed owner")],
  "reaction+book_appointment": () => [HOT_YES, d("Book appointment")],
  "driving_reply+book_appointment": () => [HOT_YES, r("driving"), d("Book appointment")],
  bad_number: () => [{ kind: "hold", reason: "bad_number" }],
};

/** PR-E's price-check outcomes (exposed now so the templates have a single owner). */
export const V2_PRICE_CHECK_ACTIONS = {
  /** Ask ≤80% of value, or no single value: fair-price reply + alert. */
  fair_or_no_value: [r("fair_price"), a("named_price")],
  /** Ask >80% of value: repairs reply (follow-ups next inbound). */
  too_high: [r("price_too_high")],
  /** Follow-up said no repairs needed: realtor reply. */
  no_repairs: [r("no_repairs_realtor")],
  /** Anything else after the repairs reply. */
  other: [d("Price too high")],
} as const satisfies Record<string, readonly V2Step[]>;

/** Haiku outcomes (PR-D decides; PR-B owns the alert reasons). */
export function actionForHaikuOutcome(o: "unsure_no_jev" | "error" | "haiku_decided_stop"): V2Action {
  if (o === "error") return { road: "haiku_error", steps: [{ kind: "hold", reason: "needs_person" }, a("haiku_error")] };
  if (o === "haiku_decided_stop") return { road: "possible_stop", steps: [{ kind: "hold", reason: "asked_stop" }, a("possible_stop")] };
  return { road: "haiku_unsure", steps: [{ kind: "hold", reason: "needs_person" }, a("haiku_unsure")] };
}

/**
 * The full action for a v2 decision. `askedHowNumber` = the separate "How did you get my
 * number?" signal: its approved reply replaces the road's own reply (never both), only on
 * roads that already send a reply (same rule as the live number_source mapping).
 */
export function actionForV2Decision(decision: V2Decision, opts: { askedHowNumber?: boolean } = {}): V2Action {
  if (decision.road === null) return actionForHaikuOutcome("unsure_no_jev");
  let steps = V2_ROAD_ACTIONS[decision.road](decision);
  if (opts.askedHowNumber && steps.some((s) => s.kind === "reply")) {
    steps = steps.map((s) => (s.kind === "reply" ? r("number_source") : s));
  }
  return { road: decision.road, steps };
}

/** Which flag slice each step needs (§13.2). Holds are the existing safe path: replies slice. */
export function sliceForStep(step: V2Step): V2Slice {
  return step.kind === "drip" || step.kind === "stop_drip" ? "drips" : "replies";
}

export type V2ExecDeps = {
  /**
   * Fresh read of the org's routing_v2_flags. Called once right before EVERY step; that one
   * snapshot is the single source of truth for every send-time decision (slice, canary
   * eligibility, alert_on_time_only). Throwing = all off.
   */
  readFlags: () => Promise<RoutingV2Flags>;
  /** Sends the approved template mapped to `key`; must refuse unless the rendered body equals `expectedText` after render. */
  sendReply: (key: V2AnyReplyKey, expectedText: string) => Promise<{ sent: boolean; reason?: string }>;
  hold: (reason: Extract<V2Step, { kind: "hold" }>["reason"]) => Promise<void>;
  wrongNumberClose: () => Promise<void>;
  /**
   * Fan-out through the existing hold-alerts/hot machinery. `dedupeKey` is the delivery
   * identity: for `hot_yes` it is hotTextKey(inboundId), the same key today's classifier hot
   * alert uses, so the two reconcile to exactly one alert for that inbound.
   */
  alert: (reason: V2AlertReason, label: string, dedupeKey: string | null) => Promise<void>;
  drip: V2DripTransition;
  /** Flag flipped off mid-flight: hand the inbound back to the human queue (needs_reply). */
  returnToHumanQueue: (why: string) => Promise<void>;
  ctx: { orgId: string; propertyId: string; inboundMessageId: string };
};

export type V2ExecResult =
  | { kind: "done"; done: V2Step[] }
  | { kind: "cancelled_flag_off"; done: V2Step[]; at: V2Step }
  | { kind: "reply_not_sent"; done: V2Step[]; reason: string }
  /** The drip did not enroll (PR-C not merged, or any failure): held for a person. */
  | { kind: "drip_not_enrolled"; done: V2Step[]; reason: string }
  /** PR-F: the drip could not be stopped after a picked time (alert already sent): held for a person. */
  | { kind: "drip_not_stopped"; done: V2Step[]; reason: string };

export async function executeV2Action(action: V2Action, deps: V2ExecDeps): Promise<V2ExecResult> {
  const done: V2Step[] = [];
  const alertKeysSent = new Set<string>();
  for (const step of action.steps) {
    let flags: RoutingV2Flags;
    try {
      flags = await deps.readFlags();
    } catch {
      flags = ALL_OFF;
    }
    if (step.kind === "stop_drip") {
      // Not in force (fresh read): skip. Nothing v2 started a drip that needs stopping here,
      // and a flag-off reply must not be handed back to the human queue after its alert.
      if (!alertOnTimeOnlyInForce(flags, deps.ctx.propertyId)) continue;
      let res: Awaited<ReturnType<V2DripTransition["transition"]>>;
      try {
        res = await deps.drip.transition({ ...deps.ctx, drip: null, road: action.road, skipFirstStep: false });
      } catch {
        res = { kind: "not_available", reason: "transition_error" };
      }
      if (res.kind !== "stopped" && res.kind !== "superseded") {
        // The seller picked a time but the drip may keep texting: a person looks.
        await deps.hold("needs_person");
        return { kind: "drip_not_stopped", done, reason: res.kind === "not_available" ? res.reason : res.kind };
      }
      done.push(step);
      continue;
    }
    if (!v2SliceAllowed(flags, sliceForStep(step), deps.ctx.propertyId)) {
      await deps.returnToHumanQueue("cancelled_flag_off");
      return { kind: "cancelled_flag_off", done, at: step };
    }
    switch (step.kind) {
      case "reply": {
        let res: { sent: boolean; reason?: string };
        try {
          res = await deps.sendReply(step.key, v2ReplyText(step.key));
        } catch {
          res = { sent: false, reason: "send_error" };
        }
        if (!res.sent) {
          // Fail closed: no later drip/alert after a reply that did not go out; a person looks.
          await deps.hold("needs_person");
          return { kind: "reply_not_sent", done, reason: res.reason ?? "not_sent" };
        }
        break;
      }
      case "drip": {
        let res: Awaited<ReturnType<V2DripTransition["transition"]>>;
        try {
          res = await deps.drip.transition({
            ...deps.ctx,
            drip: step.drip,
            road: action.road,
            skipFirstStep: step.skipFirstStep ?? false,
          });
        } catch {
          res = { kind: "not_available", reason: "transition_error" };
        }
        if (res.kind !== "enrolled" && res.kind !== "superseded") {
          // Never end a reply with no drip, hold or alert: a person looks.
          await deps.hold("needs_person");
          return { kind: "drip_not_enrolled", done, reason: res.kind === "not_available" ? res.reason : res.kind };
        }
        break;
      }
      case "alert":
        // alert_on_time_only in force (fresh read): no hot alert on a yes; only a picked time
        // alerts (PR-F).
        if (step.whenTimeOnlyOff && alertOnTimeOnlyInForce(flags, deps.ctx.propertyId)) continue;
        {
          const key = HOT_KEYED_ALERTS.has(step.reason) ? hotTextKey(deps.ctx.inboundMessageId) : null;
          // One alert per delivery identity per inbound, even if an action ever lists two.
          if (key !== null && alertKeysSent.has(key)) continue;
          await deps.alert(step.reason, V2_ALERT_LABELS[step.reason], key);
          if (key !== null) alertKeysSent.add(key);
        }
        break;
      case "hold":
        await deps.hold(step.reason);
        break;
      case "wrong_number_close":
        await deps.wrongNumberClose();
        break;
    }
    done.push(step);
  }
  return { kind: "done", done };
}
