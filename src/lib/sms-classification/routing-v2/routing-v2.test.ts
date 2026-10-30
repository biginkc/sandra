import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NINE_QUESTIONS } from "../nine-questions";
import { haikuEligibility } from "./haiku-eligibility";
import { DEFAULT_CUTOFF, REASON_TO_SELL_CUTOFF, V2_ORDER, type V2Road } from "./order";
import {
  buildV2JevRequest,
  PROPERTY_TYPE_CHOICES,
  PROPERTY_TYPE_INSTRUCTIONS,
  PROPERTY_TYPE_OPTIONS,
  V2_QUESTION_IDS,
  V2_QUESTIONS,
  type PropertyTypeOption,
  type V2QuestionId,
} from "./questions";
import { codePreCheck, routeV2 } from "./route";

// ---------------------------------------------------------------------------
// (a) Byte pins. Approved by Jarrad word for word; a diff here needs his approval of that text.
// ---------------------------------------------------------------------------
const PINNED: Record<V2QuestionId, string> = {
  asked_stop: "Did the homeowner ask to stop receiving texts?",
  legal:
    "Explicit formal/legal demand: attorney/lawyer, legal action, Do Not Call registry, TCPA, or a legal demand to cease all contact. Hostility alone is not dnc. Takes precedence over earlier selling interest.",
  hostile: "Was the homeowner rude or hostile?",
  wrong_person: "Did the homeowner say we have the wrong person, or that they don't own the property?",
  already_sold: "Did the homeowner say they already sold the property?",
  tenant: "Did the homeowner say they are a tenant who rents the property, not the owner?",
  listed: "Did the seller mention the property is listed or working with a REALTOR?",
  asked_call: "Did the homeowner ask us to call them or give a time to talk?",
  inbound_call: "Did the seller indicate that they or someone would place an inbound call to us to discuss an offer?",
  reason_to_sell:
    "Did the seller mention anything that could be causing them to sell, or a reason why they may be accepting of an offer?",
  named_price: "Did the homeowner name a price or amount they want?",
  talked_price: "Did the homeowner mention a price or ask how much we would pay?",
  asked_offer: "Did the homeowner ask what our offer is or how much we would pay?",
  open_to_selling: "Did the homeowner say they are open to selling the property or want an offer?",
  maybe_later: "Did the homeowner say they might sell later, but not right now?",
  not_interested: "Did the homeowner say they are not interested in selling?",
  asked_who: "Did the homeowner ask who is texting them or why?",
  which_property: "Is the seller unclear which property we're messaging about?",
  where_located: "Did the seller ask where our company was located or where I was calling from?",
  future_action: "Did the seller indicate they would take a future action and get back to us?",
  confirmed_owner: "Did the homeowner confirm they are the person or owner we asked about?",
  just_ok: "Did the homeowner just acknowledge or agree to our message without adding anything new?",
  text_only: "Did the seller indicate interest but only want to communicate via text messaging/SMS?",
  how_it_works: "Did the seller ask how the process works or ask about next steps?",
  own_other_property: "Did the seller mention another property that they own and are interested in selling?",
  someone_else_property:
    "Did the seller mention a different property, not the one we asked about and not one they own, that may be for sale?",
};

describe("routing v2 questions — byte pins", () => {
  it("pins every v2 question text and the id list", () => {
    expect(V2_QUESTION_IDS).toEqual(Object.keys(PINNED));
    for (const id of V2_QUESTION_IDS) expect(V2_QUESTIONS[id]).toBe(PINNED[id]);
    expect(Object.keys(V2_QUESTIONS).sort()).toEqual([...V2_QUESTION_IDS].sort());
  });

  it("pins the property type question and its five choices", () => {
    expect(PROPERTY_TYPE_INSTRUCTIONS).toBe("Did the owner indicate the property type?");
    expect(PROPERTY_TYPE_OPTIONS).toEqual(["residential", "lot", "commercial", "rental", "didnt_say"]);
    expect(PROPERTY_TYPE_CHOICES).toEqual({
      residential: "Residential (house, townhouse, condo)",
      lot: "Lot or vacant land",
      commercial: "Commercial (business, church, commercial building)",
      rental: "Rental",
      didnt_say: "Didn't say",
    });
  });

  it("uses the Oct-1 stop wording, not the live one, and does not change the live set", () => {
    expect(V2_QUESTIONS.asked_stop).not.toBe(NINE_QUESTIONS.asked_stop);
    expect(NINE_QUESTIONS.asked_stop).toBe("Did the homeowner request that communication cease?");
  });

  it("builds one Jev request with every question and the choice", () => {
    const req = buildV2JevRequest({ our_last_text_to_homeowner: "x", homeowner_reply: "y" });
    expect(Object.keys(req.questions)).toEqual([...V2_QUESTION_IDS, "property_type"]);
    expect(req.questions.property_type).toEqual({ type: "choice", instructions: PROPERTY_TYPE_INSTRUCTIONS, criteria: PROPERTY_TYPE_CHOICES });
  });

  it("pins the order and cutoffs", () => {
    expect(DEFAULT_CUTOFF).toBe(0.6);
    expect(REASON_TO_SELL_CUTOFF).toBe(0.4);
    expect(V2_ORDER.map((s) => `${s.row}:${s.step}>${s.road}:${s.signals.map((x) => `${x.signal}@${x.cutoff}`).join("|")}`)).toEqual([
      "1:legal_hostile>stop:legal@0.6|hostile@0.6",
      "2:asked_stop>stop:asked_stop@0.6",
      "2b:asked_call>ALERT_call_me:asked_call@0.6",
      "3:wrong>wrong_number_close:wrong_person@0.6|already_sold@0.6|tenant@0.6",
      "4:pt_lot>vacant_land_drip:PT:lot@0.6",
      "4:pt_comm>ALERT_commercial:PT:commercial@0.6",
      "5:listed>listed_drip:listed@0.6",
      "6:text_only>text_only_reply:text_only@0.6",
      "7:how_it_works>how_it_works_reply:how_it_works@0.6",
      "9:inbound>ALERT_said_theyll_call:inbound_call@0.6",
      "10:reason_to_sell>ALERT_reason_to_sell:reason_to_sell@0.4",
      "11:price>price_check:named_price@0.6|talked_price@0.6",
      "12:book>book_appointment:asked_offer@0.6|open_to_selling@0.6|future_action@0.6",
      "13:maybe_later>maybe_later_drip:maybe_later@0.6",
      "14:not_interested>not_interested_drip:not_interested@0.6",
      "15:who>who_reply_drip:asked_who@0.6",
      "16:which_property>which_property_reply:which_property@0.6",
      "17:where_located>location_reply:where_located@0.6",
      "18:confirmed_owner>confirmed_owner_drip:confirmed_owner@0.6",
      "19:just_ok>book_appointment:just_ok@0.6",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) Deterministic fixtures (STRESS §2.1/§2.2, golden_rules_test.py).
// ---------------------------------------------------------------------------
function input(kw: Partial<Record<V2QuestionId, number>> & { pt?: PropertyTypeOption } = {}, reply = "reply") {
  const { pt = "didnt_say", ...probs } = kw;
  const probabilities = Object.fromEntries(V2_QUESTION_IDS.map((q) => [q, 0.02])) as Record<V2QuestionId, number>;
  Object.assign(probabilities, probs);
  const propertyType = Object.fromEntries(PROPERTY_TYPE_OPTIONS.map((o) => [o, o === pt ? 0.9 : 0.02])) as Record<PropertyTypeOption, number>;
  return { reply, probabilities, propertyType };
}

const CASES: Array<[string, Parameters<typeof input>[0], V2Road | null]> = [
  ["Okay alone → Book appointment", { just_ok: 0.9 }, "book_appointment"],
  ["Okay + not interested .86 → Not interested", { just_ok: 0.68, not_interested: 0.86 }, "not_interested_drip"],
  ["Call me + listed → call", { asked_call: 0.9, listed: 0.95 }, "ALERT_call_me"],
  ["Call me + wrong person → call", { asked_call: 0.9, wrong_person: 0.9 }, "ALERT_call_me"],
  ["Call me + commercial → call", { asked_call: 0.9, pt: "commercial" }, "ALERT_call_me"],
  ["Call me + text only → call", { asked_call: 0.9, text_only: 0.9 }, "ALERT_call_me"],
  ["Stop beats call me", { asked_stop: 0.9, asked_call: 0.9 }, "stop"],
  ["Legal beats call me", { legal: 0.9, asked_call: 0.9 }, "stop"],
  ["Hostile beats call me", { hostile: 0.9, asked_call: 0.9 }, "stop"],
  ["Hostile beats price", { hostile: 0.96, named_price: 0.9 }, "stop"],
  ["Lot + named price → land alert", { named_price: 0.9, pt: "lot" }, "ALERT_land_price"],
  ["Lot + talked price → land alert", { talked_price: 0.9, pt: "lot" }, "ALERT_land_price"],
  ["Lot no price → Vacant land", { pt: "lot" }, "vacant_land_drip"],
  ["Commercial + listed → commercial alert", { listed: 0.95, pt: "commercial" }, "ALERT_commercial"],
  ["Listed + price → Listed drip", { listed: 0.95, named_price: 0.9 }, "listed_drip"],
  ["Text only beats price", { text_only: 0.9, named_price: 0.9 }, "text_only_reply"],
  ["How it works beats offer", { how_it_works: 0.9, asked_offer: 0.9 }, "how_it_works_reply"],
  ["Said they'll call → alert", { inbound_call: 0.9 }, "ALERT_said_theyll_call"],
  ["Reason to sell at 45% → alert", { reason_to_sell: 0.45, not_interested: 0.9 }, "ALERT_reason_to_sell"],
  ["Maybe later", { maybe_later: 0.9 }, "maybe_later_drip"],
  ["Who is this", { asked_who: 0.9 }, "who_reply_drip"],
  ["Who .91 + inbound .51 → who reply", { asked_who: 0.91, inbound_call: 0.51 }, "who_reply_drip"],
  ["Nothing fits → no road", {}, null],
];

describe("routing v2 — deterministic fixtures", () => {
  it.each(CASES)("%s", (_name, kw, road) => {
    expect(routeV2(input(kw)).road).toBe(road);
  });

  it("stop 0.65 → stop, Haiku-eligible", () => {
    const d = routeV2(input({ asked_stop: 0.65 }));
    expect(d.road).toBe("stop");
    expect(d.haiku).toBe("decider_band");
  });

  it("stop 0.75 → stop, final (no Haiku)", () => {
    const d = routeV2(input({ asked_stop: 0.75, asked_call: 0.9 }));
    expect(d.road).toBe("stop");
    expect(d.haiku).toBeNull();
  });

  it("legal/hostile ≥0.70 are final", () => {
    expect(routeV2(input({ legal: 0.7 })).haiku).toBeNull();
    expect(routeV2(input({ hostile: 0.95 })).haiku).toBeNull();
  });

  it("who 0.91 + inbound 0.51 → who reply, no Haiku", () => {
    const d = routeV2(input({ asked_who: 0.91, inbound_call: 0.51 }));
    expect(d.road).toBe("who_reply_drip");
    expect(d.haiku).toBeNull();
  });

  it("reason to sell 0.45 → alert, Haiku-eligible; 0.55 → no Haiku", () => {
    expect(routeV2(input({ reason_to_sell: 0.45 })).haiku).toBe("rts_band");
    expect(routeV2(input({ reason_to_sell: 0.55 })).haiku).toBeNull();
  });

  it("no match → Haiku-eligible", () => {
    expect(routeV2(input({})).haiku).toBe("no_match");
    expect(haikuEligibility(null)).toBe("no_match");
  });

  it("records provenance", () => {
    expect(routeV2(input({ asked_call: 0.8 })).provenance).toEqual({ by: "jev", row: "2b", step: "asked_call", signal: "asked_call", probability: 0.8 });
  });

  it("opportunity questions alert alongside, main road unchanged", () => {
    const d = routeV2(input({ not_interested: 0.9, own_other_property: 0.8 }));
    expect(d.road).toBe("not_interested_drip");
    expect(d.opportunityAlert).toBe(true);
    expect(routeV2(input({ someone_else_property: 0.7 })).opportunityAlert).toBe(true);
    expect(routeV2(input({ someone_else_property: 0.59 })).opportunityAlert).toBe(false);
  });

  it.each([
    ["Loved “Checking in”", "reaction+book_appointment"],
    ["I'm Driving\n\n- Sent from My Car", "driving_reply+book_appointment"],
    ["The number you are sending an SMS to,currently has no SMS capabilities.", "bad_number"],
  ])("code pre-check: %s", (reply, road) => {
    const d = routeV2(input({ asked_stop: 0.99 }, reply));
    expect(d.road).toBe(road);
    expect(d.provenance.by).toBe("code");
    expect(d.haiku).toBeNull();
  });

  it("plain text is not a code pre-check", () => {
    expect(codePreCheck("I loved that house")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) Replay gate: the pinned v7 replay (1,752 replies), recorded Jev probabilities only.
// Fixture has no reply text, names, phones or ids. Haiku's recorded answers are applied by a
// test-only oracle (route_v7.py's post-Haiku step) to reproduce the pinned final table.
// ---------------------------------------------------------------------------
type Row = [string | null, Array<number | null> | null, number[] | null, [string, number] | null | 0, string, string, 0 | 1];
const FIX = JSON.parse(readFileSync(join(__dirname, "__fixtures__/replay-v7.json"), "utf8")) as {
  questionOrder: V2QuestionId[];
  propertyTypeOrder: PropertyTypeOption[];
  rows: Row[];
};

const HAIKU_ROADS: Record<string, string> = {
  legal: "stop", hostile: "stop", asked_stop: "stop", wrong_person: "wrong_number_close", already_sold: "wrong_number_close",
  tenant: "wrong_number_close", lot: "vacant_land_drip", commercial: "ALERT_commercial", listed: "listed_drip",
  asked_call: "ALERT_call_me", inbound_call: "ALERT_said_theyll_call", reason_to_sell: "ALERT_reason_to_sell",
  named_price: "price_check", talked_price: "price_check", asked_offer: "book_appointment", open_to_selling: "book_appointment",
  maybe_yes: "book_appointment", future_action: "book_appointment", maybe_later: "maybe_later_drip",
  not_interested: "not_interested_drip", asked_who: "who_reply_drip", which_property: "which_property_reply",
  location_reply: "location_reply", where_located: "location_reply", confirmed_owner: "confirmed_owner_drip",
  text_only: "text_only_reply", how_it_works: "how_it_works_reply", just_ok: "book_appointment",
};
const CODE_REPLY: Record<string, string> = { reaction: "Liked “x”", bad_number: "no SMS capabilities", driving: "I'm driving" };

describe("routing v2 — replay gate (v7)", () => {
  const roads: Record<string, number> = {};
  let haikuCalls = 0;
  let haikuStops = 0;
  let alerts = 0;
  const mismatches: string[] = [];

  FIX.rows.forEach(([code, p, pt, haiku, expRoad, expBy, sell], i) => {
    const probabilities = Object.fromEntries(FIX.questionOrder.map((q, k) => [q, p?.[k] ?? 0])) as Record<V2QuestionId, number>;
    const propertyType = Object.fromEntries(FIX.propertyTypeOrder.map((o, k) => [o, pt?.[k] ?? 0])) as Record<PropertyTypeOption, number>;
    const d = routeV2({ reply: code ? CODE_REPLY[code] : "x", probabilities, propertyType });
    let road: string | null = d.road;
    let by = d.provenance.by === "code" ? "code" : "Jev";
    if (d.haiku) {
      haikuCalls++;
      const h = haiku === 0 ? null : haiku;
      let hr: string | null = h && h[0] !== "needs_person" && h[1] >= 0.5 ? (HAIKU_ROADS[h[0]] ?? null) : null;
      if (hr === "vacant_land_drip" && (probabilities.named_price >= 0.6 || probabilities.talked_price >= 0.6)) hr = "ALERT_land_price";
      if (hr) { road = hr; by = "Haiku"; }
      else if (road) by = "Jev(haiku unsure)";
      else { road = "ALERT_haiku_unsure"; by = "Haiku(unsure)"; }
    }
    if (road === "stop" && by === "Haiku") haikuStops++;
    if (road!.startsWith("ALERT_") || d.opportunityAlert) alerts++;
    roads[road!] = (roads[road!] ?? 0) + 1;
    if (road !== expRoad || by !== expBy || (d.opportunityAlert ? 1 : 0) !== sell) mismatches.push(`${i}: ${road}/${by} vs ${expRoad}/${expBy}`);
  });

  it("reproduces every recorded decision", () => {
    expect(FIX.rows).toHaveLength(1752);
    expect(mismatches).toEqual([]);
  });

  it("pins the §3 table, Haiku-call count and alert counts", () => {
    expect(roads).toEqual({
      not_interested_drip: 783, book_appointment: 242, price_check: 186, wrong_number_close: 109, stop: 107,
      ALERT_call_me: 93, listed_drip: 35, who_reply_drip: 35, maybe_later_drip: 27, ALERT_haiku_unsure: 26,
      which_property_reply: 22, vacant_land_drip: 19, ALERT_commercial: 17, ALERT_reason_to_sell: 10, location_reply: 10,
      text_only_reply: 9, "reaction+book_appointment": 7, confirmed_owner_drip: 4, ALERT_land_price: 3,
      "driving_reply+book_appointment": 3, ALERT_said_theyll_call: 2, how_it_works_reply: 2, bad_number: 1,
    });
    expect(haikuCalls).toBe(275);
    expect(alerts).toBe(164);
    expect(alerts + haikuStops).toBe(174);
  });
});
