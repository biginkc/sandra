import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { resolveCallbackTime, type CallbackTimeProvider } from "./callback-time";
import type { NormaCallInput, NormaOutcomeMapping } from "./outcome";

/** The whole conversion (state lookup + parse + optional AI) never delays a completion longer than this. */
export const CALLBACK_CONVERSION_TIMEOUT_MS = 6_000;

const MAX_CALL_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_MS = 5 * 60_000;

/** A positive, finite number from a number or numeric string (Bland sends both); else null. */
function positiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * When the call actually ended, the reference for "tomorrow", "in 2 hours" and
 * "never in the past". `end_at` is NOT used: Bland's `end_at` is the max-duration
 * cutoff, not the real end. In order:
 *   1. `started_at` + `corrected_duration` (seconds)
 *   2. `started_at` + `call_length` (minutes) x 60
 *   3. now
 * A missing or malformed input, or an end that would be in the future, skips
 * that step. Never throws.
 */
export function callEndedAtMs(call: NormaCallInput, nowMs: number): number {
  const record = call as Record<string, unknown>;
  const startedText = record.started_at;
  const started = typeof startedText === "string" ? Date.parse(startedText) : NaN;
  if (Number.isFinite(started) && started <= nowMs + CLOCK_SKEW_MS) {
    const seconds = positiveNumber(record.corrected_duration);
    const minutes = positiveNumber(record.call_length);
    const candidates = [seconds !== null ? seconds * 1000 : null, minutes !== null ? minutes * 60_000 : null];
    for (const duration of candidates) {
      if (duration === null || duration > MAX_CALL_SECONDS * 1000) continue;
      const end = started + duration;
      if (end <= nowMs + CLOCK_SKEW_MS) return end;
    }
  }
  return nowMs;
}

/**
 * Adds a converted callback time to a `callback_requested` mapping, just
 * before `fn_norma_complete_call`. Any failure or timeout leaves the mapping
 * untouched, so the task is due now with the seller's own words. It can never
 * fail or hold up the completion beyond the timeout.
 */
export async function withConvertedCallbackTime(
  mapping: NormaOutcomeMapping,
  deps: {
    client: SupabaseClient<Database>;
    propertyId: string;
    call: NormaCallInput;
    provider?: CallbackTimeProvider | null;
    nowMs?: number;
    timeoutMs?: number;
  },
): Promise<NormaOutcomeMapping> {
  if (mapping.outcome !== "callback_requested") return mapping;
  const nowMs = deps.nowMs ?? Date.now();
  const timeoutMs = deps.timeoutMs ?? CALLBACK_CONVERSION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const convert = async (): Promise<NormaOutcomeMapping> => {
      const { data: property, error } = await deps.client.from("properties").select("state").eq("id", deps.propertyId).maybeSingle();
      // An unreadable state means the zone is unknown: do not guess one.
      if (error) return mapping;
      const variables =
        deps.call.variables && typeof deps.call.variables === "object" && !Array.isArray(deps.call.variables)
          ? (deps.call.variables as Record<string, unknown>)
          : {};
      const converted = await resolveCallbackTime({
        variables,
        completedAtMs: callEndedAtMs(deps.call, nowMs),
        nowMs,
        state: property?.state ?? null,
        provider: deps.provider ?? null,
        aiTimeoutMs: Math.max(500, timeoutMs - 1_500),
      });
      if (!converted) return mapping;
      return {
        ...mapping,
        payload: { ...mapping.payload, callback_requested_for: converted.at, callback_timezone: converted.timezone },
      };
    };
    const timeout = new Promise<NormaOutcomeMapping>((resolve) => {
      timer = setTimeout(() => resolve(mapping), timeoutMs);
    });
    return await Promise.race([convert(), timeout]);
  } catch (error) {
    reportError(error, { tags: { surface: "norma_callback_time" } });
    return mapping;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
