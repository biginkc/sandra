import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Routing v2 flags + canary eligibility (BUILD-PLAN §4, §13.1, §13.2).
 *
 * Fail closed everywhere: a missing column, a lookup error, a non-boolean value, a
 * malformed canary id or an out-of-range percent all read as OFF / not eligible.
 */
export const V2_SLICES = [
  "replies",
  "drips",
  "haiku",
  "price_check",
  "alert_on_time_only",
  "wrong_number_all",
  "model_stop_suppression",
] as const;
export type V2Slice = (typeof V2_SLICES)[number];

export type RoutingV2Flags = {
  shadow: boolean;
  questions_live: boolean;
  canaryPropertyIds: ReadonlySet<string>;
  /** False when canary_property_ids is malformed (any non-UUID entry or not an array): nothing is eligible. */
  canaryValid: boolean;
  canaryPercent: number;
} & Record<V2Slice, boolean>;

export const ALL_OFF: RoutingV2Flags = Object.freeze({
  shadow: false,
  questions_live: false,
  replies: false,
  drips: false,
  haiku: false,
  price_check: false,
  alert_on_time_only: false,
  wrong_number_all: false,
  model_stop_suppression: false,
  canaryPropertyIds: new Set<string>(),
  canaryValid: true,
  canaryPercent: 0,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Parse `ai_responder_configs.routing_v2_flags`. Only literal `true` turns a flag on. */
export function parseRoutingV2Flags(raw: unknown): RoutingV2Flags {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ALL_OFF;
  const r = raw as Record<string, unknown>;
  const on = (k: string) => r[k] === true;
  // Fail closed: one bad entry (or a non-array) disables canary eligibility entirely,
  // never a silent filter that still enables the valid ids.
  const rawIds = r.canary_property_ids;
  const canaryValid = rawIds === undefined || (Array.isArray(rawIds) && rawIds.every(isUuid));
  const ids = canaryValid && Array.isArray(rawIds) ? new Set((rawIds as string[]).map((s) => s.toLowerCase())) : new Set<string>();
  const pct = r.canary_percent;
  const pctValid = pct === undefined || (typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 100);
  const canaryPercent = pctValid && typeof pct === "number" ? pct : 0;
  return {
    shadow: on("shadow"),
    questions_live: on("questions_live"),
    replies: on("replies"),
    drips: on("drips"),
    haiku: on("haiku"),
    price_check: on("price_check"),
    alert_on_time_only: on("alert_on_time_only"),
    wrong_number_all: on("wrong_number_all"),
    model_stop_suppression: on("model_stop_suppression"),
    canaryPropertyIds: ids,
    canaryValid: canaryValid && pctValid,
    canaryPercent,
  };
}

/** Stable 0..99 bucket per property (sha256, first 4 bytes). Never changes for a given id. */
export function canaryBucket(propertyId: string): number {
  const h = createHash("sha256").update(propertyId.toLowerCase()).digest();
  return h.readUInt32BE(0) % 100;
}

export function isV2Eligible(flags: RoutingV2Flags, propertyId: string): boolean {
  if (!flags.canaryValid || !isUuid(propertyId)) return false;
  if (flags.canaryPropertyIds.has(propertyId.toLowerCase())) return true;
  return canaryBucket(propertyId) < flags.canaryPercent;
}

/** A slice acts only when questions_live AND its own key are on AND the property is eligible. */
export function v2SliceAllowed(flags: RoutingV2Flags, slice: V2Slice, propertyId: string): boolean {
  return flags.questions_live && flags[slice] && isV2Eligible(flags, propertyId);
}

/** Phone-level actions: every property on the phone must be eligible (§13.1). */
export function v2SliceAllowedForAll(flags: RoutingV2Flags, slice: V2Slice, propertyIds: readonly string[]): boolean {
  return propertyIds.length > 0 && propertyIds.every((id) => v2SliceAllowed(flags, slice, id));
}

type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Fresh read of the org's flags. Any error = all off. */
export async function readRoutingV2Flags(supabase: SupabaseClient<Database>, orgId: string): Promise<RoutingV2Flags> {
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("ai_responder_configs")
      .select("routing_v2_flags")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return ALL_OFF;
    return parseRoutingV2Flags((data as { routing_v2_flags?: unknown }).routing_v2_flags);
  } catch {
    return ALL_OFF;
  }
}

/**
 * Send-time re-check (§13.2): re-reads the flags right before a send/enroll/alert and
 * refuses if the slice was switched off or the property is no longer eligible.
 */
export function makeSendTimeRecheck(
  read: () => Promise<RoutingV2Flags>,
  propertyId: string,
): (slice: V2Slice) => Promise<boolean> {
  return async (slice) => {
    try {
      return v2SliceAllowed(await read(), slice, propertyId);
    } catch {
      return false;
    }
  };
}
