/**
 * Stress Layer B (STRESS-TEST-DESIGN §2.1, §2.2): precedence conflicts and band edges against the
 * PRODUCTION router (routeV2) with hand-built probability vectors. No network.
 * MUTATE=<name> swaps one ORDER-TABLE entry first; the suite must then FAIL (mutation check).
 */
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Mod = typeof import("@/lib/sms-classification/routing-v2/route");
type Q = import("@/lib/sms-classification/routing-v2/questions").V2QuestionId;
type PT = import("@/lib/sms-classification/routing-v2/questions").PropertyTypeOption;

let routeV2: Mod["routeV2"];
let assertCompleteV2: Mod["assertCompleteV2"];
let IDS: readonly Q[];

const ORDER_PATH = path.resolve(__dirname, "../../../src/lib/sms-classification/routing-v2/order.ts");

beforeAll(async () => {
  const mutate = process.env.MUTATE;
  if (mutate) {
    const real = await vi.importActual<typeof import("@/lib/sms-classification/routing-v2/order")>(ORDER_PATH);
    const order = [...real.V2_ORDER];
    const swap = (a: string, b: string) => {
      const i = order.findIndex((s) => s.step === a);
      const j = order.findIndex((s) => s.step === b);
      [order[i], order[j]] = [order[j], order[i]];
    };
    if (mutate === "call_after_wrong") swap("asked_call", "wrong");
    else if (mutate === "listed_before_lot") swap("pt_lot", "listed");
    else if (mutate === "rts_after_price") swap("reason_to_sell", "price");
    else throw new Error(`unknown MUTATE ${mutate}`);
    vi.doMock(ORDER_PATH, () => ({ ...real, V2_ORDER: order }));
  }
  ({ routeV2, assertCompleteV2 } = await import("@/lib/sms-classification/routing-v2/route"));
  IDS = (await import("@/lib/sms-classification/routing-v2/questions")).V2_QUESTION_IDS;
});

const LOW = 0.02;
function input(over: Partial<Record<Q, number>>, pt: Partial<Record<PT, number>> = {}, reply = "test reply") {
  const probabilities = Object.fromEntries(IDS.map((id) => [id, over[id] ?? LOW])) as Record<Q, number>;
  const propertyType = { residential: LOW, lot: LOW, commercial: LOW, rental: LOW, didnt_say: 0.9, ...pt } as Record<PT, number>;
  return { reply, probabilities, propertyType };
}
const road = (over: Partial<Record<Q, number>>, pt?: Partial<Record<PT, number>>, reply?: string) => routeV2(input(over, pt, reply)).road;
const dec = (over: Partial<Record<Q, number>>, pt?: Partial<Record<PT, number>>, reply?: string) => routeV2(input(over, pt, reply));

describe("§2.1 precedence (every co-firing pair named in the design)", () => {
  const H = 0.9;
  const cases: Array<[string, Partial<Record<Q, number>>, Partial<Record<PT, number>> | undefined, string | null]> = [
    ["legal + asked_offer → stop", { legal: H, asked_offer: H }, undefined, "stop"],
    ["hostile + named_price → stop", { hostile: H, named_price: H }, undefined, "stop"],
    ["asked_stop + asked_call → stop", { asked_stop: H, asked_call: H }, undefined, "stop"],
    ["tenant + open_to_selling → wrong_number_close", { tenant: H, open_to_selling: H }, undefined, "wrong_number_close"],
    ["listed + named_price → listed_drip", { listed: H, named_price: H }, undefined, "listed_drip"],
    ["PT:lot + listed → vacant_land_drip (PT before listed)", { listed: H }, { lot: H }, "vacant_land_drip"],
    ["PT:commercial + listed → ALERT_commercial", { listed: H }, { commercial: H }, "ALERT_commercial"],
    ["PT:commercial + asked_stop → stop", { asked_stop: H }, { commercial: H }, "stop"],
    ["PT:lot + named_price → ALERT_land_price", { named_price: H }, { lot: H }, "ALERT_land_price"],
    ["PT:lot + talked_price → ALERT_land_price", { talked_price: H }, { lot: H }, "ALERT_land_price"],
    ["PT:lot, no price → vacant_land_drip", {}, { lot: H }, "vacant_land_drip"],
    ["asked_call + listed → ALERT_call_me", { asked_call: H, listed: H }, undefined, "ALERT_call_me"],
    ["asked_call + PT:lot → ALERT_call_me", { asked_call: H }, { lot: H }, "ALERT_call_me"],
    ["asked_call + PT:commercial → ALERT_call_me", { asked_call: H }, { commercial: H }, "ALERT_call_me"],
    ["asked_call + wrong_person → ALERT_call_me", { asked_call: H, wrong_person: H }, undefined, "ALERT_call_me"],
    ["asked_call + named_price → ALERT_call_me", { asked_call: H, named_price: H }, undefined, "ALERT_call_me"],
    ["asked_call + text_only → ALERT_call_me", { asked_call: H, text_only: H }, undefined, "ALERT_call_me"],
    ["asked_call + legal → stop", { asked_call: H, legal: H }, undefined, "stop"],
    ["asked_call + hostile → stop", { asked_call: H, hostile: H }, undefined, "stop"],
    ["asked_call + inbound_call → ALERT_call_me", { asked_call: H, inbound_call: H }, undefined, "ALERT_call_me"],
    ["inbound_call + reason_to_sell → ALERT_said_theyll_call", { inbound_call: H, reason_to_sell: H }, undefined, "ALERT_said_theyll_call"],
    ["reason_to_sell 0.41 + not_interested 0.9 → ALERT_reason_to_sell", { reason_to_sell: 0.41, not_interested: H }, undefined, "ALERT_reason_to_sell"],
    ["reason_to_sell 0.9 + named_price 0.9 → ALERT_reason_to_sell (row 10 before 11)", { reason_to_sell: H, named_price: H }, undefined, "ALERT_reason_to_sell"],
    ["inbound_call + named_price → ALERT_said_theyll_call", { inbound_call: H, named_price: H }, undefined, "ALERT_said_theyll_call"],
    ["named_price + not_interested → price_check", { named_price: H, not_interested: H }, undefined, "price_check"],
    ["named_price + asked_offer → price_check", { named_price: H, asked_offer: H }, undefined, "price_check"],
    ["talked_price + open_to_selling → price_check", { talked_price: H, open_to_selling: H }, undefined, "price_check"],
    ["future_action + maybe_later → book_appointment", { future_action: H, maybe_later: H }, undefined, "book_appointment"],
    ["open_to_selling + not_interested → book_appointment", { open_to_selling: H, not_interested: H }, undefined, "book_appointment"],
    ["asked_who + which_property → who_reply_drip", { asked_who: H, which_property: H }, undefined, "who_reply_drip"],
    ["which_property + where_located → which_property_reply", { which_property: H, where_located: H }, undefined, "which_property_reply"],
    ["just_ok + not_interested → not_interested_drip", { just_ok: H, not_interested: H }, undefined, "not_interested_drip"],
    ["just_ok + asked_who → who_reply_drip", { just_ok: H, asked_who: H }, undefined, "who_reply_drip"],
    ["just_ok alone → book_appointment", { just_ok: H }, undefined, "book_appointment"],
    ["lot 0.59 + residential 0.41 → not lot (nothing fires)", {}, { lot: 0.59, residential: 0.41, didnt_say: 0 }, null],
    ["lot 0.60 exactly → vacant_land_drip", {}, { lot: 0.6, didnt_say: 0.4 }, "vacant_land_drip"],
    ["text_only + how_it_works → text_only_reply", { text_only: H, how_it_works: H }, undefined, "text_only_reply"],
    ["how_it_works + inbound_call → how_it_works_reply", { how_it_works: H, inbound_call: H }, undefined, "how_it_works_reply"],
    ["listed + text_only → listed_drip", { listed: H, text_only: H }, undefined, "listed_drip"],
    ["wrong_person + PT:lot → wrong_number_close", { wrong_person: H }, { lot: H }, "wrong_number_close"],
    ["already_sold + reason_to_sell → wrong_number_close", { already_sold: H, reason_to_sell: H }, undefined, "wrong_number_close"],
    ["maybe_later + not_interested → maybe_later_drip", { maybe_later: H, not_interested: H }, undefined, "maybe_later_drip"],
    ["where_located + confirmed_owner → location_reply", { where_located: H, confirmed_owner: H }, undefined, "location_reply"],
    ["confirmed_owner + just_ok → confirmed_owner_drip", { confirmed_owner: H, just_ok: H }, undefined, "confirmed_owner_drip"],
  ];
  it.each(cases)("%s", (_n, over, pt, want) => expect(road(over, pt)).toBe(want));

  it("code pre-checks lose to stop/legal/hostile, beat everything else", () => {
    expect(road({ asked_stop: 0.9 }, undefined, "STOP i'm driving")).toBe("stop");
    expect(road({ hostile: 0.9 }, undefined, 'Disliked "Hi Bob"')).toBe("stop");
    expect(road({ asked_call: 0.9 }, undefined, "I'm driving, call me later")).toBe("driving_reply+book_appointment");
    expect(road({ named_price: 0.9 }, undefined, 'Liked "want 200k"')).toBe("reaction+book_appointment");
    expect(road({ asked_offer: 0.9 }, undefined, "This number has no SMS capabilities")).toBe("bad_number");
    expect(dec({}, undefined, 'Loved "hello"').haiku).toBeNull();
  });
  it("opportunity alert runs alongside the order (deduped flag), never changes the road", () => {
    const d = dec({ own_other_property: 0.7, not_interested: 0.9 });
    expect(d.road).toBe("not_interested_drip");
    expect(d.opportunityAlert).toBe(true);
    expect(dec({ someone_else_property: 0.6 }).opportunityAlert).toBe(true);
    expect(dec({ someone_else_property: 0.59 }).opportunityAlert).toBe(false);
  });
});

describe("§2.2 band edges (exact floats)", () => {
  it.each([
    [0.59, null, "no_match"],
    [0.6, "stop", "decider_band"],
    [0.69, "stop", "decider_band"],
    [0.7, "stop", null],
    [0.71, "stop", null],
  ] as const)("asked_stop %s → road %s, haiku %s", (p, r, h) => {
    const d = dec({ asked_stop: p });
    expect(d.road).toBe(r);
    expect(d.haiku).toBe(h);
  });
  it.each(["legal", "hostile"] as const)("%s has the same edges", (q) => {
    expect(dec({ [q]: 0.59 }).road).toBeNull();
    expect(dec({ [q]: 0.6 }).haiku).toBe("decider_band");
    expect(dec({ [q]: 0.69 }).haiku).toBe("decider_band");
    expect(dec({ [q]: 0.7 }).haiku).toBeNull();
    expect(dec({ [q]: 0.7 }).road).toBe("stop");
  });
  it.each([
    [0.29, null, "no_match"],
    [0.3, null, "no_match"],
    [0.39, null, "no_match"],
    [0.4, "ALERT_reason_to_sell", "rts_band"],
    [0.49, "ALERT_reason_to_sell", "rts_band"],
    [0.5, "ALERT_reason_to_sell", null],
    [0.69, "ALERT_reason_to_sell", null],
  ] as const)("reason_to_sell %s → %s, haiku %s (records build: 0.30–0.39 = no answer → Haiku via no_match)", (p, r, h) => {
    const d = dec({ reason_to_sell: p });
    expect(d.road).toBe(r);
    expect(d.haiku).toBe(h);
  });
  it.each([
    [0.49, null, "no_match"],
    [0.5, null, "no_match"],
    [0.59, null, "no_match"],
    [0.6, "not_interested_drip", "decider_band"],
    [0.69, "not_interested_drip", "decider_band"],
    [0.7, "not_interested_drip", null],
    [0.71, "not_interested_drip", null],
  ] as const)("deciding answer (not_interested) %s → %s, haiku %s", (p, r, h) => {
    const d = dec({ not_interested: p });
    expect(d.road).toBe(r);
    expect(d.haiku).toBe(h);
  });
  it("confident decider + borderline non-deciding signal → no Haiku", () => {
    expect(dec({ asked_who: 0.91, inbound_call: 0.51 })).toMatchObject({ road: "who_reply_drip", haiku: null });
    expect(dec({ asked_stop: 0.75, not_interested: 0.55 })).toMatchObject({ road: "stop", haiku: null });
  });
  it("no other_band trigger: non-deciding 0.50–0.59 → no Haiku; 0.60 → becomes a candidate by order", () => {
    expect(dec({ not_interested: 0.9, inbound_call: 0.55 })).toMatchObject({ road: "not_interested_drip", haiku: null });
    expect(dec({ not_interested: 0.9, inbound_call: 0.6 })).toMatchObject({ road: "ALERT_said_theyll_call", haiku: "decider_band" });
  });
  it("floating point edges", () => {
    expect(dec({ asked_stop: 0.6000000001 }).road).toBe("stop");
    expect(dec({ asked_stop: 0.5999999999 }).road).toBeNull();
    expect(dec({ asked_stop: 0.6999999999 }).haiku).toBe("decider_band");
  });
  it("invalid probabilities fail closed (never a yes): strings, NaN, <0, >1, null, missing", () => {
    for (const bad of ["0.6", Number.NaN, -0.1, 1.2, null, undefined, Infinity]) {
      const answers: Record<string, { noul?: unknown; probabilities?: Record<string, unknown> }> = Object.fromEntries(
        IDS.map((id) => [id, { noul: 0.02 }]),
      );
      answers.property_type = { probabilities: { residential: 0.1, lot: 0.1, commercial: 0.1, rental: 0.1, didnt_say: 0.6 } };
      answers.asked_stop = { noul: bad };
      const r = assertCompleteV2(answers);
      expect(r.ok, String(bad)).toBe(false);
    }
    const answers: Record<string, { noul?: unknown; probabilities?: Record<string, unknown> }> = Object.fromEntries(IDS.map((id) => [id, { noul: 0.02 }]));
    answers.property_type = { probabilities: { residential: 0.1, lot: "0.9", commercial: 0.1, rental: 0.1, didnt_say: 0.6 } };
    expect(assertCompleteV2(answers).ok).toBe(false);
  });
});
