import type { SupabaseClient } from "@supabase/supabase-js";

import { checkQuietHours, STATE_TO_TZ } from "@/lib/messaging/quiet-hours";
import type { Database } from "@/lib/supabase/types";

const QUIET_HOURS_CLOSE_HOUR = 21;
const WINDOW_CLOSE_BUFFER_SECONDS = 60;

export type ReplyDelayConfig = {
  delayMinSeconds: number;
  delayMaxSeconds: number;
  escalationKeywords: string[];
  propertyState: string | null;
};

export type ComputeReplyDelayInput = {
  minSeconds: number;
  maxSeconds: number;
  inboundLength: number;
  propertyState?: string | null;
  now?: Date;
  random?: () => number;
};

export function computeReplyDelaySeconds(
  input: ComputeReplyDelayInput,
): number {
  const maxSeconds = Math.max(0, Math.floor(input.maxSeconds));
  if (maxSeconds <= 0) return 0;

  const minSeconds = Math.max(
    0,
    Math.min(Math.floor(input.minSeconds), maxSeconds),
  );
  const range = maxSeconds - minSeconds;
  const randomValue = clamp(input.random ? input.random() : Math.random(), 0, 1);
  const inboundLength = Math.max(0, input.inboundLength);
  const lengthScale = clamp(inboundLength / 160, 0, 1);

  const base = minSeconds + randomValue * range * 0.8;
  const lengthBonus = lengthScale * range * 0.2;
  const rawDelay = Math.round(base + lengthBonus);
  const boundedDelay = clamp(rawDelay, minSeconds, maxSeconds);

  return clampToQuietHoursWindow(boundedDelay, input.propertyState, input.now);
}

export async function loadAiReplyDelayConfig(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<ReplyDelayConfig | null> {
  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .select("org_id, state")
    .eq("id", propertyId)
    .maybeSingle();
  if (propertyError || !property?.org_id) return null;

  const { data: config, error: configError } = await supabase
    .from("ai_responder_configs")
    .select(
      "reply_delay_min_seconds, reply_delay_max_seconds, escalation_keywords",
    )
    .eq("org_id", property.org_id)
    .eq("active", true)
    .maybeSingle();
  if (configError || !config) return null;

  return {
    delayMinSeconds: config.reply_delay_min_seconds,
    delayMaxSeconds: config.reply_delay_max_seconds,
    escalationKeywords: config.escalation_keywords,
    propertyState: property.state,
  };
}

function clampToQuietHoursWindow(
  delaySeconds: number,
  propertyState: string | null | undefined,
  now: Date = new Date(),
): number {
  if (!propertyState) return delaySeconds;

  const quiet = checkQuietHours(propertyState, now);
  if (!quiet.ok) return 0;

  const zone = STATE_TO_TZ[propertyState.trim().toUpperCase()];
  if (!zone) return 0;

  const local = localTimeParts(now, zone);
  const secondsSinceMidnight =
    local.hour * 60 * 60 + local.minute * 60 + local.second;
  const secondsUntilClose =
    QUIET_HOURS_CLOSE_HOUR * 60 * 60 - secondsSinceMidnight;
  const maxDelay = Math.max(
    0,
    Math.floor(secondsUntilClose - WINDOW_CLOSE_BUFFER_SECONDS),
  );

  return Math.min(delaySeconds, maxDelay);
}

function localTimeParts(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(
    parts.find((p) => p.type === "minute")?.value ?? "0",
    10,
  );
  const second = parseInt(
    parts.find((p) => p.type === "second")?.value ?? "0",
    10,
  );

  return {
    hour: Number.isNaN(hour) ? 0 : hour % 24,
    minute: Number.isNaN(minute) ? 0 : minute,
    second: Number.isNaN(second) ? 0 : second,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
