import type { SupabaseClient } from "@supabase/supabase-js";

import {
  checkQuietHours,
  getQuietHoursLocalTime,
  QUIET_HOURS_CLOSE_HOUR,
} from "@/lib/messaging/quiet-hours";
import type { Database } from "@/lib/supabase/types";

const WINDOW_CLOSE_BUFFER_SECONDS = 120;

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
  if (!propertyState) return 0;

  const quiet = checkQuietHours(propertyState, now);
  if (!quiet.ok) return 0;

  const local = getQuietHoursLocalTime(propertyState, now);
  if (!local) return 0;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
