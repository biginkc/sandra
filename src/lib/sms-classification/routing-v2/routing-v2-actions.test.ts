import { describe, expect, it, vi } from "vitest";

import { NINE_HOT_REPLY_TEXTS } from "../nine-questions";
import {
  actionForHaikuOutcome,
  actionForV2Decision,
  executeV2Action,
  V2_ALERT_LABELS,
  V2_PRICE_CHECK_ACTIONS,
  V2_ROAD_ACTIONS,
  type V2ExecDeps,
} from "./actions";
import { NOOP_DRIP_TRANSITION } from "./drip-transition";
import {
  ALL_OFF,
  canaryBucket,
  isV2Eligible,
  makeSendTimeRecheck,
  parseRoutingV2Flags,
  v2SliceAllowed,
  v2SliceAllowedForAll,
} from "./flags";
import { V2_ORDER, type V2Road } from "./order";
import { V2_QUESTION_IDS } from "./questions";
import { routeV2, type V2Decision } from "./route";
import { V2_MULTI_SEGMENT_KEYS, V2_REPLY_NAMES, V2_REPLY_TEXTS, V2_REUSED_REPLY_TEXTS, V2_TEMPLATE_KEYS, v2ReplyText } from "./reply-texts";
import { seedV2ReplyTemplates } from "./seed-v2-reply-templates";

const P1 = "11111111-1111-4111-8111-111111111111";
const OFF = { alertOnTimeOnly: true } as const; // table tests below: alert_on_time_only ON (no hot alert)
const TODAY = { alertOnTimeOnly: false } as const;

describe("approved v2 reply texts (byte pins — change only with Jarrad's verbatim approval)", () => {
  it("pins every text exactly", () => {
    expect(V2_REPLY_TEXTS).toStrictEqual({
      number_source:
        "Fair question. Your property met the criteria in our public records search. We're buying in your area. Would you consider an offer?",
      where_property: "Sorry for the confusion, it's {{property_address}}. Would you consider a cash offer on it?",
      where_located: "We're based in the Kansas City metro, but we buy properties throughout the Midwest.",
      text_only:
        "Thanks for making me aware. We have several questions about the condition of the property. Are you OK answering those via text?",
      how_it_works:
        "Thanks for your question. First step is a conversation about the condition of the property. With that information we get you an approval for an offer. If you like the offer, we open title, schedule a walk through with our contractors, and close in 14-30 days.",
      driving: "Okay, thank you for letting me know. I'll reach out to you later.",
      price_too_high:
        "What you're asking is actually above what we would want to list for after repairs. It sounds like your property is realtor-approved and list-ready, no repairs?",
      no_repairs_realtor:
        "Thank you for being transparent. For most homeowners, a realtor is the best option. Do you think a realtor would be most helpful for you?",
      fair_price: "My team member is going to be reaching out to you here shortly.",
    });
  });

  it("reuses existing approved replies by reference, unchanged", () => {
    expect(V2_REUSED_REPLY_TEXTS).toStrictEqual({
      wrong_number: "Sorry about that, my mistake. Any chance you know who owns the place?",
      not_interested:
        "Sounds good, thanks for letting me know. If anything changes in the next 6-12 months, mind if I check back?",
      nurture: "Fantastic! We will keep in touch.",
      asked_offer: NINE_HOT_REPLY_TEXTS.asked_offer,
      said_yes: NINE_HOT_REPLY_TEXTS.said_yes,
      named_price: NINE_HOT_REPLY_TEXTS.named_price,
      identity:
        "I'm sorry I should have mentioned that. I'm Mel with BMH. We're local home buyers since 1998. Any chance you'd consider a cash offer on your property?",
    });
  });

  it("keeps every text to one GSM-7 segment (160) with a 40-char address, except how-it-works", () => {
    const addr = "1234 Northwest Longstreet Avenue Apt 12B"; // 40 chars
    for (const [key, text] of Object.entries(V2_REPLY_TEXTS)) {
      const rendered = text.replace("{{property_address}}", addr);
      expect(/^[\x20-\x7e]*$/.test(rendered), key).toBe(true); // ASCII only (GSM-7 safe)
      if (V2_MULTI_SEGMENT_KEYS.has(key as keyof typeof V2_REPLY_TEXTS)) {
        expect(rendered.length).toBeGreaterThan(160);
        expect(rendered.length).toBeLessThanOrEqual(306); // two concatenated segments
      } else expect(rendered.length, key).toBeLessThanOrEqual(160);
    }
    expect([...V2_MULTI_SEGMENT_KEYS]).toEqual(["how_it_works"]);
  });

  it("names a template for every text and lists the new mapping keys", () => {
    expect(Object.keys(V2_REPLY_NAMES).sort()).toEqual(Object.keys(V2_REPLY_TEXTS).sort());
    expect(V2_TEMPLATE_KEYS).toEqual(["where_property", "where_located", "text_only", "how_it_works", "driving", "price_too_high", "no_repairs_realtor", "fair_price"]);
  });
});

const jevDecision = (road: V2Road, signal = "asked_offer"): V2Decision => ({
  road,
  provenance: { by: "jev", row: "x", step: "x", signal: signal as never, probability: 0.9 },
  haiku: null,
  opportunityAlert: false,
});

describe("road -> action table", () => {
  it("covers every road the order and code checks can produce", () => {
    const roads = new Set<string>([...V2_ORDER.map((s) => s.road), "ALERT_land_price", "reaction+book_appointment", "driving_reply+book_appointment", "bad_number"]);
    expect(new Set(Object.keys(V2_ROAD_ACTIONS))).toEqual(roads);
  });

  it.each<[V2Road, unknown]>([
    ["stop", [{ kind: "hold", reason: "asked_stop" }]],
    ["ALERT_call_me", [{ kind: "alert", reason: "call_me" }]],
    ["wrong_number_close", [{ kind: "wrong_number_close" }]],
    ["vacant_land_drip", [{ kind: "drip", drip: "Vacant land", skipFirstStep: false }]],
    ["ALERT_land_price", [{ kind: "alert", reason: "land_price" }]],
    ["ALERT_commercial", [{ kind: "alert", reason: "commercial" }]],
    ["listed_drip", [{ kind: "drip", drip: "Listed, not selling", skipFirstStep: false }]],
    ["text_only_reply", [{ kind: "reply", key: "text_only" }]],
    ["how_it_works_reply", [{ kind: "reply", key: "how_it_works" }]],
    ["ALERT_said_theyll_call", [{ kind: "alert", reason: "said_theyll_call" }, { kind: "drip", drip: "Said they'd call", skipFirstStep: false }]],
    ["ALERT_reason_to_sell", [{ kind: "alert", reason: "reason_to_sell" }]],
    ["price_check", [{ kind: "reply", key: "named_price" }, { kind: "alert", reason: "named_price" }]],
    ["book_appointment", [{ kind: "reply", key: "asked_offer" }, { kind: "drip", drip: "Book appointment", skipFirstStep: false }]],
    ["maybe_later_drip", [{ kind: "reply", key: "nurture" }, { kind: "drip", drip: "Maybe later", skipFirstStep: false }]],
    ["not_interested_drip", [{ kind: "reply", key: "not_interested" }, { kind: "drip", drip: "Not interested", skipFirstStep: false }]],
    ["who_reply_drip", [{ kind: "reply", key: "identity" }, { kind: "drip", drip: "Asked who is texting", skipFirstStep: true }]],
    ["which_property_reply", [{ kind: "reply", key: "where_property" }]],
    ["location_reply", [{ kind: "reply", key: "where_located" }]],
    ["confirmed_owner_drip", [{ kind: "drip", drip: "Confirmed owner", skipFirstStep: false }]],
    ["reaction+book_appointment", [{ kind: "drip", drip: "Book appointment", skipFirstStep: false }]],
    ["driving_reply+book_appointment", [{ kind: "reply", key: "driving" }, { kind: "drip", drip: "Book appointment", skipFirstStep: false }]],
    ["bad_number", [{ kind: "hold", reason: "bad_number" }]],
  ])("%s", (road, steps) => {
    expect(actionForV2Decision(jevDecision(road), OFF).steps).toEqual(steps);
  });

  it("alert_on_time_only OFF (today): yes-family roads send the reply AND today's hot alert", () => {
    expect(actionForV2Decision(jevDecision("book_appointment"), TODAY).steps).toEqual([
      { kind: "reply", key: "asked_offer" }, { kind: "alert", reason: "hot_yes" }, { kind: "drip", drip: "Book appointment", skipFirstStep: false },
    ]);
    expect(actionForV2Decision(jevDecision("reaction+book_appointment"), TODAY).steps).toEqual([
      { kind: "alert", reason: "hot_yes" }, { kind: "drip", drip: "Book appointment", skipFirstStep: false },
    ]);
    expect(actionForV2Decision(jevDecision("driving_reply+book_appointment"), TODAY).steps).toEqual([
      { kind: "reply", key: "driving" }, { kind: "alert", reason: "hot_yes" }, { kind: "drip", drip: "Book appointment", skipFirstStep: false },
    ]);
    // Every other road is the same in both flag states.
    for (const road of Object.keys(V2_ROAD_ACTIONS) as V2Road[]) {
      if (["book_appointment", "reaction+book_appointment", "driving_reply+book_appointment"].includes(road)) continue;
      expect(actionForV2Decision(jevDecision(road), TODAY).steps, road).toEqual(actionForV2Decision(jevDecision(road), OFF).steps);
    }
  });

  it("alert_on_time_only ON: no hot alert on a yes (alert only when a time is picked)", () => {
    for (const road of ["book_appointment", "reaction+book_appointment", "driving_reply+book_appointment"] as V2Road[]) {
      expect(actionForV2Decision(jevDecision(road), OFF).steps.some((s) => s.kind === "alert"), road).toBe(false);
    }
  });

  it("book_appointment uses the said-yes text for every yes except asked_offer", () => {
    for (const s of ["open_to_selling", "future_action", "just_ok"]) {
      expect(actionForV2Decision(jevDecision("book_appointment", s), OFF).steps[0]).toEqual({ kind: "reply", key: "said_yes" });
    }
  });

  it("number source replaces (never adds to) a road's reply, and never adds a reply to a no-reply road", () => {
    expect(actionForV2Decision(jevDecision("not_interested_drip"), { ...OFF, askedHowNumber: true }).steps).toEqual([
      { kind: "reply", key: "number_source" },
      { kind: "drip", drip: "Not interested", skipFirstStep: false },
    ]);
    expect(actionForV2Decision(jevDecision("stop"), { ...OFF, askedHowNumber: true }).steps).toEqual([{ kind: "hold", reason: "asked_stop" }]);
    expect(actionForV2Decision(jevDecision("ALERT_call_me"), { ...OFF, askedHowNumber: true }).steps).toEqual([{ kind: "alert", reason: "call_me" }]);
  });

  it("no Jev answer -> hold + Haiku-unsure alert; Haiku error and Haiku-decided stop have their own clear reasons", () => {
    expect(actionForV2Decision({ ...jevDecision("stop"), road: null }, OFF).steps).toEqual([{ kind: "hold", reason: "needs_person" }, { kind: "alert", reason: "haiku_unsure" }]);
    expect(actionForHaikuOutcome("error").steps).toContainEqual({ kind: "alert", reason: "haiku_error" });
    expect(actionForHaikuOutcome("haiku_decided_stop").steps).toEqual([{ kind: "hold", reason: "asked_stop" }, { kind: "alert", reason: "possible_stop" }]);
    expect(V2_ALERT_LABELS.possible_stop).toBe("Possible stop request — please check");
    expect(V2_ALERT_LABELS.haiku_error).toBe("Haiku error — please check");
  });

  it("price-check outcomes use the approved templates (PR-E consumes these)", () => {
    expect(V2_PRICE_CHECK_ACTIONS.fair_or_no_value).toEqual([{ kind: "reply", key: "fair_price" }, { kind: "alert", reason: "named_price" }]);
    expect(V2_PRICE_CHECK_ACTIONS.too_high).toEqual([{ kind: "reply", key: "price_too_high" }]);
    expect(V2_PRICE_CHECK_ACTIONS.no_repairs).toEqual([{ kind: "reply", key: "no_repairs_realtor" }]);
  });

  it("stop beats every other option, including code checks", () => {
    const probs = Object.fromEntries(V2_QUESTION_IDS.map((id) => [id, 0.95])) as Record<(typeof V2_QUESTION_IDS)[number], number>;
    const pt = { house: 0.9, lot: 0.9, commercial: 0.9, multi_family: 0, unknown: 0 } as never;
    const d = routeV2({ reply: "I'm driving STOP", probabilities: probs, propertyType: pt });
    expect(actionForV2Decision(d, TODAY).steps).toEqual([{ kind: "hold", reason: "asked_stop" }]);
  });
});

describe("flags and canary", () => {
  it("anything but literal true is off; malformed config = all off", () => {
    expect(parseRoutingV2Flags(null)).toEqual(ALL_OFF);
    expect(parseRoutingV2Flags([])).toEqual(ALL_OFF);
    const f = parseRoutingV2Flags({ replies: "true", questions_live: 1, drips: true });
    expect([f.replies, f.questions_live, f.drips]).toEqual([false, false, true]);
  });

  it("validates canary_property_ids as UUIDs and canary_percent as an int 0..100", () => {
    const f = parseRoutingV2Flags({ canary_property_ids: [P1, "not-a-uuid", 7, "' or 1=1"], canary_percent: 101 });
    expect([...f.canaryPropertyIds]).toEqual([P1]);
    expect(f.canaryPercent).toBe(0);
    expect(parseRoutingV2Flags({ canary_percent: 12.5 }).canaryPercent).toBe(0);
    expect(parseRoutingV2Flags({ canary_percent: 50 }).canaryPercent).toBe(50);
    expect(isV2Eligible(parseRoutingV2Flags({ canary_percent: 100 }), "not-a-uuid")).toBe(false);
  });

  it("canary_percent is stable per property and monotonic (10 ⊂ 50 ⊂ 100)", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    expect(ids.map(canaryBucket)).toEqual(ids.map(canaryBucket));
    expect(canaryBucket(P1.toUpperCase())).toBe(canaryBucket(P1));
    const pick = (pct: number) => new Set(ids.filter((id) => isV2Eligible(parseRoutingV2Flags({ canary_percent: pct }), id)));
    const [p10, p50, p100] = [pick(10), pick(50), pick(100)];
    expect([...p10].every((id) => p50.has(id))).toBe(true);
    expect([...p50].every((id) => p100.has(id))).toBe(true);
    expect(p100.size).toBe(400);
    expect(pick(0).size).toBe(0);
    expect(p10.size).toBeGreaterThan(15);
    expect(p10.size).toBeLessThan(70);
  });

  it("a slice needs questions_live + its key + eligibility; phone actions need every property eligible", () => {
    const on = parseRoutingV2Flags({ questions_live: true, replies: true, canary_property_ids: [P1] });
    expect(v2SliceAllowed(on, "replies", P1)).toBe(true);
    expect(v2SliceAllowed(on, "drips", P1)).toBe(false);
    expect(v2SliceAllowed({ ...on, questions_live: false }, "replies", P1)).toBe(false);
    expect(v2SliceAllowed(on, "replies", "22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(v2SliceAllowedForAll(on, "replies", [P1, "22222222-2222-4222-8222-222222222222"])).toBe(false);
    expect(v2SliceAllowedForAll(on, "replies", [])).toBe(false);
  });
});

function execDeps(allowed: (slice: string, call: number) => boolean, over: Partial<V2ExecDeps> = {}) {
  let call = 0;
  const log: string[] = [];
  const deps: V2ExecDeps = {
    recheck: async (slice) => allowed(slice, call++),
    sendReply: vi.fn(async (key, text) => {
      log.push(`reply:${key}:${text === v2ReplyText(key)}`);
      return { sent: true };
    }),
    hold: vi.fn(async (r) => void log.push(`hold:${r}`)),
    wrongNumberClose: vi.fn(async () => void log.push("close")),
    alert: vi.fn(async (r) => void log.push(`alert:${r}`)),
    drip: { transition: vi.fn(async (req) => (log.push(`drip:${req.drip}`), { kind: "enrolled" as const, enrollmentId: "e1" })) },
    returnToHumanQueue: vi.fn(async (w) => void log.push(`human:${w}`)),
    ctx: { orgId: "o", propertyId: P1, inboundMessageId: "m1" },
    ...over,
  };
  return { deps, log };
}

describe("executor: flag-off no-op and send-time re-check", () => {
  it("flags off: nothing is sent, held, alerted or enrolled; the inbound goes back to a person", async () => {
    for (const road of Object.keys(V2_ROAD_ACTIONS) as V2Road[]) {
      const { deps, log } = execDeps(() => false);
      const res = await executeV2Action(actionForV2Decision(jevDecision(road), OFF), deps);
      expect(res.kind, road).toBe("cancelled_flag_off");
      expect(log).toEqual(["human:cancelled_flag_off"]);
    }
  });

  it("re-reads the flags before EVERY step: a flip between reply and drip stops the drip", async () => {
    const reads = [true, false];
    let n = 0;
    const read = async () => parseRoutingV2Flags({ questions_live: true, replies: true, drips: reads[n++] ?? false, canary_property_ids: [P1] });
    const { deps, log } = execDeps(() => true, { recheck: makeSendTimeRecheck(read, P1) });
    const res = await executeV2Action(actionForV2Decision(jevDecision("not_interested_drip"), OFF), deps);
    expect(res.kind).toBe("cancelled_flag_off");
    expect(log).toEqual(["reply:not_interested:true", "human:cancelled_flag_off"]);
  });

  it("a property dropped from the canary before send is not sent", async () => {
    let ids = [P1];
    const read = async () => parseRoutingV2Flags({ questions_live: true, replies: true, canary_property_ids: ids });
    const recheck = makeSendTimeRecheck(read, P1);
    expect(await recheck("replies")).toBe(true);
    ids = [];
    expect(await recheck("replies")).toBe(false);
    expect(await makeSendTimeRecheck(async () => { throw new Error("db"); }, P1)("replies")).toBe(false);
  });

  it("a drip that does not enroll (PR-C no-op, error, anything but enrolled/superseded) holds for a person", async () => {
    for (const road of ["confirmed_owner_drip", "vacant_land_drip", "listed_drip", "not_interested_drip"] as V2Road[]) {
      const { deps, log } = execDeps(() => true, { drip: NOOP_DRIP_TRANSITION });
      const res = await executeV2Action(actionForV2Decision(jevDecision(road), OFF), deps);
      expect(res.kind, road).toBe("drip_not_enrolled");
      expect(res).toMatchObject({ reason: "pr_c_not_merged" });
      expect(log.at(-1)).toBe("hold:needs_person");
    }
    const { deps, log } = execDeps(() => true, { drip: { transition: async () => { throw new Error("db"); } } });
    expect(await executeV2Action(actionForV2Decision(jevDecision("confirmed_owner_drip"), OFF), deps)).toMatchObject({ kind: "drip_not_enrolled", reason: "transition_error" });
    expect(log).toEqual(["hold:needs_person"]);
    const sup = execDeps(() => true, { drip: { transition: async () => ({ kind: "superseded" as const }) } });
    expect((await executeV2Action(actionForV2Decision(jevDecision("confirmed_owner_drip"), OFF), sup.deps)).kind).toBe("done");
  });

  it("sends the approved text byte-for-byte; drips go to the PR-C seam", async () => {
    const { deps, log } = execDeps(() => true);
    const res = await executeV2Action(actionForV2Decision(jevDecision("driving_reply+book_appointment"), OFF), deps);
    expect(res.kind).toBe("done");
    expect(log).toEqual(["reply:driving:true", "drip:Book appointment"]);
    expect(await NOOP_DRIP_TRANSITION.transition({} as never)).toEqual({ kind: "not_available", reason: "pr_c_not_merged" });
  });

  it("a reply that did not go out holds for a person and runs nothing after it", async () => {
    const { deps, log } = execDeps(() => true, { sendReply: async () => ({ sent: false, reason: "template_unapproved" }) });
    const res = await executeV2Action(actionForV2Decision(jevDecision("not_interested_drip"), OFF), deps);
    expect(res).toEqual({ kind: "reply_not_sent", done: [], reason: "template_unapproved" });
    expect(log).toEqual(["hold:needs_person"]);
  });
});

describe("seedV2ReplyTemplates", () => {
  it("inserts every approved text unapproved, skipping texts already present", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder, eq: () => builder, is: () => builder, in: () => builder,
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ content: V2_REPLY_TEXTS.driving }], error: null }).then(res),
      insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }),
    });
    const client = { from: () => builder } as never;
    const out = await seedV2ReplyTemplates(client, "org");
    expect(out.alreadyPresent).toEqual(["driving"]);
    expect(out.created).toHaveLength(Object.keys(V2_REPLY_TEXTS).length - 1);
    expect(inserted.every((r) => !("approved_for_auto_send" in r))).toBe(true);
    expect(inserted.map((r) => r.content)).toContain(V2_REPLY_TEXTS.fair_price);
  });
});
