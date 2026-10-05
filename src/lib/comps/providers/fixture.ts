import type { CompProvider, CompSale, CompSubject, ProviderCompResult } from "../types";

/**
 * Deterministic fixture provider: every number derives from `hash(propertyId)`, so tests and
 * local development are repeatable with no vendor call. Rows store `provider='fixture'`, the UI
 * shows a SAMPLE DATA ribbon, and `getCompProvider` refuses this provider in production.
 */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function fixtureResult(subject: CompSubject): ProviderCompResult {
  const h = hashString(subject.propertyId);
  const value = 120_000 + (h % 280) * 1_000; // 120k .. 399k
  const fsdPct = 4 + (h % 19); // 4 .. 22 → spans high/medium/low
  const spread = Math.round((value * fsdPct) / 100);
  const compCount = h % 5; // 0 .. 4 → exercises few_comps
  const comps: CompSale[] = Array.from({ length: compCount }, (_, i) => ({
    address: `${100 + i} Sample St, ${subject.city ?? "Sample City"}, ${subject.state} ${subject.zip ?? "00000"}`,
    saleDate: `2026-0${1 + (i % 9)}-15`,
    salePrice: value + (i - 2) * 7_500,
    sqft: subject.sqft ?? 1_400 + i * 50,
    beds: subject.beds ?? 3,
    baths: subject.baths ?? 2,
    yearBuilt: subject.yearBuilt ?? 1960 + i,
    distanceMiles: Number((0.2 + i * 0.15).toFixed(2)),
    providerId: `fixture-${h}-${i}`,
    renovatedHint: null,
  }));
  const legalComplete = h % 3 !== 0;
  return {
    providerPropertyId: `fixture-${h}`,
    asIs: { value, low: value - spread, high: value + spread, score: 100 - fsdPct * 3, fsdPct },
    comps,
    ownerOfRecord: "SAMPLE OWNER",
    legal: legalComplete
      ? { text: `SAMPLE SUBDIVISION BLOCK ${h % 12} LOT ${h % 40} (FIXTURE)`, complete: true }
      : { text: "SAMPLE SUBDIVISION", complete: false },
    billedCalls: 0,
    raw: { fixture: true, hash: h },
  };
}

export function createFixtureProvider(): CompProvider {
  return {
    name: "fixture",
    callsPerComp: 0,
    async fetch(subject) {
      return fixtureResult(subject);
    },
  };
}
