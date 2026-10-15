import { maskAddresses, type PhoneMasker } from "./mask";
import type { NineAnswer } from "../../../src/lib/sms-classification/nine-questions";

/**
 * Pure pieces of the nine-question replay: human-label mapping, agreement
 * stats, flip rate, cost/request ceiling and the report. No I/O here.
 */

// TypeSafe bills input tokens only ($0.042 per 1M, output free; TypeSafe list
// price as of 2026-09-22; consistent with docs/jev-adapter/new-lead-decision.md:
// 14,234 tokens -> $0.000598).
export const JEV_INPUT_USD_PER_MTOK = 0.042;
// Nine question texts + request envelope + state. Measured guess ~700; padded.
export const TOKENS_PER_REQUEST_ESTIMATE = 1500;

export type NineSample = {
  /** Stable index into the export (no real ids leave the database). */
  idx: number;
  /** Masked inbound text. */
  reply: string;
  /** Masked most recent outbound before it on the same thread, if any. */
  ourLastText: string | null;
  /** properties.outreach_dispo now, and properties.status now. */
  humanDispo: string | null;
  humanStatus: string | null;
  /** True only for the LAST inbound of its property inside the window. */
  isLastForProperty: boolean;
};

/** Human group name -> acceptable nine answers. */
export const HUMAN_MAP: Record<string, readonly NineAnswer[]> = {
  not_interested: ["not_interested"],
  wrong_number: ["wrong_person"],
  opted_out: ["asked_stop"],
  dnc: ["asked_stop"],
  lead: ["open_to_selling", "talked_price"],
  new_lead: ["open_to_selling", "talked_price"],
  nurture: ["maybe_later"],
};

/**
 * The human outcome for a text. Only the last inbound on a property carries
 * the property's current dispo as its label: the dispo is the human's verdict
 * on the conversation, so it can only be pinned on the text that ended it.
 * bad_number / callback_requested / no dispo -> no label.
 */
export function humanLabel(s: Pick<NineSample, "humanDispo" | "humanStatus" | "isLastForProperty">): {
  group: string;
  expected: readonly NineAnswer[];
} | null {
  if (!s.isLastForProperty) return null;
  const key = s.humanDispo && HUMAN_MAP[s.humanDispo] ? s.humanDispo : s.humanStatus && HUMAN_MAP[s.humanStatus] ? s.humanStatus : null;
  if (!key) return null;
  return { group: key, expected: HUMAN_MAP[key] };
}

export type ScoredRow = {
  idx: number;
  answer: NineAnswer;
  group: string | null;
  expected: readonly NineAnswer[] | null;
  agrees: boolean | null;
};

export function scoreRow(s: NineSample, answer: NineAnswer): ScoredRow {
  const label = humanLabel(s);
  return {
    idx: s.idx,
    answer,
    group: label?.group ?? null,
    expected: label?.expected ?? null,
    agrees: label ? label.expected.includes(answer) : null,
  };
}

export type Stats = {
  total: number;
  labeled: number;
  agree: number;
  agreementRate: number | null;
  /** Per human group: how often our answer was acceptable (recall-ish). */
  byHuman: Record<string, { n: number; hits: number; recall: number }>;
  /** Per predicted answer, among labeled rows (precision-ish). */
  byAnswer: Record<string, { n: number; hits: number; precision: number | null }>;
  /** group -> predicted answer -> count. */
  confusion: Record<string, Record<string, number>>;
  answerCounts: Record<string, number>;
};

export function summarizeScores(rows: readonly ScoredRow[]): Stats {
  const byHuman: Stats["byHuman"] = {};
  const byAnswer: Stats["byAnswer"] = {};
  const confusion: Stats["confusion"] = {};
  const answerCounts: Record<string, number> = {};
  let labeled = 0;
  let agree = 0;
  for (const r of rows) {
    answerCounts[r.answer] = (answerCounts[r.answer] ?? 0) + 1;
    if (r.group === null || r.agrees === null) continue;
    labeled++;
    if (r.agrees) agree++;
    const h = (byHuman[r.group] ??= { n: 0, hits: 0, recall: 0 });
    h.n++;
    if (r.agrees) h.hits++;
    const a = (byAnswer[r.answer] ??= { n: 0, hits: 0, precision: null });
    a.n++;
    if (r.agrees) a.hits++;
    const c = (confusion[r.group] ??= {});
    c[r.answer] = (c[r.answer] ?? 0) + 1;
  }
  for (const h of Object.values(byHuman)) h.recall = h.n ? h.hits / h.n : 0;
  for (const a of Object.values(byAnswer)) a.precision = a.n ? a.hits / a.n : null;
  return { total: rows.length, labeled, agree, agreementRate: labeled ? agree / labeled : null, byHuman, byAnswer, confusion, answerCounts };
}

/** answersPerRun[run][i] = answer for sample i. Returns share of samples whose answer was not identical across runs. */
export function flipRate(answersPerRun: readonly (readonly string[])[]): { samples: number; flipped: number; rate: number } {
  const n = answersPerRun[0]?.length ?? 0;
  let flipped = 0;
  for (let i = 0; i < n; i++) {
    const seen = new Set(answersPerRun.map((run) => run[i]));
    if (seen.size > 1) flipped++;
  }
  return { samples: n, flipped, rate: n ? flipped / n : 0 };
}

/** Deterministic, seedable sample of k indices (mulberry32 shuffle). */
export function sampleIndices(n: number, k: number, seed = 20261015): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let t = seed >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

export function estimateCost(requests: number, tokensPerRequest = TOKENS_PER_REQUEST_ESTIMATE) {
  const inputTokens = requests * tokensPerRequest;
  return { requests, inputTokens, usd: (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK };
}

export const COST_CAP_USD = 30;

export function requestPlan(inboundCount: number, sampleSize: number, repeatRuns: number) {
  const sample = Math.min(sampleSize, inboundCount);
  return { main: inboundCount, flip: sample * repeatRuns, ceiling: inboundCount + sample * repeatRuns };
}

export class RequestCeilingError extends Error {
  constructor(public readonly ceiling: number) {
    super(`nine-question replay: request ceiling ${ceiling} reached; refusing further calls`);
    this.name = "RequestCeilingError";
  }
}

/** Wraps fetch: only api.typesafe.ai, POST only, hard count ceiling. */
export function guardedFetch(inner: typeof fetch, ceiling: number): { fetch: typeof fetch; count: () => number } {
  let count = 0;
  const fn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.protocol !== "https:" || url.hostname !== "api.typesafe.ai") {
      throw new Error(`nine-question replay: refusing request to ${url.hostname}`);
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST") throw new Error("nine-question replay: POST only");
    if (count >= ceiling) throw new RequestCeilingError(ceiling);
    count++;
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: fn, count: () => count };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export type DisagreementRow = {
  idx: number;
  reply: string;
  ourLastText: string | null;
  answer: NineAnswer;
  group: string;
  probs: Record<string, number | null>;
};

export function topProbs(probs: Record<string, number | null>, n = 3): string {
  return Object.entries(probs)
    .filter((e): e is [string, number] => e[1] !== null)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
}

export function renderReport(o: {
  stats: Stats;
  dateRange: { start: string; end: string };
  estimate: { requests: number; usd: number; inputTokens: number; ceiling: number };
  actualRequests: number;
  flip: { samples: number; flipped: number; rate: number; runs: number };
  disagreements: readonly DisagreementRow[];
  generatedAt: string;
}): string {
  const { stats: s } = o;
  const L: string[] = [];
  L.push("# Messages v2 PR 3: nine-question replay", "");
  L.push("## Plain-English summary", "");
  L.push(
    `We ran the last 30 days of homeowner texts (${s.total}) through the nine questions. ${s.labeled} of them have a clear human answer; on those, the nine questions agreed with the human ${pct(s.agreementRate)} of the time (${s.agree}/${s.labeled}). Re-asking the same text three times changed the answer for ${o.flip.flipped} of ${o.flip.samples} sampled texts (${pct(o.flip.rate)}). Cost was tiny; see below. Every disagreement is listed at the bottom.`,
    "",
  );
  L.push("Caveat: the human label is the property's CURRENT disposition, pinned on the last text we received from that property in the window. Dispositions set by the AI and not yet corrected also count as 'human' here, so agreement is an upper bound on true human agreement.", "");
  L.push("## Cost and requests", "");
  L.push(`- TypeSafe price: $${JEV_INPUT_USD_PER_MTOK}/1M input tokens, output free (list price 2026-09-22; one System One request carries all nine questions).`);
  L.push(`- Estimate: ${o.estimate.requests} requests x ${TOKENS_PER_REQUEST_ESTIMATE} tokens = ${o.estimate.inputTokens.toLocaleString()} tokens = $${o.estimate.usd.toFixed(4)} (cap $${COST_CAP_USD}; hard request ceiling in code: ${o.estimate.ceiling}).`);
  L.push(`- Actual requests made: ${o.actualRequests}.`, "");
  L.push("## Window and totals", "");
  L.push(`- Date range: ${o.dateRange.start} to ${o.dateRange.end}`);
  L.push(`- Inbound texts: ${s.total}; with a human label: ${s.labeled}; no human label (excluded): ${s.total - s.labeled}`, "");
  L.push("## Human label mapping", "");
  for (const [k, v] of Object.entries(HUMAN_MAP)) L.push(`- ${k} -> ${v.join(" or ")}`);
  L.push("- Everything else (no dispo, bad_number, callback_requested, not the last text of its property) -> no human label, excluded.", "");
  L.push("## Answer distribution (all texts)", "");
  L.push("| Answer | Count |", "|---|---|");
  for (const [k, v] of Object.entries(s.answerCounts).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push("", "## Agreement by human outcome (recall-ish)", "", "| Human | Texts | Agreed | Rate |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(s.byHuman)) L.push(`| ${k} | ${v.n} | ${v.hits} | ${pct(v.recall)} |`);
  L.push("", "## Agreement by nine answer (precision-ish, labeled texts only)", "", "| Answer | Predicted | Matched human | Rate |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(s.byAnswer)) L.push(`| ${k} | ${v.n} | ${v.hits} | ${pct(v.precision)} |`);
  L.push("", "## Confusion (rows: human outcome, columns: our answer)", "");
  for (const [g, row] of Object.entries(s.confusion)) {
    L.push(`- ${g}: ${Object.entries(row).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(", ")}`);
  }
  L.push("", "## Flip rate", "");
  L.push(`${o.flip.samples} sampled texts x ${o.flip.runs} repeat runs: ${o.flip.flipped} changed answer (${pct(o.flip.rate)}).`, "");
  L.push(`## Full disagreement list (${o.disagreements.length})`, "");
  L.push("| # | Homeowner text (masked) | Our last text (masked) | Nine answer | Human | Top probabilities |", "|---|---|---|---|---|---|");
  for (const d of o.disagreements) {
    L.push(`| ${d.idx} | ${cell(d.reply)} | ${cell(d.ourLastText ?? "(none)")} | ${d.answer} | ${d.group} | ${topProbs(d.probs)} |`);
  }
  L.push("", `Generated ${o.generatedAt}.`, "");
  return L.join("\n");
}

/** Replace known contact names (3+ letters) in free text with a placeholder. */
export function scrubNames(text: string, names: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const n of names) {
    const t = (n ?? "").trim();
    if (t.length < 3) continue;
    out = out.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  }
  return out;
}

/** Phones, emails, street addresses and contact names out; used BEFORE classification and for all output. */
export function sanitizeText(masker: PhoneMasker, text: string, names: readonly (string | null | undefined)[]): string {
  return scrubNames(maskAddresses(masker.maskText(text)), names);
}
