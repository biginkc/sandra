import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEALMACHINE_ENRICH_ADDRESS_PATH,
  buildDealMachineEnrichRequest,
  fetchDealMachineEstimatedValue,
  parseDealMachineEnrichResponse,
  parseRetryAfterSeconds,
  type DealMachineAttempt,
} from "@/lib/comps/providers/dealmachine";

import { V2_PRICE_CHECK_ACTIONS, V2_ROAD_ACTIONS, actionForV2Decision } from "./actions";
import { DM_CALLS_PER_MINUTE, lookupDealMachineValue, type ClaimOutcome, type DealMachineCacheStore, type SettleState } from "./dealmachine-value";
import { ALL_OFF, type RoutingV2Flags } from "./flags";
import { askAboveEightyPercent, extractDollarAmount } from "./price-amount";
import {
  REPAIRS_FOLLOW_UP_CUTOFF,
  REPAIRS_FOLLOW_UP_PRECEDENCE_ROADS,
  decideRepairsFollowUp,
  readRepairsFollowUps,
  isAfterRepairsReply,
  runV2PriceCheck,
  v2PriceCheckFlagOffAction,
} from "./price-check";
import {
  REPAIRS_ALERT_IDS,
  REPAIRS_FOLLOW_UP_IDS,
  REPAIRS_FOLLOW_UP_QUESTIONS,
  V2_QUESTION_IDS,
  buildV2JevRequest,
  type PropertyTypeOption,
  type RepairsFollowUpId,
  type V2QuestionId,
} from "./questions";
import { v2ReplyText } from "./reply-texts";
import { routeV2, type V2Decision } from "./route";

const PROP = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const ON: RoutingV2Flags = {
  ...ALL_OFF,
  questions_live: true,
  price_check: true,
  canaryPropertyIds: new Set([PROP]),
};

const DECISION: V2Decision = {
  road: "price_check",
  provenance: { by: "jev", row: "11", step: "price", signal: "named_price", probability: 0.9 },
  haiku: null,
  opportunityAlert: false,
};

const PT = (over: Partial<Record<PropertyTypeOption, number>> = {}): Record<PropertyTypeOption, number> => ({
  residential: 0.9,
  lot: 0.01,
  commercial: 0.01,
  rental: 0.01,
  didnt_say: 0.05,
  ...over,
});

const FAIR = { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.fair_or_no_value };
const TOO_HIGH = { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.too_high };

describe("extractDollarAmount", () => {
  const table: Array<[string, ReturnType<typeof extractDollarAmount>]> = [
    // single
    ["I'd take $150k", { kind: "single", amount: 150_000 }],
    ["150,000", { kind: "single", amount: 150_000 }],
    ["150k and it's yours", { kind: "single", amount: 150_000 }],
    ["$1.2M", { kind: "single", amount: 1_200_000 }],
    ["want $150,000.00 firm", { kind: "single", amount: 150_000 }],
    ["149.9k", { kind: "single", amount: 149_900 }],
    ["$150.5K", { kind: "single", amount: 150_500 }],
    ["$95000", { kind: "single", amount: 95_000 }],
    ["$ 85,000", { kind: "single", amount: 85_000 }],
    ["150 thousand", { kind: "single", amount: 150_000 }],
    ["1.5 million", { kind: "single", amount: 1_500_000 }],
    ["150 grand", { kind: "single", amount: 150_000 }],
    ["150000 dollars", { kind: "single", amount: 150_000 }],
    ["2.5mil", { kind: "single", amount: 2_500_000 }],
    ["$150k. Yes $150k.", { kind: "single", amount: 150_000 }],
    ["$150k or 150,000 same thing", { kind: "range", amounts: [150_000] }],
    ["Asking $150k for 123 Main St", { kind: "single", amount: 150_000 }],
    ["$150k, call me 816-555-1234", { kind: "single", amount: 150_000 }],
    ["150k (816) 555-1234", { kind: "single", amount: 150_000 }],
    // none
    ["Not interested", { kind: "none" }],
    ["How much would you pay?", { kind: "none" }],
    ["123 Main St, Kansas City MO 64111", { kind: "none" }],
    ["Call me at 816-555-1234", { kind: "none" }],
    ["(816) 555-1234", { kind: "none" }],
    ["8165551234", { kind: "none" }],
    ["3 bed 2 bath built in 1985", { kind: "none" }],
    ["2k sq ft", { kind: "none" }],
    ["1,800 sqft on 5 acres", { kind: "none" }],
    ["It's at 1500 K Street", { kind: "none" }],
    ["150000", { kind: "none" }],
    ["give me 2 weeks", { kind: "none" }],
    ["1,2,3", { kind: "none" }],
    // multiple
    ["Paid $90k, want $150k", { kind: "multiple", amounts: [90_000, 150_000] }],
    ["House A $150k, house B $200k", { kind: "multiple", amounts: [150_000, 200_000] }],
    // range
    ["150-170k", { kind: "range", amounts: [170_000] }],
    ["$150k-$170k", { kind: "range", amounts: [150_000, 170_000] }],
    ["$150k to $170k", { kind: "range", amounts: [150_000, 170_000] }],
    ["between 150k and 170k", { kind: "range", amounts: [150_000, 170_000] }],
    ["150k or 160k", { kind: "range", amounts: [150_000, 160_000] }],
    ["somewhere 150,000 – 175,000", { kind: "range", amounts: [150_000, 175_000] }],
  ];
  it.each(table)("%s", (text, expected) => {
    expect(extractDollarAmount(text)).toEqual(expected);
  });
});

describe("askAboveEightyPercent", () => {
  it("exactly 80% is not too high; one cent over is", () => {
    expect(askAboveEightyPercent(80_000, 100_000)).toBe(false);
    expect(askAboveEightyPercent(80_000.01, 100_000)).toBe(true);
    expect(askAboveEightyPercent(79_999.99, 100_000)).toBe(false);
    expect(askAboveEightyPercent(120_000, 150_000)).toBe(false); // exactly 80%
    expect(askAboveEightyPercent(1_200_000, 1_500_000)).toBe(false);
    expect(askAboveEightyPercent(1_200_001, 1_500_000)).toBe(true);
  });
});

describe("runV2PriceCheck", () => {
  const run = (reply: string, lookup: () => Promise<{ kind: "value"; value: number; source: "provider" } | { kind: "no_value"; reason: string }>, over: { flags?: RoutingV2Flags; pt?: Partial<Record<PropertyTypeOption, number>> } = {}) => {
    const lookupValue = vi.fn(lookup);
    return {
      lookupValue,
      result: runV2PriceCheck({
        flags: over.flags ?? ON,
        propertyId: PROP,
        decision: DECISION,
        reply,
        propertyType: PT(over.pt),
        lookupValue,
      }),
    };
  };
  const value = (v: number) => async () => ({ kind: "value" as const, value: v, source: "provider" as const });

  it("flag off: today's price alert, byte-identical, DealMachine never asked", async () => {
    for (const flags of [ALL_OFF, { ...ON, price_check: false }, { ...ON, questions_live: false }, { ...ON, canaryPropertyIds: new Set<string>() }]) {
      const { result, lookupValue } = run("$150k", value(100_000), { flags });
      const r = await result;
      expect(r.outcome).toBe("flag_off");
      expect(r.action).toEqual(actionForV2Decision(DECISION));
      expect(JSON.stringify(r.action)).toBe(JSON.stringify({ road: "price_check", steps: V2_ROAD_ACTIONS.price_check(DECISION) }));
      expect(r.action.steps).toEqual([
        { kind: "reply", key: "named_price" },
        { kind: "alert", reason: "named_price" },
      ]);
      expect(lookupValue).not.toHaveBeenCalled();
    }
    expect(v2PriceCheckFlagOffAction(DECISION)).toEqual(actionForV2Decision(DECISION));
  });

  it("ask > 80% → repairs reply", async () => {
    const r = await run("I want $150k", value(150_000)).result;
    expect(r).toMatchObject({ outcome: "too_high", action: TOO_HIGH, value: 150_000 });
  });

  it("ask exactly 80% → fair-price reply + alert", async () => {
    const r = await run("$120,000", value(150_000)).result;
    expect(r).toMatchObject({ outcome: "fair", action: FAIR });
  });

  it("ask below 80% → fair-price reply + alert", async () => {
    const r = await run("100k", value(150_000)).result;
    expect(r).toMatchObject({ outcome: "fair", action: FAIR });
  });

  it.each(["no idea, make me an offer", "$90k or $100k", "150-170k", "Paid 90k want 150k"])(
    "no single amount (%s) → fair-price reply + alert, no DealMachine call",
    async (reply) => {
      const { result, lookupValue } = run(reply, value(100_000));
      expect(await result).toMatchObject({ outcome: "no_single_amount", action: FAIR });
      expect(lookupValue).not.toHaveBeenCalled();
    },
  );

  it.each([
    async () => ({ kind: "no_value" as const, reason: "unmatched:not_found" }),
    async () => ({ kind: "no_value" as const, reason: "http_500" }),
    async () => {
      throw new Error("boom");
    },
    async () => ({ kind: "value" as const, value: 0, source: "provider" as const }),
  ])("DealMachine error / no value → fair-price reply + alert", async (lookup) => {
    const r = await run("$150k", lookup as never).result;
    expect(r).toMatchObject({ outcome: "no_value", action: FAIR });
  });

  it("land seller naming a price → alert tagged vacant lot, no 80% check, no DealMachine call", async () => {
    const { result, lookupValue } = run("$150k", value(10_000), { pt: { lot: 0.8, residential: 0.1 } });
    const r = await result;
    expect(r.outcome).toBe("land_price");
    expect(r.action).toEqual({ road: "ALERT_land_price", steps: [{ kind: "alert", reason: "land_price" }] });
    expect(lookupValue).not.toHaveBeenCalled();
  });

  it("commercial → alert, no DealMachine call", async () => {
    const { result, lookupValue } = run("$150k", value(10_000), { pt: { commercial: 0.7 } });
    const r = await result;
    expect(r.action).toEqual({ road: "ALERT_commercial", steps: [{ kind: "alert", reason: "commercial" }] });
    expect(lookupValue).not.toHaveBeenCalled();
  });
});

describe("repairs follow-up questions (byte pins)", () => {
  // needs_repairs / flexible_price / original_portion: approved by Jarrad word for word (vault plan line 60).
  // no_repairs: Master A-006 (Jarrad-delegated). A diff here needs approval of that exact text.
  const PINNED = {
    needs_repairs: "Did the seller say the property needs repairs?",
    flexible_price: "Did the seller say they're flexible on price, willing to negotiate, or not firm?",
    original_portion: "Did the seller indicate any portion of the house was original?",
    no_repairs: "Did the seller explicitly say the property needs no repairs?",
  };
  const VAULT_LINE_60 =
    '- After repairs reply: "Did the seller say the property needs repairs?" · "Did the seller say they\'re flexible on price, willing to negotiate, or not firm?" · "Did the seller indicate any portion of the house was original?"';

  it("pins every byte, straight apostrophe, ids in order", () => {
    expect(REPAIRS_ALERT_IDS).toEqual(["needs_repairs", "flexible_price", "original_portion"]);
    expect(REPAIRS_FOLLOW_UP_IDS).toEqual(["needs_repairs", "flexible_price", "original_portion", "no_repairs"]);
    expect(REPAIRS_FOLLOW_UP_QUESTIONS).toEqual(PINNED);
    expect(Buffer.from(REPAIRS_FOLLOW_UP_QUESTIONS.no_repairs, "utf8")).toEqual(
      Buffer.from("Did the seller explicitly say the property needs no repairs?", "utf8"),
    );
    expect(Buffer.from(REPAIRS_FOLLOW_UP_QUESTIONS.flexible_price, "utf8").includes(Buffer.from("they'r"))).toBe(true);
    expect(Object.values(REPAIRS_FOLLOW_UP_QUESTIONS).join("")).not.toMatch(/[‘’“”]/);
  });

  it("the three alert questions are quoted verbatim in the approved vault line", () => {
    for (const id of REPAIRS_ALERT_IDS) expect(VAULT_LINE_60).toContain(`"${REPAIRS_FOLLOW_UP_QUESTIONS[id]}"`);
  });

  const vault = join(homedir(), "BMH-OS/_inbox/2026-10-29 — Sandra SMS reply routing plan (Jev + Haiku).md");
  it.runIf(existsSync(vault))("matches line 60 of the vault note byte for byte (local only)", () => {
    expect(readFileSync(vault, "utf8").split("\n")[59]).toBe(VAULT_LINE_60);
  });

  it("are not in the regular v2 call; all four asked only when opted in", () => {
    for (const id of REPAIRS_FOLLOW_UP_IDS) expect(V2_QUESTION_IDS as readonly string[]).not.toContain(id);
    const state = { our_last_text_to_homeowner: v2ReplyText("price_too_high"), homeowner_reply: "it needs a roof" };
    const plain = buildV2JevRequest(state);
    expect(Object.keys(plain.questions)).toEqual([...V2_QUESTION_IDS, "property_type"]);
    expect(JSON.stringify(buildV2JevRequest(state, {}))).toBe(JSON.stringify(plain));
    const withFu = buildV2JevRequest(state, { repairsFollowUps: true });
    for (const id of REPAIRS_FOLLOW_UP_IDS) {
      expect(withFu.questions[id]).toEqual({ type: "noul", instructions: PINNED[id] });
    }
    expect(Object.keys(withFu.questions)).toHaveLength(V2_QUESTION_IDS.length + 1 + 4);
  });

  it("cutoff is the 0.60 default", () => {
    expect(REPAIRS_FOLLOW_UP_CUTOFF).toBe(0.6);
  });

  it("readRepairsFollowUps keeps only valid probabilities", () => {
    expect(
      readRepairsFollowUps({
        needs_repairs: { noul: 0.7 },
        flexible_price: { noul: "x" },
        original_portion: undefined,
        no_repairs: { noul: 0.2 },
        listed: { noul: 1 },
      }),
    ).toEqual({ needs_repairs: 0.7, no_repairs: 0.2 });
  });
});

describe("repairs follow-ups", () => {
  const probs = (o: Partial<Record<RepairsFollowUpId, number>> = {}) => ({
    needs_repairs: 0.1,
    flexible_price: 0.1,
    original_portion: 0.1,
    no_repairs: 0.1,
    ...o,
  });
  const decide = (o: Partial<Parameters<typeof decideRepairsFollowUp>[0]> = {}) =>
    decideRepairsFollowUp({ flags: ON, propertyId: PROP, mainDecision: DECISION, followUps: probs(), listedProbability: 0.1, ...o });
  const ALERT = { road: "price_check", steps: [{ kind: "alert", reason: "named_price" }] };
  const REALTOR = { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.no_repairs };
  const PRICE_TOO_HIGH_DRIP = { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.other };

  it("runs only after the exact approved repairs reply", () => {
    expect(isAfterRepairsReply(v2ReplyText("price_too_high"))).toBe(true);
    expect(isAfterRepairsReply(`  ${v2ReplyText("price_too_high")}\n`)).toBe(true);
    expect(isAfterRepairsReply(v2ReplyText("fair_price"))).toBe(false);
    expect(isAfterRepairsReply(null)).toBe(false);
  });

  it("flag off → null (normal routing)", () => {
    expect(decide({ flags: ALL_OFF })).toBeNull();
  });

  it.each(REPAIRS_ALERT_IDS)("any yes (%s) → alert, beats no_repairs and listed", (id) => {
    expect(decide({ followUps: probs({ [id]: 0.6, no_repairs: 0.95 }), listedProbability: 0.9 })).toEqual({ outcome: "follow_up_yes", action: ALERT });
  });

  it("yes cutoff: 0.59 is not a yes, 0.60 is (alert and no_repairs alike)", () => {
    expect(decide({ followUps: probs({ needs_repairs: 0.59 }) })?.outcome).toBe("other");
    expect(decide({ followUps: probs({ needs_repairs: 0.6 }) })?.outcome).toBe("follow_up_yes");
    expect(decide({ followUps: probs({ no_repairs: 0.59 }) })?.outcome).toBe("other");
    expect(decide({ followUps: probs({ no_repairs: 0.6 }) })?.outcome).toBe("no_repairs");
  });

  it("no_repairs yes → approved realtor reply (beats listed)", () => {
    expect(decide({ followUps: probs({ no_repairs: 0.9 }), listedProbability: 0.9 })).toEqual({ outcome: "no_repairs", action: REALTOR });
  });

  it("a low needs_repairs alone is never treated as no repairs", () => {
    expect(decide({ followUps: probs({ needs_repairs: 0.01, no_repairs: 0.3 }) })).toEqual({ outcome: "other", action: PRICE_TOO_HIGH_DRIP });
  });

  it("listed yes → Listed drip", () => {
    expect(decide({ listedProbability: 0.6 })).toEqual({
      outcome: "listed",
      action: { road: "listed_drip", steps: [{ kind: "drip", drip: "Listed, not selling", skipFirstStep: false }] },
    });
  });

  it("anything else → Price too high drip", () => {
    expect(decide({ listedProbability: 0.59 })).toEqual({ outcome: "other", action: PRICE_TOO_HIGH_DRIP });
    expect(decide({ listedProbability: null })?.outcome).toBe("other");
  });

  it("missing follow-up answers (incl. no_repairs) → alert (a person looks), never a drip", () => {
    const { no_repairs: _omit, ...withoutNoRepairs } = probs({ no_repairs: 0.9 });
    void _omit;
    for (const followUps of [null, { needs_repairs: 0.1 }, probs({ flexible_price: Number.NaN }), withoutNoRepairs]) {
      expect(decide({ followUps })?.action).toEqual(ALERT);
    }
  });

  // Regression cases with mocked Jev answers (no real Jev call): the full answer map goes
  // through routeV2 (regular order) and readRepairsFollowUps, then decideRepairsFollowUp.
  describe("regressions (mocked Jev answers)", () => {
    const zeroQs = () => Object.fromEntries(V2_QUESTION_IDS.map((id) => [id, 0.02])) as Record<V2QuestionId, number>;
    function route(reply: string, jev: Partial<Record<V2QuestionId | RepairsFollowUpId, number>>) {
      const probabilities = { ...zeroQs(), ...pick(jev, V2_QUESTION_IDS) };
      const main = routeV2({ reply, probabilities, propertyType: PT() });
      const answers = Object.fromEntries(REPAIRS_FOLLOW_UP_IDS.map((id) => [id, { noul: jev[id] ?? 0.02 }]));
      return decideRepairsFollowUp({
        flags: ON,
        propertyId: PROP,
        mainDecision: main,
        followUps: readRepairsFollowUps(answers),
        listedProbability: probabilities.listed,
      });
    }
    function pick<T extends string>(o: Partial<Record<string, number>>, ids: readonly T[]): Partial<Record<T, number>> {
      return Object.fromEntries(ids.filter((id) => o[id] !== undefined).map((id) => [id, o[id]])) as Partial<Record<T, number>>;
    }

    it('positive: "no repairs needed, it\'s move-in ready" → realtor reply', () => {
      expect(route("no repairs needed, it's move-in ready", { no_repairs: 0.93, needs_repairs: 0.03 })).toEqual({ outcome: "no_repairs", action: REALTOR });
    });

    it('negated: "it needs a lot of repairs" → alert', () => {
      expect(route("it needs a lot of repairs", { needs_repairs: 0.96, no_repairs: 0.02 })).toEqual({ outcome: "follow_up_yes", action: ALERT });
    });

    it('ambiguous: "it\'s in okay shape" → Price too high drip, not the realtor reply', () => {
      expect(route("it's in okay shape", { needs_repairs: 0.2, no_repairs: 0.35 })).toEqual({ outcome: "other", action: PRICE_TOO_HIGH_DRIP });
    });

    it('silence on repairs: "what\'s your offer" → Price too high drip, not the realtor reply', () => {
      // asked_offer would route Book appointment in the regular order; the follow-up step only
      // yields to stop/legal/call-me, so it decides here.
      expect(route("what's your offer", { asked_offer: 0.9, needs_repairs: 0.02, no_repairs: 0.02 })).toEqual({ outcome: "other", action: PRICE_TOO_HIGH_DRIP });
    });

    it("no_repairs yes together with needs_repairs yes → the alert wins", () => {
      expect(route("no repairs, well the roof needs work", { no_repairs: 0.8, needs_repairs: 0.8 })).toEqual({ outcome: "follow_up_yes", action: ALERT });
    });

    it("stop + no_repairs → stop wins (follow-ups do not apply)", () => {
      expect(route("no repairs needed. stop texting me", { asked_stop: 0.95, no_repairs: 0.9 })).toBeNull();
      expect(route("lawyer. no repairs", { legal: 0.9, no_repairs: 0.9 })).toBeNull();
      expect(route("no repairs, call me tomorrow at 3", { asked_call: 0.9, no_repairs: 0.9 })).toBeNull();
      expect(REPAIRS_FOLLOW_UP_PRECEDENCE_ROADS).toEqual(new Set(["stop", "ALERT_call_me", "wrong_number_close", "bad_number"]));
    });

    // After-repairs precedence: Jarrad 2026-10-30 — row-3/bounce roads close normally.
    it.each([
      ["wrong person", "wrong number, I don't own that", { wrong_person: 0.92 }],
      ["already sold", "I sold it last year", { already_sold: 0.9 }],
      ["tenant", "I just rent here", { tenant: 0.9 }],
    ] as const)("%s after the repairs reply → its normal wrong-number road, not the Price too high drip", (_l, reply, jev) => {
      expect(route(reply, { ...jev, needs_repairs: 0.02, no_repairs: 0.02 })).toBeNull();
      const probabilities = { ...zeroQs(), ...jev };
      const main = routeV2({ reply, probabilities, propertyType: PT() });
      expect(main.road).toBe("wrong_number_close");
      expect(actionForV2Decision(main).steps).toEqual([{ kind: "wrong_number_close" }]);
    });
    it("a \"no SMS capabilities\" bounce after the repairs reply → bad number, not the Price too high drip", () => {
      const reply = "This number has no SMS capabilities";
      expect(route(reply, {})).toBeNull();
      const main = routeV2({ reply, probabilities: zeroQs(), propertyType: PT() });
      expect(main.road).toBe("bad_number");
      expect(actionForV2Decision(main).road).toBe("bad_number");
    });
  });
});

describe("DealMachine provider (mocked fetch; no real calls)", () => {
  const ADDR = { street: "1 Test St", city: "Kansas City", state: "MO", zip: "64111" };
  const resp = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const ok = (v: unknown) => resp(200, { data: [{ matched: true, estimated_value: v }], credits: { used: 1 } });

  it("builds the documented request: contact_audience none, estimated_value field", () => {
    expect(buildDealMachineEnrichRequest(ADDR)).toEqual({
      data: [{ street: "1 Test St", city: "Kansas City", state: "MO", zip: "64111" }],
      fields: ["estimated_value"],
      contact_audience: "none",
    });
  });

  /** Ledger hooks are required on the raw fetch; tests that check other behaviour pass these. */
  const LEDGER = () => ({ beforeAttempt: async () => crypto.randomUUID(), onAttempt: async () => {} });

  it("refuses to reach the provider without both ledger hooks (no un-ledgered path)", async () => {
    const fetchImpl = vi.fn(async () => ok(1));
    const f = fetchImpl as unknown as typeof fetch;
    // @ts-expect-error ledger hooks are required
    expect(await fetchDealMachineEstimatedValue(ADDR, { apiKey: "k", fetchImpl: f })).toEqual({ kind: "accounting_failed" });
    // @ts-expect-error onAttempt is required
    expect(await fetchDealMachineEstimatedValue(ADDR, { apiKey: "k", fetchImpl: f, beforeAttempt: async () => "id" })).toEqual({ kind: "accounting_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to /v1/enrichment/address with a bearer key and reads estimated_value", async () => {
    const fetchImpl = vi.fn(async () => ok(210000));
    const attempts: DealMachineAttempt[] = [];
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(),
      apiKey: "test-key",
      baseUrl: "https://dm.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAttempt: (a) => void attempts.push(a),
    });
    expect(r).toEqual({ kind: "ok", value: 210000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://dm.invalid${DEALMACHINE_ENRICH_ADDRESS_PATH}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string).contact_audience).toBe("none");
    expect(attempts).toEqual([{ callId: expect.any(String), httpStatus: 200, creditsUsed: 1 }]);
  });

  it.each([
    [{ data: [{ matched: false, match_failure: { code: "not_found" } }] }, { kind: "no_value", reason: "unmatched:not_found" }],
    [{ data: [{ matched: true, estimated_value: null }] }, { kind: "no_value", reason: "no_estimated_value" }],
    [{ data: [{ matched: true, estimated_value: 0 }] }, { kind: "no_value", reason: "no_estimated_value" }],
    [{ data: [] }, { kind: "no_value", reason: "no_item" }],
    [{ nope: 1 }, { kind: "error", reason: "invalid_response" }],
  ])("parses %j", (body, expected) => {
    expect(parseDealMachineEnrichResponse(body)).toEqual(expected);
  });

  it("429 storm: at most 2 retries, honors Retry-After, then retryable", async () => {
    const fetchImpl = vi.fn(async () => resp(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "1" }));
    const sleep = vi.fn(async () => {});
    const attempts: DealMachineAttempt[] = [];
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(),
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      onAttempt: (a) => void attempts.push(a),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    expect(r.kind).toBe("retryable_error");
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((a) => a.callId)).size).toBe(3);
  });

  it("long Retry-After is not waited inline: returned as backoff", async () => {
    const fetchImpl = vi.fn(async () => resp(429, {}, { "retry-after": "120" }));
    const sleep = vi.fn(async () => {});
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(), apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: "retryable_error", reason: "http_429", retryAfterSeconds: 120 });
  });

  it("5xx then success: exponential backoff with jitter", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(resp(503, {})).mockResolvedValueOnce(ok(100000));
    const sleep = vi.fn(async () => {});
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(),
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      random: () => 0.5,
    });
    expect(r).toEqual({ kind: "ok", value: 100000 });
    expect(sleep.mock.calls).toEqual([[625]]);
  });

  it("timeout → retried, then retryable (10 s timeout per request)", async () => {
    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(),
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
      sleep: async () => {},
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ kind: "retryable_error", reason: "timeout" });
  });

  it("400/401 → error, no retry", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: { code: "invalid_api_key" } }));
    const r = await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(), apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ kind: "error", reason: "http_401" });
  });

  it("beforeAttempt: no slot → rate_limited, write failure → accounting_failed; no request either way", async () => {
    const fetchImpl = vi.fn(async () => ok(1));
    const f = fetchImpl as unknown as typeof fetch;
    expect(await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(), apiKey: "k", fetchImpl: f, beforeAttempt: async () => null })).toEqual({ kind: "rate_limited" });
    expect(
      await fetchDealMachineEstimatedValue(ADDR, { ...LEDGER(),
        apiKey: "k",
        fetchImpl: f,
        beforeAttempt: async () => {
          throw new Error("ledger");
        },
      }),
    ).toEqual({ kind: "accounting_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfterSeconds("7")).toBe(7);
    expect(parseRetryAfterSeconds(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfterSeconds("soon")).toBeNull();
    expect(parseRetryAfterSeconds(null)).toBeNull();
  });
});

const dmOk = (v: number) =>
  new Response(JSON.stringify({ data: [{ matched: true, estimated_value: v }], credits: { used: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The real provider adapter over a mocked fetch (no network), wired to the store hooks. */
const realProvider =
  (fetchImpl: (...a: never[]) => Promise<Response>) =>
  (address: Parameters<typeof fetchDealMachineEstimatedValue>[0], hooks: { beforeAttempt: () => Promise<string | null>; onAttempt: (a: DealMachineAttempt) => Promise<void> }) =>
    fetchDealMachineEstimatedValue(address, {
      apiKey: "test-key",
      baseUrl: "https://dm.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      ...hooks,
    });

/** In-memory store with the same claim / ledger-slot semantics as the 20261030180000 RPCs. */
function memoryStore(nowRef: { t: number }) {
  type Row = { state: "in_flight" | SettleState | "negative" | "ok"; value?: number; token?: string; claimExp?: number; validUntil?: number; retryAt?: number };
  const rows = new Map<string, Row>();
  type Spend = { callId: string; orgId: string; startedAt: number; status: "attempt_started" | "settled"; httpStatus?: number | null; cost?: number | null };
  const spend: Spend[] = [];
  let n = 0;
  let c = 0;
  const store: DealMachineCacheStore = {
    async claim(propertyId) {
      await Promise.resolve();
      const r = rows.get(propertyId);
      const now = nowRef.t;
      const reclaimable =
        !r ||
        (r.state === "in_flight" && r.claimExp! <= now) ||
        (r.state === "failed_retryable" && (r.retryAt ?? 0) <= now) ||
        ((r.state === "ok" || r.state === "negative") && r.validUntil! <= now);
      if (reclaimable) {
        const token = `t${++n}`;
        rows.set(propertyId, { state: "in_flight", token, claimExp: now + 60_000 });
        return { outcome: "claimed", claimToken: token };
      }
      const out: ClaimOutcome =
        r!.state === "ok"
          ? { outcome: "cached_ok", value: r!.value! }
          : r!.state === "negative"
            ? { outcome: "cached_negative" }
            : r!.state === "failed_retryable"
              ? { outcome: "backoff" }
              : { outcome: "in_flight" };
      return out;
    },
    async settle(i) {
      const r = rows.get(i.propertyId);
      if (!r || r.state !== "in_flight" || r.token !== i.claimToken) return false;
      const now = nowRef.t;
      rows.set(i.propertyId, {
        state: i.state,
        value: i.value ?? undefined,
        validUntil: i.state === "failed_retryable" ? undefined : now + 30 * 86_400_000,
        retryAt: i.state === "failed_retryable" ? now + (i.retryAfterSeconds ?? 0) * 1000 : undefined,
      });
      return true;
    },
    async startAttempt({ orgId }) {
      await Promise.resolve();
      const used = spend.filter((x) => x.orgId === orgId && x.startedAt > nowRef.t - 60_000).length;
      if (used >= DM_CALLS_PER_MINUTE) return null;
      const callId = `call${++c}`;
      spend.push({ callId, orgId, startedAt: nowRef.t, status: "attempt_started" });
      return callId;
    },
    async settleAttempt(a) {
      const row = spend.find((x) => x.callId === a.callId && x.status === "attempt_started");
      if (!row) return false;
      Object.assign(row, { status: "settled", httpStatus: a.httpStatus, cost: a.creditsUsed });
      return true;
    },
  };
  return { store, rows, spend };
}

describe("lookupDealMachineValue (claim + cache)", () => {
  const ADDR = { street: "1 Test St", city: "Kansas City", state: "MO", zip: "64111" };

  it("20 concurrent price-namers for one property → exactly 1 provider call; all get the value", async () => {
    const clock = { t: 0 };
    const { store, spend } = memoryStore(clock);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return dmOk(200_000);
    });
    const callProvider = vi.fn(realProvider(fetchImpl));
    // Each poll advances the fake clock a little; the winner's provider call finishes after a few polls.
    const sleep = async () => {
      clock.t += 10;
      if (clock.t >= 200) release();
      await new Promise((r) => setTimeout(r, 0));
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider, sleep, now: () => clock.t }),
      ),
    );
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === "value" && r.value === 200_000)).toBe(true);
    expect(spend).toEqual([expect.objectContaining({ status: "settled", httpStatus: 200, cost: 1 })]);
  });

  it("losers give up after ≤10 s while the claim is in flight → no value", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    await store.claim(PROP, ORG); // a crashed/slow holder
    const callProvider = vi.fn();
    const r = await lookupDealMachineValue(
      { orgId: ORG, propertyId: PROP, address: ADDR },
      { store, callProvider, sleep: async (ms) => void (clock.t += ms), now: () => clock.t },
    );
    expect(r).toEqual({ kind: "no_value", reason: "in_flight_timeout" });
    expect(clock.t).toBeLessThanOrEqual(10_500);
    expect(callProvider).not.toHaveBeenCalled();
  });

  it("crash after claim → reclaimable after expiry, exactly one more call", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    await store.claim(PROP, ORG);
    clock.t += 61_000;
    const callProvider = vi.fn(async () => ({ kind: "ok" as const, value: 100 }));
    const deps = { store, callProvider, sleep: async () => {}, now: () => clock.t };
    await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps);
    await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps);
    expect(callProvider).toHaveBeenCalledTimes(1);
  });

  it("negative cache → 0 calls in the 30-day window, 1 after", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    const callProvider = vi.fn(async () => ({ kind: "no_value" as const, reason: "unmatched:not_found" }));
    const deps = { store, callProvider, sleep: async () => {}, now: () => clock.t };
    const look = () => lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps);
    expect(await look()).toEqual({ kind: "no_value", reason: "unmatched:not_found" });
    clock.t += 29 * 86_400_000;
    expect(await look()).toEqual({ kind: "no_value", reason: "cached_negative" });
    expect(callProvider).toHaveBeenCalledTimes(1);
    clock.t += 2 * 86_400_000;
    await look();
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it("retryable failure → backoff until retry_after, then one new call", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    const callProvider = vi
      .fn()
      .mockResolvedValueOnce({ kind: "retryable_error", reason: "http_429", retryAfterSeconds: 60 })
      .mockResolvedValueOnce({ kind: "ok", value: 5 });
    const deps = { store, callProvider, sleep: async () => {}, now: () => clock.t };
    const look = () => lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps);
    expect(await look()).toEqual({ kind: "no_value", reason: "http_429" });
    expect(await look()).toEqual({ kind: "no_value", reason: "backoff" });
    clock.t += 60_000;
    expect(await look()).toEqual({ kind: "value", value: 5, source: "provider" });
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it("cached ok value is reused with no call", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    const callProvider = vi.fn(async () => ({ kind: "ok" as const, value: 7 }));
    const deps = { store, callProvider, sleep: async () => {}, now: () => clock.t };
    await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps);
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, deps)).toEqual({ kind: "value", value: 7, source: "cache" });
    expect(callProvider).toHaveBeenCalledTimes(1);
  });

  it("no usable address / claim error → no value, no call", async () => {
    const callProvider = vi.fn();
    const store = {
      claim: vi.fn(async () => {
        throw new Error("db");
      }),
      settle: vi.fn(),
      startAttempt: vi.fn(),
      settleAttempt: vi.fn(),
    } as unknown as DealMachineCacheStore;
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: { street: "1 Test St", city: "", state: "MO" } }, { store, callProvider })).toEqual({ kind: "no_value", reason: "no_address" });
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider })).toEqual({ kind: "no_value", reason: "claim_error" });
    expect(callProvider).not.toHaveBeenCalled();
  });

  it("ledger row is written BEFORE the request; a failed pre-call write → no request, no value", async () => {
    const clock = { t: 0 };
    const { store, rows } = memoryStore(clock);
    store.startAttempt = async () => {
      throw new Error("ledger down");
    };
    const fetchImpl = vi.fn(async () => dmOk(9));
    const r = await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider: realProvider(fetchImpl) });
    expect(r).toEqual({ kind: "no_value", reason: "accounting_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows.get(PROP)?.state).toBe("failed_retryable");
  });

  it("order: startAttempt happens before fetch, settleAttempt after", async () => {
    const clock = { t: 0 };
    const { store, spend } = memoryStore(clock);
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => {
      seen.push(`fetch:${spend.map((x) => x.status).join(",")}`);
      return dmOk(9);
    });
    await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider: realProvider(fetchImpl) });
    expect(seen).toEqual(["fetch:attempt_started"]);
    expect(spend.map((x) => x.status)).toEqual(["settled"]);
  });

  it("a failed ledger settle leaves the row attempt_started (still counted); outcome unchanged", async () => {
    const clock = { t: 0 };
    const { store, spend } = memoryStore(clock);
    store.settleAttempt = async () => {
      throw new Error("ledger down");
    };
    const r = await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider: realProvider(vi.fn(async () => dmOk(9))) });
    expect(r).toEqual({ kind: "value", value: 9, source: "provider" });
    expect(spend).toEqual([expect.objectContaining({ status: "attempt_started" })]);
  });

  it("every retry attempt gets its own pre-call ledger row", async () => {
    const clock = { t: 0 };
    const { store, spend } = memoryStore(clock);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(dmOk(9));
    await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider: realProvider(fetchImpl) });
    expect(spend.map((x) => [x.status, x.httpStatus])).toEqual([
      ["settled", 503],
      ["settled", 200],
    ]);
  });

  it("settle not successful (claim reclaimed/lost) → no value, never the obsolete value", async () => {
    const clock = { t: 0 };
    const { store } = memoryStore(clock);
    const callProvider = async () => {
      // While the provider was slow, the claim expired and someone else retook it.
      clock.t += 61_000;
      await store.claim(PROP, ORG);
      return { kind: "ok" as const, value: 123 };
    };
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider })).toEqual({
      kind: "no_value",
      reason: "settle_lost",
    });
    const throwing = { ...store, settle: async () => { throw new Error("db"); } } as DealMachineCacheStore;
    const fresh = memoryStore({ t: 0 }).store;
    const s2 = { ...fresh, settle: throwing.settle } as DealMachineCacheStore;
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store: s2, callProvider: async () => ({ kind: "ok", value: 5 }) })).toEqual({
      kind: "no_value",
      reason: "settle_lost",
    });
  });

  it("shared rate limit: 61 concurrent lookups for different properties → at most 60 provider calls; overflow = no value, no queue", async () => {
    const clock = { t: 0 };
    const { store, spend } = memoryStore(clock);
    const fetchImpl = vi.fn(async () => dmOk(100_000));
    const props = Array.from({ length: 61 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`);
    const results = await Promise.all(
      props.map((propertyId) => lookupDealMachineValue({ orgId: ORG, propertyId, address: ADDR }, { store, callProvider: realProvider(fetchImpl) })),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(60);
    expect(spend).toHaveLength(60);
    expect(results.filter((r) => r.kind === "value")).toHaveLength(60);
    expect(results.filter((r) => r.kind === "no_value" && r.reason === "rate_limited")).toHaveLength(1);
    // A minute later there is room again.
    clock.t += 61_000;
    const later = await lookupDealMachineValue({ orgId: ORG, propertyId: props[60], address: ADDR }, { store, callProvider: realProvider(fetchImpl) });
    expect(later.kind).toBe("value");
  });

  it("price check on a rate-limited lookup takes the safe path (fair-price reply + alert)", async () => {
    const r = await runV2PriceCheck({
      flags: ON,
      propertyId: PROP,
      decision: DECISION,
      reply: "$150k",
      propertyType: PT(),
      lookupValue: async () => ({ kind: "no_value", reason: "rate_limited" }),
    });
    expect(r).toMatchObject({ outcome: "no_value", action: FAIR, noValueReason: "rate_limited" });
  });
});
