import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { resolveCallbackTime, type CallbackTimeProvider } from "./callback-time";
import type { NormaCallInput, NormaOutcomeMapping } from "./outcome";

/** The whole conversion (state lookup + parse + optional AI) never delays a completion longer than this. */
export const CALLBACK_CONVERSION_TIMEOUT_MS = 6_000;

function completedAtMs(call: NormaCallInput, nowMs: number): number {
  const record = call as Record<string, unknown>;
  for (const key of ["end_at", "completed_at"]) {
    const value = record[key];
    if (typeof value === "string") {
      const ms = Date.parse(value);
      // A usable completion time is real and not in the future.
      if (Number.isFinite(ms) && ms <= nowMs + 5 * 60_000) return ms;
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
        completedAtMs: completedAtMs(deps.call, nowMs),
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
