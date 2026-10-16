import { isHotReason } from "../../../src/lib/hot-sellers/hot";
import { isHostileInbound } from "../../../src/lib/ai-responder/hostile";
import { hasAllowedPriceSignal, matchEscalationKeyword, nonPriceTier, priceSignalAllowed } from "../../../src/lib/ai-responder/keywords";
import {
  actionForNineAnswer,
  decideNineQuestions,
  NINE_QUESTION_CUTOFF,
  NINE_QUESTION_IDS,
  type NineAnswer,
  type NineQuestionId,
} from "../../../src/lib/sms-classification/nine-questions";
import { JEV_INPUT_USD_PER_MTOK, TOKENS_PER_REQUEST_ESTIMATE } from "../replay/nine-core";

/**
 * Messages v2 Stage 5 stress harness: pure pieces (no I/O). The CLI (classifier lane) and
 * the vitest spec (dispatch lane on a disposable database) both build on these.
 *
 * Business rules are never defined here. Question texts, cutoff and group order are
 * IMPORTED from `src/lib/sms-classification/nine-questions.ts`; the dispatch precedence
 * mirror below imports the same pure helpers dispatch uses (hostile phrases, keyword
 * tiers, action table) so the mirror cannot drift silently from the product.
 */

/* ----------------------------------------------------------------------------------------
 * Buckets: what Sandra DID (or would do) with a text. The dispatch lane derives one from
 * the real outcome + database rows; the classifier lane predicts one with the mirror.
 * -------------------------------------------------------------------------------------- */
export const BUCKETS = [
  "hot", // handed to Jarrad (promotion + hand-off) or a hot hold that alerts (model:/keyword:price_offer/hot_lead)
  "stop_person", // asked_stop or hostile: waits for a person, nothing sent, nothing suppressed
  "wrong_person", // approved wrong-number reply, closed this property only
  "maybe_later", // approved nurture reply + "Maybe later" drip
  "not_interested", // approved not-interested reply + "Not interested" drip
  "asked_who", // approved identity reply + "Asked who is texting" drip (day 1 skipped)
  "confirmed_owner", // no reply; "Confirmed owner" drip
  "needs_person", // no question reached the cutoff: waits for a person
  "keyword_hold", // up-front non-price keyword hold (lawyer / real person / died ...): a person, no hot alert
  "silent_off", // responder off for this property: no hold, no alert, no reply
  "numeric_hold", // up-front hold under the NON-hot reason keyword:numeric_amount (allow-list without a price phrase): a person, no hot alert
  "dnc_review", // Jev dnc: pending human DNC review + jev_dnc_needs_confirm hold, no suppression, not hot
  "jev_no_action_hold", // Jev unclear / bad_number with no route: held jev_unclear_no_action for a person, not hot
] as const;
export type Bucket = (typeof BUCKETS)[number];

/* ----------------------------------------------------------------------------------------
 * Corpus types (data lives in corpus.json; validated by corpus.ts).
 * -------------------------------------------------------------------------------------- */
export type Scenario = {
  id: string;
  title: string;
  /** The last text WE sent (state.our_last_text_to_homeowner). */
  our_last_text: string;
  /** Nine answers accepted as "right" for the classifier lane; null = Jev is not consulted on this path (up-front gate). */
  expected_answers: readonly NineAnswer[] | null;
  /** Dispatch buckets accepted as "right". One entry normally; two only where Jarrad has a standing decision open. */
  expected_buckets: readonly Bucket[];
  /** Known product gap (e.g. "gave a time to call"): reported, excluded from the gate. */
  known_gap?: string;
  /** Standing question for Jarrad; reported, excluded from the gate until answered. */
  review?: string;
  /** Only the dispatch lane can exercise it (needs property/org state). */
  db_only?: boolean;
  /** Dispatch-lane state: the property has ai_responder_disabled = true. */
  property_disabled?: boolean;
  /** Dispatch-lane org state: ai_responder_configs.escalation_keywords (the org allow-list). Absent = built-in list. */
  org_escalation_keywords?: readonly string[];
  /** Classifier engine for this scenario. Absent = nine_questions. outcome_v1 = the eight-answer Jev outcome engine. */
  jev_engine?: "nine_questions" | "outcome_v1";
  /** outcome_v1 only: the stub Jev outcome and escalation reason (the scenario's fixture answer). */
  stub_outcome?: OutcomeV1;
  stub_escalation?: string;
  /** Citation of the already-decided rule the expectation follows. */
  rule?: string;
  wordings: readonly string[];
};

export const OUTCOME_V1 = ["new_lead", "nurture", "not_interested", "unclear", "bad_number", "wrong_number", "opted_out", "dnc"] as const;
export type OutcomeV1 = (typeof OUTCOME_V1)[number];

/* ----------------------------------------------------------------------------------------
 * Dispatch precedence mirror (classifier lane). Order copied from runNineQuestionsStep and
 * the step-2 keyword gate in src/lib/ai-responder/dispatch.ts; helpers are the real ones.
 * The dispatch lane is authoritative; this mirror exists so the cheap lane can still report
 * a wrong-bucket estimate.
 * -------------------------------------------------------------------------------------- */
const NINE_YIELDS_TO_HOT: ReadonlySet<string> = new Set(["maybe_later", "not_interested", "asked_who", "confirmed_owner", "needs_person"]);

export function upFrontKeywordBucket(text: string, allowedPhrases?: readonly string[] | null): Bucket | null {
  // Step 2 of dispatch (applyKeywordEscalation, Jev automatic), candidate 729a282b:
  //  - no keyword at all: no up-front hold;
  //  - an ALLOWED price signal alone is deferred to the shared hot decision (null here);
  //    with a non-price phrase too, it is held under the NON-price reason (keyword_hold);
  //  - a numeric amount the allow-list does not cover is held under keyword:numeric_amount (numeric_hold);
  //  - any other (non-price) phrase is held under its reason (keyword_hold).
  const allowed = allowedPhrases ?? undefined;
  const kw = matchEscalationKeyword(text, { allowedPhrases: allowed });
  if (!kw) return null;
  if (hasAllowedPriceSignal(text, allowedPhrases ?? null)) return nonPriceTier(text, allowedPhrases ?? null) ? "keyword_hold" : null;
  if (kw.tier === "price_offer" && !priceSignalAllowed(kw, allowedPhrases ?? null)) return "numeric_hold";
  return "keyword_hold";
}

/**
 * Classifier-lane mirror for the outcome_v1 engine scenarios. Only the stop / DNC / wrong / bad
 * number outcomes are modelled (the scenarios that use this lane); anything else is reported as
 * other:<outcome> so it can never silently pass.
 */
export function predictOutcomeV1Bucket(outcome: OutcomeV1, text: string, allowedPhrases?: readonly string[] | null): Bucket | `other:${string}` {
  const upFront = upFrontKeywordBucket(text, allowedPhrases);
  if (upFront) return upFront;
  if (outcome === "dnc") return "dnc_review"; // close_dnc route: review + hold, stopOrDncWins
  if (outcome === "bad_number") return "jev_no_action_hold"; // jev_no_action, never hot (hotWinsOver)
  return `other:${outcome}`;
}

export function predictBucket(answer: NineAnswer, text: string, allowedPhrases?: readonly string[] | null): Bucket {
  const upFront = upFrontKeywordBucket(text, allowedPhrases);
  if (upFront) return upFront;
  if (isHostileInbound(text) || answer === "hostile") return "stop_person";
  // Candidate 729a282b isPriceKeyword: a numeric amount counts only when the allow-list has a price phrase.
  const isPrice = hasAllowedPriceSignal(text, allowedPhrases ?? null);
  if (NINE_YIELDS_TO_HOT.has(answer) && isPrice) return "hot";
  const action = actionForNineAnswer(answer);
  switch (action.kind) {
    case "hot":
      return "hot";
    case "wait_for_person":
      return action.reason === "needs_person" ? "needs_person" : "stop_person";
    case "reply_and_close_wrong_person":
      return "wrong_person";
    case "drip_only":
      return "confirmed_owner";
    case "reply_and_drip":
      return action.reply === "nurture" ? "maybe_later" : action.reply === "identity" ? "asked_who" : "not_interested";
  }
}

/** Dispatch lane: the bucket Sandra actually landed in, from the real outcome and rows. */
export function bucketFromDispatch(o: {
  outcome: { outcome: string; reason?: string };
  property: { needs_human_attention: boolean; last_ai_escalation_reason: string | null; outreach_dispo: string | null; status: string | null };
  outboundCount: number;
}): Bucket | `other:${string}` {
  const reason = o.outcome.reason ?? "";
  if (o.outcome.outcome === "skipped" && !o.property.needs_human_attention && o.outboundCount === 0) return "silent_off";
  if (reason === "keyword:numeric_amount") return "numeric_hold";
  if (o.property.last_ai_escalation_reason === "jev_dnc_needs_confirm") return "dnc_review";
  if (reason === "jev_unclear_no_action") return "jev_no_action_hold";
  if (reason === "model:new_lead_promoted" || reason === "hot_lead" || isHotReason(reason)) return "hot";
  if (reason === "nine_asked_stop" || reason === "nine_hostile" || reason === "hostile_needs_confirm") return "stop_person";
  if (reason === "nine_needs_person") return "needs_person";
  if (reason === "nine_questions:wrong_person" || o.property.outreach_dispo === "wrong_number") return "wrong_person";
  if (reason === "nine_questions:maybe_later") return "maybe_later";
  if (reason === "nine_questions:not_interested") return "not_interested";
  if (reason === "nine_questions:asked_who") return "asked_who";
  if (reason === "nine_questions:confirmed_owner") return "confirmed_owner";
  if (/^keyword:(handoff_request|legal_contract|distressed_seller)$/.test(reason)) return "keyword_hold";
  return `other:${reason || o.outcome.outcome}`;
}

/* ----------------------------------------------------------------------------------------
 * Stub classifier (dry runs; no paid call). Deterministic from a seed so a run is repeatable.
 * "oracle": probabilities that make the first expected answer win. "noisy": with probability
 * `noise` per call, a random question is pushed over the cutoff so flips and wrong buckets
 * appear and the arithmetic below is exercised.
 * -------------------------------------------------------------------------------------- */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export type StubOpts = { noise: number; rnd: () => number };

export function stubProbabilities(expected: readonly NineAnswer[] | null, opts: StubOpts): Record<NineQuestionId, number> {
  const probs = Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, 0.02 + opts.rnd() * 0.1])) as Record<NineQuestionId, number>;
  const target = expected?.find((a): a is NineQuestionId => a !== "needs_person") ?? null;
  if (target) probs[target] = NINE_QUESTION_CUTOFF + 0.05 + opts.rnd() * 0.3;
  if (opts.noise > 0 && opts.rnd() < opts.noise) {
    const pick = NINE_QUESTION_IDS[Math.floor(opts.rnd() * NINE_QUESTION_IDS.length)]!;
    probs[pick] = NINE_QUESTION_CUTOFF + 0.1 + opts.rnd() * 0.25;
  }
  return probs;
}

export function stubAnswer(expected: readonly NineAnswer[] | null, opts: StubOpts): { answer: NineAnswer; probabilities: Record<NineQuestionId, number> } {
  const probabilities = stubProbabilities(expected, opts);
  return { answer: decideNineQuestions(probabilities).answer, probabilities };
}

/* ----------------------------------------------------------------------------------------
 * Results and statistics. One row per (scenario, wording, repeat).
 * -------------------------------------------------------------------------------------- */
export type RunRow = {
  scenarioId: string;
  wordingIdx: number;
  repeat: number;
  answer: NineAnswer | null; // null when Jev was not consulted (up-front gate) or the call failed
  bucket: string; // Bucket or other:<reason>
  failed?: string;
};

export type ScenarioStats = {
  scenarioId: string;
  title: string;
  wordings: number;
  repeats: number;
  runs: number;
  failedRuns: number;
  /** Wordings whose answer differed across repeats / wordings run. */
  flip: { flipped: number; rate: number };
  /** Wordings whose BUCKET differed across repeats / wordings run (what Sandra would do flipped). */
  bucketFlip: { flipped: number; rate: number };
  /** Runs whose nine answer is outside expected_answers / runs with an answer (null when Jev is not consulted). */
  wrongAnswer: { wrong: number; rate: number } | null;
  /** Runs whose bucket is outside expected_buckets / runs. */
  wrongBucket: { wrong: number; rate: number; by: Record<string, number> };
  gated: boolean; // false for known_gap / review scenarios
  passes: boolean | null; // null when not gated
  note?: string;
};

export const GATES = { flipRateMax: 0.02, wrongBucketRateMax: 0.05 } as const;

export function summarizeScenario(s: Scenario, rows: readonly RunRow[]): ScenarioStats {
  const mine = rows.filter((r) => r.scenarioId === s.id && !r.failed);
  const failedRuns = rows.filter((r) => r.scenarioId === s.id && r.failed).length;
  const byWording = new Map<number, RunRow[]>();
  for (const r of mine) (byWording.get(r.wordingIdx) ?? byWording.set(r.wordingIdx, []).get(r.wordingIdx)!).push(r);
  let flipped = 0;
  let bucketFlipped = 0;
  for (const runs of byWording.values()) {
    if (new Set(runs.map((r) => r.answer)).size > 1) flipped++;
    if (new Set(runs.map((r) => r.bucket)).size > 1) bucketFlipped++;
  }
  const wordings = byWording.size;
  const answered = mine.filter((r) => r.answer !== null);
  const wrongAnswer =
    s.expected_answers === null || answered.length === 0
      ? null
      : (() => {
          const wrong = answered.filter((r) => !s.expected_answers!.includes(r.answer!)).length;
          return { wrong, rate: wrong / answered.length };
        })();
  const by: Record<string, number> = {};
  let wrong = 0;
  for (const r of mine) {
    if (!(s.expected_buckets as readonly string[]).includes(r.bucket)) {
      wrong++;
      by[r.bucket] = (by[r.bucket] ?? 0) + 1;
    }
  }
  const gated = !s.known_gap && !s.review;
  const flip = { flipped, rate: wordings ? flipped / wordings : 0 };
  const wrongBucket = { wrong, rate: mine.length ? wrong / mine.length : 0, by };
  const repeats = wordings ? Math.max(...[...byWording.values()].map((r) => r.length)) : 0;
  return {
    scenarioId: s.id,
    title: s.title,
    wordings,
    repeats,
    runs: mine.length,
    failedRuns,
    flip,
    bucketFlip: { flipped: bucketFlipped, rate: wordings ? bucketFlipped / wordings : 0 },
    wrongAnswer,
    wrongBucket,
    gated,
    passes: gated ? flip.rate < GATES.flipRateMax && wrongBucket.rate < GATES.wrongBucketRateMax && failedRuns === 0 : null,
    ...(s.known_gap ? { note: `known gap: ${s.known_gap}` } : s.review ? { note: `review: ${s.review}` } : {}),
  };
}

export type Summary = {
  scenarios: ScenarioStats[];
  gatedScenarios: number;
  gatedPassing: number;
  overall: { runs: number; failedRuns: number; flipRate: number; wrongBucketRate: number };
  allGatesPass: boolean;
};

export function summarize(scenarios: readonly Scenario[], rows: readonly RunRow[]): Summary {
  const stats = scenarios.map((s) => summarizeScenario(s, rows));
  const gated = stats.filter((s) => s.gated);
  const runs = stats.reduce((n, s) => n + s.runs, 0);
  const failedRuns = stats.reduce((n, s) => n + s.failedRuns, 0);
  const wordings = stats.reduce((n, s) => n + s.wordings, 0);
  const flipped = stats.reduce((n, s) => n + s.flip.flipped, 0);
  const wrong = stats.reduce((n, s) => n + s.wrongBucket.wrong, 0);
  return {
    scenarios: stats,
    gatedScenarios: gated.length,
    gatedPassing: gated.filter((s) => s.passes === true).length,
    overall: { runs, failedRuns, flipRate: wordings ? flipped / wordings : 0, wrongBucketRate: runs ? wrong / runs : 0 },
    allGatesPass: gated.length > 0 && gated.every((s) => s.passes === true),
  };
}

/* ----------------------------------------------------------------------------------------
 * Cost. TypeSafe bills input tokens only (see replay/nine-core.ts for the source of the rate).
 * -------------------------------------------------------------------------------------- */
export function estimateJevCost(requests: number) {
  const inputTokens = requests * TOKENS_PER_REQUEST_ESTIMATE;
  return { requests, inputTokens, usd: (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK };
}

/* ----------------------------------------------------------------------------------------
 * Environment guard for the dispatch lane. Every binding must be EXPLICIT (no defaults),
 * loopback, off the long-running dev-stack ports, free of hosted refs, and the operator must
 * acknowledge the database is disposable. Fail closed.
 * -------------------------------------------------------------------------------------- */
export const DEV_STACK_PORTS: readonly number[] = [54321, 54322, 54329, 54331];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOSTED = /ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz|\.supabase\.co\b|\.supabase\.in\b|\.pooler\.supabase\.com\b|\.neon\.tech\b|\.rds\.amazonaws\.com\b/i;
export const REQUIRED_DB_ENV = [
  "TEST_SUPABASE_DB_URL",
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_SERVICE_ROLE_KEY",
  "TEST_SUPABASE_ANON_KEY",
  "LOCAL_SUPABASE_URL",
  "LOCAL_SUPABASE_SERVICE_ROLE_KEY",
] as const;

export class StressGuardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "StressGuardError";
  }
}

function portOf(raw: string): number {
  const u = new URL(raw.replace(/^postgres(ql)?:/, "http:"));
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

export function assertStressDbEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (env.MV2_STRESS_DISPOSABLE_DB !== "1") {
    throw new StressGuardError("NOT_ACKNOWLEDGED", "set MV2_STRESS_DISPOSABLE_DB=1 to confirm the target is a throwaway stack (it is reset).");
  }
  if (env.VERCEL_ENV || env.VERCEL === "1") throw new StressGuardError("HOSTED_RUNTIME", "never on a hosted runtime.");
  if (env.RUN_PROD_CANARIES === "1") throw new StressGuardError("PROD_CANARY_FLAG", "RUN_PROD_CANARIES is set; this lane is not production.");
  for (const key of REQUIRED_DB_ENV) {
    if (!env[key] || env[key]!.trim() === "") throw new StressGuardError("MISSING_ENV", `${key} must be set explicitly (no defaults in this lane).`);
  }
  if (env.TEST_SUPABASE_URL !== env.LOCAL_SUPABASE_URL) {
    throw new StressGuardError("URL_MISMATCH", "TEST_SUPABASE_URL and LOCAL_SUPABASE_URL must name the same stack.");
  }
  if (env.TEST_SUPABASE_SERVICE_ROLE_KEY !== env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
    throw new StressGuardError("KEY_MISMATCH", "TEST_ and LOCAL_ service-role keys differ; one of them points elsewhere.");
  }
  for (const [key, value] of Object.entries(env)) {
    if (value && HOSTED.test(value)) throw new StressGuardError("HOSTED_REF_IN_ENV", `${key} references a hosted database service.`);
  }
  for (const key of ["TEST_SUPABASE_DB_URL", "TEST_SUPABASE_URL", "LOCAL_SUPABASE_URL"] as const) {
    let u: URL;
    try {
      u = new URL(env[key]!);
    } catch {
      throw new StressGuardError("BAD_URL", `${key} is not a URL.`);
    }
    if (!LOOPBACK.has(u.hostname)) throw new StressGuardError("NOT_LOOPBACK", `${key} is not loopback.`);
    if (u.search || u.hash) throw new StressGuardError("URL_QUERY", `${key} must not carry a query string (?host= can redirect).`);
    const port = portOf(env[key]!);
    if (DEV_STACK_PORTS.includes(port)) {
      throw new StressGuardError("DEV_STACK_PORT", `${key} uses port ${port}, a long-running dev-stack port (54321/54322/54329/54331): provision a throwaway stack (e2e/stress/provision-stack.mjs) and point here.`);
    }
  }
  if (portOf(env.TEST_SUPABASE_DB_URL!) === portOf(env.TEST_SUPABASE_URL!)) {
    throw new StressGuardError("BINDING_CONFUSION", "database and API URLs resolve to the same port.");
  }
  for (const name of ["SENDILLO_API_KEY", "TWILIO_AUTH_TOKEN", "DIALPAD_API_KEY"]) {
    if ((env[name] ?? "").trim() !== "") throw new StressGuardError("PROVIDER_CREDENTIAL", `${name} is set; the harness process must hold no way to reach a seller-SMS provider.`);
  }
}

/* ----------------------------------------------------------------------------------------
 * Report.
 * -------------------------------------------------------------------------------------- */
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderReport(o: {
  lane: "classifier" | "dispatch";
  classifier: "stub" | "live";
  summary: Summary;
  repeats: number;
  requests: { made: number; estimateUsd: number };
  generatedAt: string;
  stackHost?: string | null;
}): string {
  const L: string[] = [];
  L.push(`# Messages v2 Stage 5: wording x repeat matrix (${o.lane} lane, ${o.classifier} classifier)`, "");
  const s = o.summary;
  L.push(
    `${s.overall.runs} runs (${s.scenarios.length} scenarios x up to 10 wordings x ${o.repeats} repeats). Same text, different answer: ${pct(s.overall.flipRate)} of wordings. Wrong bucket: ${pct(s.overall.wrongBucketRate)} of runs. Gated scenarios passing: ${s.gatedPassing}/${s.gatedScenarios}. ${s.allGatesPass ? "ALL GATES PASS" : "GATES NOT MET"}.`,
    "",
  );
  if (o.classifier === "stub") L.push("STUB CLASSIFIER: these numbers prove the harness arithmetic, not Jev. No paid call was made.", "");
  L.push(`- Jev requests made: ${o.requests.made}; estimate for this matrix: $${o.requests.estimateUsd.toFixed(4)} (TypeSafe $${JEV_INPUT_USD_PER_MTOK}/1M input tokens, ~${TOKENS_PER_REQUEST_ESTIMATE} tokens/request).`);
  if (o.stackHost) L.push(`- Disposable stack: ${o.stackHost}`);
  L.push(`- Gates per scenario: flip rate < ${pct(GATES.flipRateMax)}, wrong bucket < ${pct(GATES.wrongBucketRateMax)}, zero failed runs. Known-gap and review scenarios are reported but not gated.`, "");
  L.push("| Scenario | Wordings | Runs | Flip (answer) | Flip (bucket) | Wrong answer | Wrong bucket | Wrong buckets seen | Gate |", "|---|---|---|---|---|---|---|---|---|");
  for (const sc of s.scenarios) {
    const wa = sc.wrongAnswer ? `${sc.wrongAnswer.wrong} (${pct(sc.wrongAnswer.rate)})` : "n/a";
    const seen = Object.entries(sc.wrongBucket.by).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
    const gate = sc.gated ? (sc.passes ? "pass" : "FAIL") : `not gated (${sc.note ?? ""})`;
    L.push(`| ${sc.scenarioId} | ${sc.wordings} | ${sc.runs}${sc.failedRuns ? ` (+${sc.failedRuns} failed)` : ""} | ${sc.flip.flipped} (${pct(sc.flip.rate)}) | ${sc.bucketFlip.flipped} (${pct(sc.bucketFlip.rate)}) | ${wa} | ${sc.wrongBucket.wrong} (${pct(sc.wrongBucket.rate)}) | ${seen} | ${gate} |`);
  }
  L.push("", `Generated ${o.generatedAt}.`, "");
  return L.join("\n");
}
