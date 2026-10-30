import { describe, expect, it } from "vitest";

import { HOT_KEYWORD_TIER, hotTextKey, isHotSeller, isHotSellerUnderV2, V2_YES_FAMILY_ROADS } from "@/lib/hot-sellers/hot";

import { actionForV2Decision, executeV2Action, V2_ROAD_ACTIONS, type V2Action, type V2ExecDeps } from "./actions";
import type { V2DripTransition, V2DripTransitionRequest } from "./drip-transition";
import { alertOnTimeOnlyInForce, ALL_OFF, parseRoutingV2Flags, type RoutingV2Flags } from "./flags";
import type { V2Road } from "./order";
import { V2_QUESTION_IDS, PROPERTY_TYPE_OPTIONS, type V2QuestionId } from "./questions";
import { routeV2, type V2Decision } from "./route";

/**
 * Routing v2 PR-F: "alert only when a time is picked" (alert_on_time_only).
 * A yes gets the approved reply + Book appointment drip and NO hot alert; a later picked time /
 * asked-for-a-call gets the hot alert and stops the drip. Flag off = PR-B behaviour.
 */
const P1 = "11111111-1111-4111-8111-111111111111";
const base = { questions_live: true, replies: true, drips: true, canary_property_ids: [P1] };
const TIME_ONLY_ON = parseRoutingV2Flags({ ...base, alert_on_time_only: true });
const TIME_ONLY_OFF = parseRoutingV2Flags({ ...base, alert_on_time_only: false });

const YES_ROADS: V2Road[] = ["book_appointment", "reaction+book_appointment", "driving_reply+book_appointment"];

/** A Jev decision from probabilities: everything 0 except the given answers. */
function decide(reply: string, yes: Partial<Record<V2QuestionId, number>>): V2Decision {
  const probabilities = Object.fromEntries(V2_QUESTION_IDS.map((q) => [q, yes[q] ?? 0])) as Record<V2QuestionId, number>;
  const propertyType = Object.fromEntries(PROPERTY_TYPE_OPTIONS.map((o) => [o, o === "residential" ? 0.9 : 0])) as never;
  return routeV2({ reply, probabilities, propertyType });
}

/** One property's drip state, the shape route_reply_transition gives (one active v2 drip, latest wins). */
function fakeDrips() {
  const state = { active: null as string | null, retired: [] as string[], calls: [] as V2DripTransitionRequest[] };
  const t: V2DripTransition = {
    async transition(req) {
      state.calls.push(req);
      if (state.active) state.retired.push(state.active);
      state.active = req.drip;
      return req.drip === null ? { kind: "stopped" } : { kind: "enrolled", enrollmentId: `e${state.calls.length}` };
    },
  };
  return { state, t };
}

/** One delivery sink shared with "today's classifier hot alert", deduped by key (hold-alerts). */
function alertSink() {
  const delivered = new Map<string, string[]>();
  const deliver = (inbound: string, key: string) => {
    const keys = delivered.get(inbound) ?? [];
    if (!keys.includes(key)) keys.push(key);
    delivered.set(inbound, keys);
  };
  return { delivered, deliver };
}

function deps(
  flags: RoutingV2Flags | (() => RoutingV2Flags),
  inbound: string,
  drip: V2DripTransition,
  over: Partial<V2ExecDeps> = {},
) {
  const log: string[] = [];
  const d: V2ExecDeps = {
    readFlags: async () => (typeof flags === "function" ? flags() : flags),
    sendReply: async (key) => (log.push(`reply:${key}`), { sent: true }),
    hold: async (r) => void log.push(`hold:${r}`),
    wrongNumberClose: async () => void log.push("close"),
    alert: async (r, _l, key) => void log.push(key ? `alert:${r}:${key}` : `alert:${r}`),
    drip: { transition: async (req) => (log.push(`drip:${req.drip ?? "STOP"}`), drip.transition(req)) },
    returnToHumanQueue: async (w) => void log.push(`human:${w}`),
    ctx: { orgId: "o", propertyId: P1, inboundMessageId: inbound },
    ...over,
  };
  return { d, log };
}

const alerts = (log: string[]) => log.filter((l) => l.startsWith("alert:"));

describe("PR-F: alert only when a time is picked (alert_on_time_only ON)", () => {
  it('"Sure" -> the approved reply + Book appointment drip, and NO alert', async () => {
    const sure = decide("Sure", { open_to_selling: 0.93 });
    expect(sure.road).toBe("book_appointment");
    const drips = fakeDrips();
    const { d, log } = deps(TIME_ONLY_ON, "m1", drips.t);
    expect((await executeV2Action(actionForV2Decision(sure), d)).kind).toBe("done");
    expect(alerts(log)).toEqual([]);
    expect(log).toEqual(["reply:said_yes", "drip:Book appointment"]);
    expect(drips.state.active).toBe("Book appointment");
  });

  it('"Tuesday 3pm" after "Sure" -> exactly one hot alert and the Book appointment drip stops', async () => {
    const drips = fakeDrips();
    const sink = alertSink();
    const onAlert = (inbound: string): Partial<V2ExecDeps> => ({
      alert: async (_r, _l, key) => sink.deliver(inbound, key ?? `untracked:${inbound}`),
    });
    const first = deps(TIME_ONLY_ON, "m1", drips.t, onAlert("m1"));
    await executeV2Action(actionForV2Decision(decide("Sure", { open_to_selling: 0.93 })), first.d);
    expect(sink.delivered.get("m1")).toBeUndefined();

    const time = decide("Tuesday 3pm", { asked_call: 0.88, open_to_selling: 0.7 });
    expect(time.road).toBe("ALERT_call_me");
    const second = deps(TIME_ONLY_ON, "m2", drips.t, onAlert("m2"));
    // today's classifier hot alert for the same inbound shares the key: still one delivery
    sink.deliver("m2", hotTextKey("m2"));
    expect((await executeV2Action(actionForV2Decision(time), second.d)).kind).toBe("done");
    expect(sink.delivered.get("m2")).toEqual([hotTextKey("m2")]);
    expect(second.log).toEqual(["drip:STOP"]);
    expect(drips.state.active).toBeNull();
    expect(drips.state.retired).toEqual(["Book appointment"]);
    expect(drips.state.calls.at(-1)).toMatchObject({ drip: null, road: "ALERT_call_me", inboundMessageId: "m2" });
  });

  it('"Tuesday 3pm" then quickly "Thanks": exactly one call-me alert across both texts', async () => {
    const drips = fakeDrips();
    const sink = alertSink();
    const a = deps(TIME_ONLY_ON, "m2", drips.t, { alert: async (_r, _l, key) => sink.deliver("m2", key ?? "x") });
    await executeV2Action(actionForV2Decision(decide("Tuesday 3pm", { asked_call: 0.9 })), a.d);
    const b = deps(TIME_ONLY_ON, "m3", drips.t, { alert: async (_r, _l, key) => sink.deliver("m3", key ?? "x") });
    await executeV2Action(actionForV2Decision(decide("Thanks", { just_ok: 0.8 })), b.d);
    expect([...sink.delivered.entries()]).toEqual([["m2", [hotTextKey("m2")]]]);
  });

  it("every yes-family road (Yes / Maybe / offer / future action / Okay / reaction / driving) sends no alert", async () => {
    const yes: Array<[string, Partial<Record<V2QuestionId, number>>]> = [
      ["Yes", { open_to_selling: 0.95 }],
      ["Make me an offer", { asked_offer: 0.9 }],
      ["Maybe next month", { future_action: 0.8 }],
      ["Okay", { just_ok: 0.9 }],
    ];
    for (const [reply, p] of yes) {
      const dec = decide(reply, p);
      expect(dec.road, reply).toBe("book_appointment");
      const { d, log } = deps(TIME_ONLY_ON, "m1", fakeDrips().t);
      await executeV2Action(actionForV2Decision(dec), d);
      expect(alerts(log), reply).toEqual([]);
      expect(log.at(-1), reply).toBe("drip:Book appointment");
    }
    for (const reply of ['Liked "Hi Pat, Mel with BMH"', "I'm driving right now"]) {
      const dec = decide(reply, {});
      expect(V2_YES_FAMILY_ROADS).toContain(dec.road);
      const { d, log } = deps(TIME_ONLY_ON, "m1", fakeDrips().t);
      await executeV2Action(actionForV2Decision(dec), d);
      expect(alerts(log), reply).toEqual([]);
      expect(log.at(-1), reply).toBe("drip:Book appointment");
    }
  });

  it("a drip that cannot be stopped after a picked time: the alert already went out, then a person looks", async () => {
    for (const t of [
      { transition: async () => ({ kind: "not_available" as const, reason: "transition_error" }) },
      { transition: async () => { throw new Error("db"); } },
      { transition: async () => ({ kind: "enrolled" as const, enrollmentId: "x" }) },
    ] satisfies V2DripTransition[]) {
      const { d, log } = deps(TIME_ONLY_ON, "m2", t);
      const res = await executeV2Action(actionForV2Decision(decide("Call me", { asked_call: 0.9 })), d);
      expect(res.kind).toBe("drip_not_stopped");
      expect(log[0]).toBe(`alert:call_me:${hotTextKey("m2")}`);
      expect(log.at(-1)).toBe("hold:needs_person");
    }
    const sup = deps(TIME_ONLY_ON, "m2", { transition: async () => ({ kind: "superseded" }) });
    expect((await executeV2Action(actionForV2Decision(decide("Call me", { asked_call: 0.9 })), sup.d)).kind).toBe("done");
  });

  it("in force only with questions_live + alert_on_time_only + drips + an eligible property", () => {
    expect(alertOnTimeOnlyInForce(TIME_ONLY_ON, P1)).toBe(true);
    expect(alertOnTimeOnlyInForce(TIME_ONLY_OFF, P1)).toBe(false);
    expect(alertOnTimeOnlyInForce(ALL_OFF, P1)).toBe(false);
    expect(alertOnTimeOnlyInForce({ ...TIME_ONLY_ON, drips: false }, P1)).toBe(false);
    expect(alertOnTimeOnlyInForce({ ...TIME_ONLY_ON, questions_live: false }, P1)).toBe(false);
    expect(alertOnTimeOnlyInForce(TIME_ONLY_ON, "22222222-2222-4222-8222-222222222222")).toBe(false);
  });

  it("alert_on_time_only ON but drips OFF: a yes keeps today's hot alert (never a silent yes); call-me does not try to stop a drip", async () => {
    const noDrips = parseRoutingV2Flags({ ...base, drips: false, alert_on_time_only: true });
    const yes = deps(noDrips, "m1", fakeDrips().t);
    expect((await executeV2Action(actionForV2Decision(decide("Yes", { open_to_selling: 0.9 })), yes.d)).kind).toBe("cancelled_flag_off");
    expect(yes.log).toEqual([`alert:hot_yes:${hotTextKey("m1")}`, "reply:said_yes", "human:cancelled_flag_off"]);
    const call = deps(noDrips, "m2", fakeDrips().t);
    expect((await executeV2Action(actionForV2Decision(decide("Call me", { asked_call: 0.9 })), call.d)).kind).toBe("done");
    expect(call.log).toEqual([`alert:call_me:${hotTextKey("m2")}`]);
  });

  it("a flip between the alert and the stop: the fresh read right before the stop decides", async () => {
    const seq = [TIME_ONLY_ON, TIME_ONLY_OFF];
    let n = 0;
    const { d, log } = deps(() => seq[Math.min(n++, 1)]!, "m2", fakeDrips().t);
    expect((await executeV2Action(actionForV2Decision(decide("Call me", { asked_call: 0.9 })), d)).kind).toBe("done");
    expect(log).toEqual([`alert:call_me:${hotTextKey("m2")}`]);
  });
});

describe("PR-F flag-off parity (alert_on_time_only OFF = PR-B behaviour)", () => {
  /** PR-B's executor output for each road with replies + drips on and alert_on_time_only off. */
  const PR_B: Record<V2Road, string[]> = {
    stop: ["hold:asked_stop"],
    ALERT_call_me: ["alert:call_me"],
    wrong_number_close: ["close"],
    vacant_land_drip: ["drip:Vacant land"],
    ALERT_land_price: ["alert:land_price"],
    ALERT_commercial: ["alert:commercial"],
    listed_drip: ["drip:Listed, not selling"],
    text_only_reply: ["reply:text_only"],
    how_it_works_reply: ["reply:how_it_works"],
    ALERT_said_theyll_call: ["alert:said_theyll_call", "drip:Said they'd call"],
    ALERT_reason_to_sell: ["alert:reason_to_sell"],
    price_check: ["reply:named_price", "alert:named_price"],
    book_appointment: ["alert:hot_yes", "reply:asked_offer", "drip:Book appointment"],
    maybe_later_drip: ["reply:nurture", "drip:Maybe later"],
    not_interested_drip: ["reply:not_interested", "drip:Not interested"],
    who_reply_drip: ["reply:identity", "drip:Asked who is texting"],
    which_property_reply: ["reply:where_property"],
    location_reply: ["reply:where_located"],
    confirmed_owner_drip: ["drip:Confirmed owner"],
    "reaction+book_appointment": ["alert:hot_yes", "drip:Book appointment"],
    "driving_reply+book_appointment": ["alert:hot_yes", "reply:driving", "drip:Book appointment"],
    bad_number: ["hold:bad_number"],
  };
  const jev = (road: V2Road): V2Decision => ({
    road,
    provenance: { by: "jev", row: "x", step: "x", signal: "asked_offer", probability: 0.9 },
    haiku: null,
    opportunityAlert: false,
  });

  it("every road: same replies, holds, drips and alerts as PR-B; no drip stop", async () => {
    expect(Object.keys(PR_B).sort()).toEqual(Object.keys(V2_ROAD_ACTIONS).sort());
    for (const road of Object.keys(PR_B) as V2Road[]) {
      const { d, log } = deps(TIME_ONLY_OFF, "m1", fakeDrips().t);
      expect((await executeV2Action(actionForV2Decision(jev(road)), d)).kind, road).toBe("done");
      // The only difference: hot-family alerts carry hotTextKey(inbound) (PR-B already did for
      // hot_yes; call_me now shares it so it reconciles with today's classifier hot alert).
      expect(log.map((l) => l.replace(`:${hotTextKey("m1")}`, "")), road).toEqual(PR_B[road]);
      expect(log.includes("drip:STOP"), road).toBe(false);
    }
  });

  it("everything off: every road still cancels before its first step (unchanged)", async () => {
    for (const road of Object.keys(PR_B) as V2Road[]) {
      const { d, log } = deps(ALL_OFF, "m1", fakeDrips().t);
      expect((await executeV2Action(actionForV2Decision(jev(road)), d)).kind).toBe("cancelled_flag_off");
      expect(log).toEqual(["human:cancelled_flag_off"]);
    }
  });

  it('flag off: "Sure" alerts once (today), "Tuesday 3pm" alerts once and leaves the drip alone', async () => {
    const drips = fakeDrips();
    const a = deps(TIME_ONLY_OFF, "m1", drips.t);
    await executeV2Action(actionForV2Decision(decide("Sure", { open_to_selling: 0.93 })), a.d);
    expect(alerts(a.log)).toEqual([`alert:hot_yes:${hotTextKey("m1")}`]);
    const b = deps(TIME_ONLY_OFF, "m2", drips.t);
    await executeV2Action(actionForV2Decision(decide("Tuesday 3pm", { asked_call: 0.88 })), b.d);
    expect(alerts(b.log)).toEqual([`alert:call_me:${hotTextKey("m2")}`]);
    expect(drips.state.active).toBe("Book appointment");
  });
});

describe("PR-F dedupe: one alert per inbound, keyed hotTextKey", () => {
  it("an action that lists two hot-keyed alerts delivers one", async () => {
    const action: V2Action = {
      road: "ALERT_call_me",
      steps: [
        { kind: "alert", reason: "hot_yes" },
        { kind: "alert", reason: "call_me" },
        { kind: "alert", reason: "call_me" },
      ],
    };
    for (const flags of [TIME_ONLY_ON, TIME_ONLY_OFF]) {
      const { d, log } = deps(flags, "m9", fakeDrips().t);
      await executeV2Action(action, d);
      expect(alerts(log)).toEqual([`alert:hot_yes:${hotTextKey("m9")}`]);
    }
  });

  it("in every flag state, v2 + today's classifier hot alert reconcile to at most one delivery per inbound", async () => {
    const cases: Array<[string, Partial<Record<V2QuestionId, number>>]> = [
      ["Sure", { open_to_selling: 0.93 }],
      ["Tuesday 3pm", { asked_call: 0.9 }],
      ["Okay", { just_ok: 0.9 }],
    ];
    for (const flags of [TIME_ONLY_ON, TIME_ONLY_OFF]) {
      for (const [reply, p] of cases) {
        const dec = decide(reply, p);
        const sink = alertSink();
        const inForce = alertOnTimeOnlyInForce(flags, P1);
        // today's classifier, with PR-F's hot definition (hot when Jev outcome is new_lead)
        if (isHotSellerUnderV2({ jevOutcome: "new_lead", v2Road: dec.road, alertOnTimeOnly: inForce })) {
          sink.deliver("m1", hotTextKey("m1"));
        }
        const { d } = deps(flags, "m1", fakeDrips().t, { alert: async (_r, _l, key) => sink.deliver("m1", key ?? "other") });
        await executeV2Action(actionForV2Decision(dec), d);
        const n = sink.delivered.get("m1")?.length ?? 0;
        const expected = inForce && dec.road !== "ALERT_call_me" ? 0 : 1;
        expect(n, `${reply} inForce=${inForce}`).toBe(expected);
      }
    }
  });
});

describe("PR-F hot.ts: yes-family triggers dropped only behind the flag", () => {
  const inputs = [
    { jevOutcome: "new_lead" },
    { jevOutcome: "nurture" },
    { reasons: ["model:hot_lead"] },
    { reasons: ["call_request"] },
    { reasons: ["price_or_offer"] },
    { reasons: [`keyword:${HOT_KEYWORD_TIER}`] },
    { reasons: ["jev_below_threshold:new_lead"] },
    { reasons: ["jev_new_lead_promotion_failed"] },
    { reasons: ["price_quoted", null, undefined] },
    {},
  ];
  const roads: Array<string | null> = [...Object.keys(V2_ROAD_ACTIONS), null];

  it("flag off: identical to isHotSeller for every input and road", () => {
    for (const input of inputs) for (const v2Road of roads) {
      expect(isHotSellerUnderV2({ ...input, v2Road, alertOnTimeOnly: false })).toBe(isHotSeller(input));
    }
  });

  it("flag on: yes-family roads are not hot, except the untouched price-keyword HOT tier; other roads unchanged", () => {
    for (const input of inputs) for (const v2Road of roads) {
      const got = isHotSellerUnderV2({ ...input, v2Road, alertOnTimeOnly: true });
      if (v2Road && V2_YES_FAMILY_ROADS.includes(v2Road)) {
        expect(got, `${v2Road} ${JSON.stringify(input)}`).toBe(input.reasons?.includes(`keyword:${HOT_KEYWORD_TIER}`) ?? false);
      } else {
        expect(got, `${v2Road} ${JSON.stringify(input)}`).toBe(isHotSeller(input));
      }
    }
    expect(isHotSellerUnderV2({ jevOutcome: "new_lead", v2Road: "ALERT_call_me", alertOnTimeOnly: true })).toBe(true);
  });

  it("the yes-family list is exactly the roads that carry the conditional hot alert", () => {
    const jev = (road: V2Road): V2Decision => ({ road, provenance: { by: "jev", row: "x", step: "x", signal: "asked_offer", probability: 0.9 }, haiku: null, opportunityAlert: false });
    const withHotYes = (Object.keys(V2_ROAD_ACTIONS) as V2Road[]).filter((r) =>
      actionForV2Decision(jev(r)).steps.some((s) => s.kind === "alert" && s.reason === "hot_yes" && s.whenTimeOnlyOff),
    );
    expect([...V2_YES_FAMILY_ROADS].sort()).toEqual(withHotYes.sort());
    expect(YES_ROADS.sort()).toEqual([...V2_YES_FAMILY_ROADS].sort());
  });
});
