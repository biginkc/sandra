import { describe, expect, it } from "vitest";

import { NINE_QUESTIONS, decideNineQuestions } from "../../../src/lib/sms-classification/nine-questions";
import {
  assertStressDbEnv,
  bucketFromDispatch,
  estimateJevCost,
  mulberry32,
  predictBucket,
  stubAnswer,
  summarize,
  summarizeScenario,
  upFrontKeywordBucket,
  type RunRow,
  type Scenario,
} from "./core";
import { loadCorpus } from "./corpus";

const corpus = loadCorpus();
const byId = (id: string) => corpus.find((s) => s.id === id)!;

describe("corpus", () => {
  it("is 30 scenarios x 10 wordings, every id distinct", () => {
    expect(corpus).toHaveLength(30);
    for (const s of corpus) expect(s.wordings).toHaveLength(10);
  });

  it("carries the plan's required shapes", () => {
    for (const id of [
      "stop_plus_price",
      "lawyer_plus_price",
      "asked_who_plus_price",
      "dollar_amount",
      "maybe_later_plus_offer",
      "hostile_plus_price",
      "unclear_plus_price",
      "gave_time_to_call",
      "yes_to_still_own_opener",
      "yes_to_offer_opener",
      "hostile_not_stop",
      "price_with_refusal",
      "not_interested_typos",
      "slang_open",
      "confirmed_owner_long",
      "responder_off",
    ]) {
      expect(byId(id), id).toBeDefined();
    }
    expect(byId("dollar_amount").wordings).toContain("$150k");
    expect(byId("gave_time_to_call").wordings).toContain("Anytime");
    expect(byId("gave_time_to_call").wordings).toContain("noon is best");
    expect(byId("gave_time_to_call").known_gap).toBeTruthy();
  });

  it("never embeds a business rule: no question text appears in the corpus file", () => {
    const text = JSON.stringify(corpus);
    for (const q of Object.values(NINE_QUESTIONS)) expect(text).not.toContain(q);
  });

  it("the precedence mirror agrees with every gated scenario's expected bucket when Jev answers as expected", () => {
    for (const s of corpus) {
      if (s.db_only || s.review || s.known_gap) continue;
      for (const w of s.wordings) {
        const answer = s.expected_answers?.[0] ?? "needs_person";
        const bucket = predictBucket(answer, w);
        expect(s.expected_buckets, `${s.id}: "${w}" -> ${bucket}`).toContain(bucket);
      }
    }
  });
});

describe("precedence mirror", () => {
  it("stop and hostile beat a price keyword; wrong person beats it; the rest yield to it", () => {
    expect(predictBucket("asked_stop", "STOP, what's your price")).toBe("stop_person");
    expect(predictBucket("talked_price", "Fuck off unless you have $400k")).toBe("stop_person");
    expect(predictBucket("wrong_person", "Wrong number. What's your offer though")).toBe("wrong_person");
    expect(predictBucket("not_interested", "Not interested unless it's over $600k")).toBe("hot");
    expect(predictBucket("maybe_later", "Not now but what would you offer?")).toBe("hot");
    expect(predictBucket("asked_who", "Who is this? How much are you offering")).toBe("hot");
    expect(predictBucket("needs_person", "hmm price")).toBe("hot");
    expect(predictBucket("not_interested", "Not interested")).toBe("not_interested");
    expect(predictBucket("confirmed_owner", "Yes")).toBe("confirmed_owner");
    expect(predictBucket("needs_person", "Ll")).toBe("needs_person");
  });

  it("up-front non-price keywords hold before Jev is consulted; with an amount they are hot", () => {
    expect(upFrontKeywordBucket("My attorney handles all of that")).toBe("keyword_hold");
    expect(upFrontKeywordBucket("Talk to my lawyer. Offer has to be over $300k")).toBe("keyword_hold");
    expect(upFrontKeywordBucket("Is this a real person?")).toBe("keyword_hold");
    expect(upFrontKeywordBucket("Not interested")).toBeNull();
    // Documented fragility: without an amount, the longer phrase wins the tier.
    expect(upFrontKeywordBucket("Send any offer to my lawyer")).toBe("keyword_hold");
  });
});

describe("bucketFromDispatch", () => {
  const prop = { needs_human_attention: true, last_ai_escalation_reason: null, outreach_dispo: null, status: "prospect" };
  it("maps the reasons dispatch writes", () => {
    expect(bucketFromDispatch({ outcome: { outcome: "auto_closed", reason: "model:new_lead_promoted" }, property: prop, outboundCount: 0 })).toBe("hot");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "hot_lead" }, property: prop, outboundCount: 0 })).toBe("hot");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "keyword:price_offer" }, property: prop, outboundCount: 0 })).toBe("hot");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "hot_lead_assign_failed" }, property: prop, outboundCount: 0 })).toBe("hot");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "nine_asked_stop" }, property: prop, outboundCount: 0 })).toBe("stop_person");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "hostile_needs_confirm" }, property: prop, outboundCount: 0 })).toBe("stop_person");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "nine_needs_person" }, property: prop, outboundCount: 0 })).toBe("needs_person");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "keyword:legal_contract" }, property: prop, outboundCount: 0 })).toBe("keyword_hold");
    expect(bucketFromDispatch({ outcome: { outcome: "auto_closed", reason: "nine_questions:maybe_later" }, property: prop, outboundCount: 1 })).toBe("maybe_later");
    expect(bucketFromDispatch({ outcome: { outcome: "wrong_number", reason: "nine_questions:wrong_person" }, property: prop, outboundCount: 1 })).toBe("wrong_person");
    expect(bucketFromDispatch({ outcome: { outcome: "skipped", reason: "ai_responder_disabled" }, property: { ...prop, needs_human_attention: false }, outboundCount: 0 })).toBe("silent_off");
    expect(bucketFromDispatch({ outcome: { outcome: "escalated", reason: "send_check_failed" }, property: prop, outboundCount: 0 })).toBe("other:send_check_failed");
  });
});

describe("stub classifier", () => {
  it("oracle mode returns the expected answer; noisy mode flips sometimes", () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 50; i++) expect(stubAnswer(["not_interested"], { noise: 0, rnd }).answer).toBe("not_interested");
    expect(stubAnswer(["needs_person"], { noise: 0, rnd }).answer).toBe("needs_person");
    const noisy = mulberry32(7);
    const answers = new Set(Array.from({ length: 200 }, () => stubAnswer(["not_interested"], { noise: 0.3, rnd: noisy }).answer));
    expect(answers.size).toBeGreaterThan(1);
  });

  it("stub probabilities respect the approved tie-breaker (the product's decideNineQuestions)", () => {
    const rnd = mulberry32(1);
    const { probabilities, answer } = stubAnswer(["talked_price"], { noise: 0, rnd });
    expect(decideNineQuestions(probabilities).answer).toBe(answer);
  });
});

describe("statistics", () => {
  const s: Scenario = {
    id: "x",
    title: "x",
    our_last_text: "o",
    expected_answers: ["not_interested"],
    expected_buckets: ["not_interested"],
    wordings: ["a", "b"],
  };
  it("flip rate counts wordings, wrong-bucket counts runs", () => {
    const rows: RunRow[] = [
      { scenarioId: "x", wordingIdx: 0, repeat: 0, answer: "not_interested", bucket: "not_interested" },
      { scenarioId: "x", wordingIdx: 0, repeat: 1, answer: "not_interested", bucket: "not_interested" },
      { scenarioId: "x", wordingIdx: 1, repeat: 0, answer: "not_interested", bucket: "not_interested" },
      { scenarioId: "x", wordingIdx: 1, repeat: 1, answer: "maybe_later", bucket: "maybe_later" },
    ];
    const st = summarizeScenario(s, rows);
    expect(st.flip).toEqual({ flipped: 1, rate: 0.5 });
    expect(st.bucketFlip).toEqual({ flipped: 1, rate: 0.5 });
    expect(st.wrongBucket).toEqual({ wrong: 1, rate: 0.25, by: { maybe_later: 1 } });
    expect(st.wrongAnswer).toEqual({ wrong: 1, rate: 0.25 });
    expect(st.gated).toBe(true);
    expect(st.passes).toBe(false);
    const sum = summarize([s], rows);
    expect(sum.allGatesPass).toBe(false);
    expect(sum.overall.runs).toBe(4);
  });
  it("a failed run fails the gate even when the rest is clean; review scenarios are not gated", () => {
    const rows: RunRow[] = [
      { scenarioId: "x", wordingIdx: 0, repeat: 0, answer: "not_interested", bucket: "not_interested" },
      { scenarioId: "x", wordingIdx: 1, repeat: 0, answer: null, bucket: "other:failed", failed: "timeout" },
    ];
    expect(summarizeScenario(s, rows).passes).toBe(false);
    expect(summarizeScenario({ ...s, review: "open" }, rows).passes).toBeNull();
  });
  it("cost estimate uses the TypeSafe rate from the replay", () => {
    const c = estimateJevCost(900);
    expect(c.inputTokens).toBe(900 * 1500);
    expect(c.usd).toBeCloseTo(0.0567, 4);
  });
});

describe("assertStressDbEnv", () => {
  const good = {
    MV2_STRESS_DISPOSABLE_DB: "1",
    TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres",
    TEST_SUPABASE_URL: "http://127.0.0.1:55431",
    TEST_SUPABASE_SERVICE_ROLE_KEY: "k",
    TEST_SUPABASE_ANON_KEY: "a",
    LOCAL_SUPABASE_URL: "http://127.0.0.1:55431",
    LOCAL_SUPABASE_SERVICE_ROLE_KEY: "k",
  };
  it("accepts an explicit throwaway stack", () => {
    expect(() => assertStressDbEnv(good)).not.toThrow();
  });
  it("refuses the dev stack, hosted refs, missing or mismatched bindings, and provider credentials", () => {
    expect(() => assertStressDbEnv({ ...good, TEST_SUPABASE_URL: "http://127.0.0.1:54331", LOCAL_SUPABASE_URL: "http://127.0.0.1:54331" })).toThrow(/DEV_STACK_PORT/);
    expect(() => assertStressDbEnv({ ...good, TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres" })).toThrow(/DEV_STACK_PORT/);
    expect(() => assertStressDbEnv({ ...good, MV2_STRESS_DISPOSABLE_DB: undefined })).toThrow(/NOT_ACKNOWLEDGED/);
    expect(() => assertStressDbEnv({ ...good, LOCAL_SUPABASE_URL: undefined })).toThrow(/MISSING_ENV/);
    expect(() => assertStressDbEnv({ ...good, LOCAL_SUPABASE_URL: "http://127.0.0.1:55499" })).toThrow(/URL_MISMATCH/);
    expect(() => assertStressDbEnv({ ...good, SOMETHING: "https://ncsngxlcyxylaeskiteu.supabase.co" })).toThrow(/HOSTED_REF_IN_ENV/);
    expect(() => assertStressDbEnv({ ...good, TEST_SUPABASE_URL: "http://10.0.0.5:55431", LOCAL_SUPABASE_URL: "http://10.0.0.5:55431" })).toThrow(/NOT_LOOPBACK/);
    expect(() => assertStressDbEnv({ ...good, TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres?host=db.example" })).toThrow(/URL_QUERY/);
    expect(() => assertStressDbEnv({ ...good, SENDILLO_API_KEY: "x" })).toThrow(/PROVIDER_CREDENTIAL/);
    expect(() => assertStressDbEnv({ ...good, RUN_PROD_CANARIES: "1" })).toThrow(/PROD_CANARY_FLAG/);
  });
});
