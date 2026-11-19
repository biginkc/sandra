import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";

/**
 * Seller time zone for routing v2 booking texts (Master A-005). A slot time is only shown in a
 * zone we can confirm from the property's own data; otherwise the step is held for a person.
 *
 *   - Single-zone states: STATE_TO_TZ (same table legacy quiet hours use).
 *   - Kansas: by county FIPS (property.fips_code, else counties.fips_code via county_id).
 *     Greeley 20071, Hamilton 20075, Sherman 20181, Wallace 20199 -> Mountain; every other
 *     Kansas county -> Central; unknown county -> hold.
 *   - Arizona (no DST) -> America/Phoenix, except Apache 04001, Coconino 04005, Navajo 04017
 *     (Navajo Nation observes DST) and unknown county -> hold.
 *   - Every other split-zone state -> hold (counties not curated).
 *   - Blank / unmapped state -> hold.
 * IANA zones, so DST is handled by the platform.
 */
export const SPLIT_ZONE_STATES = new Set([
  "AK", "AZ", "FL", "ID", "IN", "KS", "KY", "MI", "NE", "ND", "OR", "SD", "TN", "TX",
]);
const KS_MOUNTAIN_FIPS = new Set(["20071", "20075", "20181", "20199"]);
const AZ_HOLD_FIPS = new Set(["04001", "04005", "04017"]);

export type SellerZone = { kind: "zone"; zone: string } | { kind: "hold" };

function normFips(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits || digits.length > 5) return null;
  return digits.padStart(5, "0");
}

export function resolveSellerZone(input: { state: string | null | undefined; fips: string | null | undefined }): SellerZone {
  const state = (input.state ?? "").trim().toUpperCase();
  const zone = state ? STATE_TO_TZ[state] : undefined;
  if (!zone) return { kind: "hold" };
  if (!SPLIT_ZONE_STATES.has(state)) return { kind: "zone", zone };
  const fips = normFips(input.fips);
  if (state === "KS") {
    if (!fips || !fips.startsWith("20")) return { kind: "hold" };
    return { kind: "zone", zone: KS_MOUNTAIN_FIPS.has(fips) ? "America/Denver" : "America/Chicago" };
  }
  if (state === "AZ") {
    if (!fips || !fips.startsWith("04") || AZ_HOLD_FIPS.has(fips)) return { kind: "hold" };
    return { kind: "zone", zone: "America/Phoenix" };
  }
  return { kind: "hold" };
}
