/**
 * `{{rapid_offer}}` merge token: a fixed percentage of the DealMachine
 * estimated value, rounded to the nearest $1,000. Pure helpers only —
 * value lookup reads stored data (properties.arv, dealmachine_value_cache)
 * and never calls the DealMachine API.
 */

export const RAPID_OFFER_PCT_DEFAULT = 0.75;
export const RAPID_OFFER_ROUND_TO = 1000;

export const RAPID_OFFER_TOKEN_RE = /\{\{\s*rapid_offer(\s*\|[^}]*)?\s*\}\}/;

export type RapidOfferSource = "properties.arv" | "dealmachine_value_cache";

export type RapidOfferMeta = {
  amount: number;
  sourceValue: number;
  source: RapidOfferSource;
  pct: number;
};

/** Parse RAPID_OFFER_PCT; must be a number in (0, 1], else the default. */
export function resolveRapidOfferPct(raw: string | undefined = process.env.RAPID_OFFER_PCT): number {
  if (raw === undefined || raw.trim() === "") return RAPID_OFFER_PCT_DEFAULT;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return RAPID_OFFER_PCT_DEFAULT;
  return n;
}

export function computeRapidOffer(
  value: number | null | undefined,
  pct: number = resolveRapidOfferPct(),
): number | null {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) return null;
  const amount = Math.round((value * pct) / RAPID_OFFER_ROUND_TO) * RAPID_OFFER_ROUND_TO;
  return amount > 0 ? amount : null;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatRapidOffer(amount: number): string {
  return USD.format(amount);
}

function positive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function resolveRapidOfferSource(row: {
  arv: number | null;
  cacheValue: number | null;
}): { value: number; source: RapidOfferSource } | null {
  if (positive(row.arv)) return { value: row.arv, source: "properties.arv" };
  if (positive(row.cacheValue)) return { value: row.cacheValue, source: "dealmachine_value_cache" };
  return null;
}

export function usesRapidOfferToken(text: string | null | undefined): boolean {
  return !!text && RAPID_OFFER_TOKEN_RE.test(text);
}
