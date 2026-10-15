import type { EscalationTier, KeywordMatch } from "./types";

/**
 * Force-escalation keyword classifier.
 *
 * Runs BEFORE Claude is called. If the seller's inbound body contains
 * any tier's trigger, we skip the AI path entirely and flag the
 * property `needs_human_attention=true`. This is the safety net for
 * the three highest-risk topic areas in wholesale SMS:
 *
 *   · Tier A — handoff_request: the seller explicitly wants a person.
 *     No amount of AI reply is going to satisfy that; don't try.
 *
 *   · Tier B — price_offer: wholesale AI must NEVER quote a number
 *     even ballpark; the cost of a wrong answer here (legal / deal-
 *     destroying) is orders of magnitude above the benefit of a fast
 *     first-touch.
 *
 *   · Tier C — legal_contract: lawyer/attorney/escrow/title-company
 *     territory — human judgment required.
 *
 *   · Tier D — distressed_seller: probate, divorce, bankruptcy — AI
 *     tone is too flat for emotionally-loaded contexts.
 *
 * The caller passes the config's `escalation_keywords` array
 * (org-editable in the DB), which maps each keyword to its tier via
 * the table below. Pure function; trivially testable.
 */

const TIER_KEYWORDS: Record<EscalationTier, ReadonlyArray<string>> = {
  handoff_request: [
    "human",
    "real person",
    "real human",
    "real agent",
    "speak to",
    "talk to a",
    "talk to an",
    "talk to someone",
    "connect me",
    "stop the bot",
  ],
  price_offer: [
    "price",
    "offer",
    "how much",
    "your offer",
  ],
  legal_contract: [
    "lawyer",
    "attorney",
    "legal",
    "lawsuit",
    "contract",
    "earnest",
    "closing",
    "escrow",
    "title company",
  ],
  distressed_seller: [
    "died",
    "deceased",
    "passed away",
    "probate",
    "estate",
    "divorce",
    "divorcing",
    "bankruptcy",
    "foreclosure",
  ],
};

/** Reverse index: phrase → tier. Built once. */
const PHRASE_TO_TIER: ReadonlyMap<string, EscalationTier> = new Map(
  (Object.entries(TIER_KEYWORDS) as Array<[EscalationTier, ReadonlyArray<string>]>)
    .flatMap(([tier, phrases]) => phrases.map((p) => [p.toLowerCase(), tier] as const)),
);

/**
 * Numeric + dollar-sign price signals. These aren't keyword matches in
 * the traditional sense — they're regex patterns — so they live here as
 * explicit checks rather than in the flat keyword array. If the body
 * contains a dollar sign followed by digits, or a number followed by
 * "k" / "thousand" / "million", escalate as tier B.
 *
 *   $150     → match
 *   $150k    → match
 *   150k     → match
 *   150 thousand → match
 *   150      → no match (too ambiguous on its own; the seller might be
 *               giving a zip or house number)
 */
const DOLLAR_AMOUNT_REGEX = /\$\s*\d/;
const NUMBER_WITH_SCALE_REGEX = /\b\d+\s*(k|thousand|million)\b/i;

/**
 * Check an inbound SMS body for an escalation trigger. Returns the
 * highest-priority match (first hit wins — order of tiers in the iter
 * determines priority, which is the order the table is defined in).
 *
 * `allowedPhrases` lets the org override the built-in list from the DB
 * (`ai_responder_configs.escalation_keywords`). When provided, ONLY
 * those phrases count; the built-in tier mapping still applies to each
 * phrase, but phrases not in the DB list are ignored.
 */
export function matchEscalationKeyword(
  body: string,
  opts: { allowedPhrases?: ReadonlyArray<string> } = {},
): KeywordMatch | null {
  if (!body) return null;
  const lower = body.toLowerCase();

  // Price-signal regexes first (cheap to check, high-impact).
  if (DOLLAR_AMOUNT_REGEX.test(body) || NUMBER_WITH_SCALE_REGEX.test(body)) {
    return { tier: "price_offer", phrase: "numeric-amount" };
  }

  const allowed = opts.allowedPhrases
    ? new Set(opts.allowedPhrases.map((p) => p.toLowerCase()))
    : null;

  // Longer phrases first so "talk to a" wins before the single word
  // "talk" would if someone ever adds it.
  const sortedPhrases = [...PHRASE_TO_TIER.keys()].sort(
    (a, b) => b.length - a.length,
  );

  for (const phrase of sortedPhrases) {
    if (allowed && !allowed.has(phrase)) continue;
    if (lower.includes(phrase)) {
      return { tier: PHRASE_TO_TIER.get(phrase)!, phrase };
    }
  }

  return null;
}

/**
 * True when the body also carries an escalation phrase of a NON-price tier
 * (handoff request, legal / contract, distressed seller), honouring the org's
 * allowed phrases. matchEscalationKeyword returns one tier and price wins, so
 * this is how a caller sees "Dad died, how much?" is also distress.
 */
export function hasNonPriceEscalationPhrase(
  body: string,
  opts: { allowedPhrases?: ReadonlyArray<string> } = {},
): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  const allowed = opts.allowedPhrases ? new Set(opts.allowedPhrases.map((p) => p.toLowerCase())) : null;
  for (const [phrase, tier] of PHRASE_TO_TIER) {
    if (tier === "price_offer") continue;
    if (allowed && !allowed.has(phrase)) continue;
    if (lower.includes(phrase)) return true;
  }
  return false;
}

/**
 * A numeric price signal ("$150k", "200k") counts as a price phrase only when
 * the org's allow-list includes a price-tier phrase (or there is no allow-list).
 * Otherwise it is "unlisted": still a reason to hold, never a hot alert.
 */
export function priceSignalAllowed(match: KeywordMatch | null, allowedPhrases?: ReadonlyArray<string> | null): boolean {
  if (!match || match.tier !== "price_offer") return false;
  if (match.phrase !== "numeric-amount" || !allowedPhrases) return true;
  const allowed = new Set(allowedPhrases.map((p) => p.toLowerCase()));
  return TIER_KEYWORDS.price_offer.some((p) => allowed.has(p.toLowerCase()));
}

/**
 * Any price signal the org allows, independent of which tier
 * matchEscalationKeyword picks (it returns only the longest phrase, so
 * "My lawyer is involved. What's your price?" selects "lawyer"). Price-tier
 * phrases honour the allow-list; a numeric amount counts only when the
 * allow-list includes a price phrase (or there is none).
 */
export function hasAllowedPriceSignal(body: string, allowedPhrases?: ReadonlyArray<string> | null): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  const allowed = allowedPhrases ? new Set(allowedPhrases.map((p) => p.toLowerCase())) : null;
  const pricePhrases = TIER_KEYWORDS.price_offer.filter((p) => !allowed || allowed.has(p.toLowerCase()));
  if (pricePhrases.some((p) => lower.includes(p.toLowerCase()))) return true;
  const numeric = DOLLAR_AMOUNT_REGEX.test(body) || NUMBER_WITH_SCALE_REGEX.test(body);
  return numeric && (!allowed || pricePhrases.length > 0);
}

/** The tier of the longest NON-price escalation phrase in the body (honouring the allow-list), or null. */
export function nonPriceTier(body: string, allowedPhrases?: ReadonlyArray<string> | null): EscalationTier | null {
  if (!body) return null;
  const lower = body.toLowerCase();
  const allowed = allowedPhrases ? new Set(allowedPhrases.map((p) => p.toLowerCase())) : null;
  const phrases = [...PHRASE_TO_TIER.entries()]
    .filter(([p, t]) => t !== "price_offer" && (!allowed || allowed.has(p)))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [p, t] of phrases) if (lower.includes(p)) return t;
  return null;
}
