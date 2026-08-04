import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export const OPERATOR_TIME_ZONE = "America/Chicago";

export const OUTBOUND_SENT_OR_DELIVERED_STATUSES = [
  "sent",
  "delivered",
] as const;

export const OUTBOUND_ATTEMPTED_STATUSES = [
  "sent",
  "delivered",
  "failed",
] as const;

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type OperatorDayBounds = {
  timeZone: string;
  startIso: string;
  endIso: string;
};

export type OutboundSmsMetricsScope = {
  campaignId?: string | null;
  orgId?: string | null;
};

export type OutboundSmsMetrics = {
  outboundRows: number;
  queued: number;
  paused: number;
  dueQueued: number;
  pending: number;
  sent: number;
  delivered: number;
  failed: number;
  handedOff: number;
  attempted: number;
  handedOffToday: number;
  failedToday: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
  dayBounds: OperatorDayBounds;
};

function zonedParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} from ${timeZone} date parts.`);
    return Number(value);
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function zonedDateTimeToUtc(parts: DateParts, timeZone: string): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let guess = target;

  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = actualAsUtc - target;
    if (delta === 0) break;
    guess -= delta;
  }

  return new Date(guess);
}

export function getOperatorDayBounds(
  now: Date = new Date(),
  timeZone = OPERATOR_TIME_ZONE,
): OperatorDayBounds {
  const today = zonedParts(now, timeZone);
  const nextDay = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const next = zonedParts(nextDay, "UTC");
  const start = zonedDateTimeToUtc(
    {
      year: today.year,
      month: today.month,
      day: today.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  const end = zonedDateTimeToUtc(
    {
      year: next.year,
      month: next.month,
      day: next.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );

  return {
    timeZone,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export async function getOutboundSmsMetrics(
  supabase: SupabaseClient<Database>,
  opts: {
    scope?: OutboundSmsMetricsScope;
    now?: Date;
    dayBounds?: OperatorDayBounds;
  } = {},
): Promise<OutboundSmsMetrics> {
  const scope = opts.scope ?? {};
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const dayBounds = opts.dayBounds ?? getOperatorDayBounds(now);

  const { data, error } = await supabase.rpc("outbound_sms_metrics", {
    p_campaign_id: scope.campaignId ?? null,
    p_org_id: scope.orgId ?? null,
    p_now: nowIso,
    p_day_start: dayBounds.startIso,
    p_day_end: dayBounds.endIso,
  });
  if (error) throw new Error(`outboundSmsMetrics: ${error.message}`);

  const metrics = data?.[0];
  if (!metrics) throw new Error("outboundSmsMetrics: empty response");

  const sentCount = metrics.sent;
  const deliveredCount = metrics.delivered;
  const failedCount = metrics.failed;
  const failedAfterHandoffCount = metrics.failed_after_handoff;

  return {
    outboundRows: metrics.outbound_rows,
    queued: metrics.queued,
    paused: metrics.paused,
    dueQueued: metrics.due_queued,
    pending: metrics.pending,
    sent: sentCount,
    delivered: deliveredCount,
    failed: failedCount,
    handedOff: sentCount + deliveredCount + failedAfterHandoffCount,
    attempted: sentCount + deliveredCount + failedCount,
    handedOffToday:
      metrics.handed_off_via_sent_at_today +
      metrics.delivered_without_sent_at_today,
    failedToday: metrics.failed_today,
    nextScheduledFor: metrics.next_scheduled_for,
    lastScheduledFor: metrics.last_scheduled_for,
    dayBounds,
  };
}
