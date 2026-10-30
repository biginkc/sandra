import { hotTextKey } from "@/lib/hot-sellers/hot";
import { V2_ALERT_LABELS, type V2Action, type V2Step } from "./actions";
import type { V2DripName } from "./drip-transition";
import { alertOnTimeOnlyInForce, v2SliceAllowed, type RoutingV2Flags } from "./flags";

/** Every road must name a supported transactional sequence, including the four unchanged
 * legacy drips. The cutover migration snapshots those without changing their copy/timing.
 */
export const V2_SEQUENCE_KEYS: Record<V2DripName, string> = {
  "Book appointment": "book_appointment",
  "Said they'd call": "said_theyd_call",
  "Price too high": "price_too_high",
  "Vacant land": "vacant_land",
  "Listed, not selling": "listed_not_selling",
  "Maybe later": "maybe_later",
  "Not interested": "not_interested",
  "Asked who is texting": "asked_who",
  "Confirmed owner": "confirmed_owner",
};
export type V2TransitionPlan = {
  sequence_key: string | null;
  contact_id: string;
  skip_first_step: boolean;
  road: V2Action["road"];
  outbox: Array<{ kind: "reply" | "alert"; slice: "replies"; payload: Record<string, unknown> }>;
  hold_reason: Extract<V2Step, { kind: "hold" }>["reason"] | null;
  wrong_number_close: boolean;
};

/** Compile one atomic transition, never one transition per step: all calls for the same
 * inbound share a DB idempotency key, so per-step calls would silently lose later effects.
 * This snapshot selects intent only; DB and provider checks remain mandatory at delivery.
 */
export function compileV2Transition(
  action: V2Action,
  input: { flags: RoutingV2Flags; propertyId: string; contactId: string; inboundMessageId: string },
): V2TransitionPlan {
  const { flags, propertyId, contactId, inboundMessageId } = input;
  const plan: V2TransitionPlan = { sequence_key: null, contact_id: contactId, skip_first_step: false,
    road: action.road, outbox: [], hold_reason: null, wrong_number_close: false };
  const drips = v2SliceAllowed(flags, "drips", propertyId);
  const replies = v2SliceAllowed(flags, "replies", propertyId);
  // Conditional alert intents survive until the database delivery gate reads fresh flags.
  const timeOnly = alertOnTimeOnlyInForce(flags, propertyId);
  let dripChosen = false;
  for (const step of action.steps) {
    if (step.kind === "drip" && drips) {
      if (dripChosen) throw new Error("routing_v2_multiple_drips");
      dripChosen = true;
      plan.sequence_key = V2_SEQUENCE_KEYS[step.drip];
      plan.skip_first_step = step.skipFirstStep ?? false;
    } else if (step.kind === "stop_drip" && timeOnly) {
      if (dripChosen) throw new Error("routing_v2_conflicting_drip_intent");
      dripChosen = true;
    } else if (step.kind === "reply" && replies) {
      if (plan.outbox.some((item) => item.kind === "reply")) throw new Error("routing_v2_multiple_replies");
      plan.outbox.push({ kind: "reply", slice: "replies", payload: { key: step.key } });
    } else if (step.kind === "alert" && replies) {
      const key = step.reason === "hot_yes" || step.reason === "call_me" ? hotTextKey(inboundMessageId) : `routing_v2:${inboundMessageId}:${step.reason}`;
      if (!plan.outbox.some((item) => item.payload.dedupe_key === key)) {
        plan.outbox.push({ kind: "alert", slice: "replies", payload: {
          reason: step.reason, label: V2_ALERT_LABELS[step.reason], dedupe_key: key,
          when_time_only_off: step.whenTimeOnlyOff === true,
        } });
      }
    } else if (step.kind === "hold" && replies) plan.hold_reason = step.reason;
    else if (step.kind === "wrong_number_close" && replies) plan.wrong_number_close = true;
  }
  if (plan.hold_reason && (plan.sequence_key || plan.outbox.some((item) => item.kind === "reply"))) {
    throw new Error("routing_v2_hold_has_automatic_send");
  }
  return plan;
}
