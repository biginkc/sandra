import type { V2DripName, V2DripTransition } from "./drip-transition";
import type { V2Slice } from "./flags";
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
  | { kind: "alert"; reason: V2AlertReason }
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

export type V2ActionOpts = {
  /** routing_v2_flags.alert_on_time_only (PR-F). OFF = yes-family roads keep today's hot alert. */
  alertOnTimeOnly: boolean;
};

/** Yes-family roads: today's hot alert stays until alert_on_time_only is ON (then: alert only when a time is picked). */
const hotUnlessTimeOnly = (o: V2ActionOpts): V2Step[] => (o.alertOnTimeOnly ? [] : [a("hot_yes")]);

export const V2_ROAD_ACTIONS: Record<V2Road, (decision: V2Decision, opts: V2ActionOpts) => readonly V2Step[]> = {
  stop: () => [{ kind: "hold", reason: "asked_stop" }],
  ALERT_call_me: () => [a("call_me")],
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
  book_appointment: (dec, o) => [...hotUnlessTimeOnly(o), r(bookReply(dec)), d("Book appointment")],
  maybe_later_drip: () => [r("nurture"), d("Maybe later")],
  not_interested_drip: () => [r("not_interested"), d("Not interested")],
  who_reply_drip: () => [r("identity"), d("Asked who is texting", true)],
  which_property_reply: () => [r("where_property")],
  location_reply: () => [r("where_located")],
  confirmed_owner_drip: () => [d("Confirmed owner")],
  "reaction+book_appointment": (_dec, o) => [...hotUnlessTimeOnly(o), d("Book appointment")],
  "driving_reply+book_appointment": (_dec, o) => [...hotUnlessTimeOnly(o), r("driving"), d("Book appointment")],
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
export function actionForV2Decision(decision: V2Decision, opts: V2ActionOpts & { askedHowNumber?: boolean }): V2Action {
  if (decision.road === null) return actionForHaikuOutcome("unsure_no_jev");
  let steps = V2_ROAD_ACTIONS[decision.road](decision, opts);
  if (opts.askedHowNumber && steps.some((s) => s.kind === "reply")) {
    steps = steps.map((s) => (s.kind === "reply" ? r("number_source") : s));
  }
  return { road: decision.road, steps };
}

/** Which flag slice each step needs (§13.2). Holds are the existing safe path: replies slice. */
export function sliceForStep(step: V2Step): V2Slice {
  return step.kind === "drip" ? "drips" : "replies";
}

export type V2ExecDeps = {
  /** Re-reads flags + eligibility right before the side effect (send-time check). */
  recheck: (slice: V2Slice) => Promise<boolean>;
  /** Sends the approved template mapped to `key`; must refuse unless the rendered body equals `expectedText` after render. */
  sendReply: (key: V2AnyReplyKey, expectedText: string) => Promise<{ sent: boolean; reason?: string }>;
  hold: (reason: Extract<V2Step, { kind: "hold" }>["reason"]) => Promise<void>;
  wrongNumberClose: () => Promise<void>;
  /**
   * Fan-out through the existing hold-alerts/hot machinery. When wired at cutover,
   * `hot_yes` MUST use the delivery key hotTextKey(inboundId) so today's classifier hot
   * alert and v2's hot_yes dedupe to one alert for the same inbound.
   */
  alert: (reason: V2AlertReason, label: string) => Promise<void>;
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
  | { kind: "drip_not_enrolled"; done: V2Step[]; reason: string };

export async function executeV2Action(action: V2Action, deps: V2ExecDeps): Promise<V2ExecResult> {
  const done: V2Step[] = [];
  for (const step of action.steps) {
    if (!(await deps.recheck(sliceForStep(step)))) {
      await deps.returnToHumanQueue("cancelled_flag_off");
      return { kind: "cancelled_flag_off", done, at: step };
    }
    switch (step.kind) {
      case "reply": {
        const res = await deps.sendReply(step.key, v2ReplyText(step.key));
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
          return { kind: "drip_not_enrolled", done, reason: res.reason };
        }
        break;
      }
      case "alert":
        await deps.alert(step.reason, V2_ALERT_LABELS[step.reason]);
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
