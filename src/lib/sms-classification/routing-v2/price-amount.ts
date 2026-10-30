/**
 * Deterministic dollar-amount extractor for the routing v2 price check (PR-E). No model.
 *
 * A token counts as a dollar amount only when it carries money evidence:
 *   - a `$` prefix ("$150k", "$150,000", "$1.2M", "$95000", "$150,000.00"), or
 *   - a magnitude suffix glued to the number ("150k", "1.2M", "1.5mil"), or a magnitude word
 *     ("150 thousand", "1.5 million", "150 grand"), or
 *   - correct thousands grouping ("150,000", "1,250,000"), or
 *   - a currency word after it ("150000 dollars", "95000 bucks").
 * Bare numbers ("123 Main St", "64111", "built 1985", "3 bed"), phone numbers ("816-555-1234",
 * "(816) 555-1234") and areas ("2k sq ft", "5 acres") are NOT amounts. When in doubt it finds
 * nothing, which routes to the fair-price reply + alert (a person looks), never an auto price
 * decision.
 *
 * Result: exactly one distinct amount → `single`; amounts joined by a range connector
 * ("150-170k", "$150k to $170k", "between 150k and 170k", "150k or 160k") → `range`; two or
 * more distinct amounts → `multiple`; none → `none`. The same value said twice is one amount.
 */
export type ExtractedPrice =
  | { kind: "single"; amount: number }
  | { kind: "none" }
  | { kind: "multiple"; amounts: number[] }
  | { kind: "range"; amounts: number[] };

type Token = { start: number; end: number; amount: number };

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  grand: 1e3,
  m: 1e6,
  mm: 1e6,
  mil: 1e6,
  million: 1e6,
};

// Number body: grouped (1,234,567) or plain, optional decimals.
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const AREA_AFTER = String.raw`(?!\s*(?:sq\b|sq\.|sqft|square|ft\b|feet|acre|acres|ac\b|mi\b|miles|%|percent|bed|bd\b|bath|ba\b|br\b|yrs?\b|years?\b))`;

const TOKEN_RE = new RegExp(
  String.raw`(?<![\w$.,])(\$\s?)?(${NUM})` + // optional $, number (not glued to a word or digit)
    String.raw`(?:(k|mm|m|mil)\b|\s+(thousand|million|grand)\b|\s*(dollars|bucks|usd)\b)?` +
    AREA_AFTER +
    String.raw`(?!\w)`,
  "gi",
);

/** Range connector between two numbers, at least one of which is an amount token. */
const RANGE_RE = new RegExp(
  String.raw`\$?\s?${NUM}\s*(?:k|mm|m|mil|thousand|million|grand)?\s*(?:-|–|—|to|or)\s*\$?\s?${NUM}` +
    String.raw`|between\s+\$?\s?${NUM}[^\n]{0,24}?\band\b\s*\$?\s?${NUM}`,
  "gi",
);

function toCents(n: number): number {
  return Math.round(n * 100);
}

function readTokens(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const [, dollar, body, glued, word, currency] = m;
    const suffix = (glued ?? word ?? "").toLowerCase();
    const grouped = body.includes(",");
    const hasEvidence = Boolean(dollar) || Boolean(suffix) || Boolean(currency) || grouped;
    if (!hasEvidence) continue;
    if (grouped && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(body)) continue;
    // A grouped number must be a plausible amount (≥ 1,000), never a list like "1,2,3".
    const base = Number(body.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const amount = base * (suffix ? MULTIPLIERS[suffix] : 1);
    if (!(amount > 0)) continue;
    tokens.push({ start: m.index!, end: m.index! + m[0].length, amount: toCents(amount) / 100 });
  }
  return tokens;
}

export function extractDollarAmount(text: string): ExtractedPrice {
  const tokens = readTokens(text);
  if (tokens.length === 0) return { kind: "none" };
  const distinct = [...new Set(tokens.map((t) => toCents(t.amount)))].map((c) => c / 100);

  for (const m of text.matchAll(RANGE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (tokens.some((t) => t.start < end && t.end > start)) return { kind: "range", amounts: distinct };
  }
  if (distinct.length > 1) return { kind: "multiple", amounts: distinct };
  return { kind: "single", amount: distinct[0] };
}

/** Ask > 80% of value (strictly). Exactly 80% is NOT too high. Compared in integer cents. */
export function askAboveEightyPercent(ask: number, value: number): boolean {
  return toCents(ask) * 5 > toCents(value) * 4;
}
