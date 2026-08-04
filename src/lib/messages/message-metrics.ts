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

function outboundCountQuery(
  supabase: SupabaseClient<Database>,
  scope: OutboundSmsMetricsScope,
) {
  let query = supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("channel", "sms")
    .eq("direction", "outbound");

  if (scope.campaignId) query = query.eq("campaign_id", scope.campaignId);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);

  return query;
}

function outboundScheduleQuery(
  supabase: SupabaseClient<Database>,
  scope: OutboundSmsMetricsScope,
) {
  let query = supabase
    .from("messages")
    .select("scheduled_for")
    .eq("channel", "sms")
    .eq("direction", "outbound");

  if (scope.campaignId) query = query.eq("campaign_id", scope.campaignId);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);

  return query;
}

function assertCount(
  label: string,
  response: { count: number | null; error: { message: string } | null },
): number {
  if (response.error) {
    throw new Error(`${label}: ${response.error.message}`);
  }
  return response.count ?? 0;
}

function assertSchedule(
  label: string,
  response: {
    data: Array<{ scheduled_for: string | null }> | null;
    error: { message: string } | null;
  },
): string | null {
  if (response.error) {
    throw new Error(`${label}: ${response.error.message}`);
  }
  return response.data?.[0]?.scheduled_for ?? null;
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
  const nowIso = (opts.now ?? new Date()).toISOString();
  const dayBounds = opts.dayBounds ?? getOperatorDayBounds(opts.now);

  const [
    outboundRows,
    queued,
    paused,
    dueQueued,
    pending,
    sent,
    delivered,
    failed,
    failedAfterHandoff,
    handedOffViaSentAtToday,
    deliveredWithoutSentAtToday,
    failedToday,
    nextScheduledFor,
    lastScheduledFor,
  ] = await Promise.all([
    outboundCountQuery(supabase, scope),
    outboundCountQuery(supabase, scope).eq("status", "queued"),
    outboundCountQuery(supabase, scope).eq("status", "paused"),
    outboundCountQuery(supabase, scope)
      .eq("status", "queued")
      .not("scheduled_for", "is", null)
      .lte("scheduled_for", nowIso),
    outboundCountQuery(supabase, scope).eq("status", "pending"),
    outboundCountQuery(supabase, scope).eq("status", "sent"),
    outboundCountQuery(supabase, scope).eq("status", "delivered"),
    outboundCountQuery(supabase, scope).eq("status", "failed"),
    outboundCountQuery(supabase, scope)
      .eq("status", "failed")
      .not("sent_at", "is", null),
    outboundCountQuery(supabase, scope)
      .not("sent_at", "is", null)
      .gte("sent_at", dayBounds.startIso)
      .lt("sent_at", dayBounds.endIso),
    outboundCountQuery(supabase, scope)
      .eq("status", "delivered")
      .is("sent_at", null)
      .not("delivered_at", "is", null)
      .gte("delivered_at", dayBounds.startIso)
      .lt("delivered_at", dayBounds.endIso),
    outboundCountQuery(supabase, scope)
      .eq("status", "failed")
      .not("failed_at", "is", null)
      .gte("failed_at", dayBounds.startIso)
      .lt("failed_at", dayBounds.endIso),
    outboundScheduleQuery(supabase, scope)
      .eq("status", "queued")
      .not("scheduled_for", "is", null)
      .order("scheduled_for", { ascending: true })
      .limit(1),
    outboundScheduleQuery(supabase, scope)
      .eq("status", "queued")
      .not("scheduled_for", "is", null)
      .order("scheduled_for", { ascending: false })
      .limit(1),
  ]);

  const sentCount = assertCount("sent", sent);
  const deliveredCount = assertCount("delivered", delivered);
  const failedCount = assertCount("failed", failed);
  const failedAfterHandoffCount = assertCount(
    "failedAfterHandoff",
    failedAfterHandoff,
  );

  return {
    outboundRows: assertCount("outboundRows", outboundRows),
    queued: assertCount("queued", queued),
    paused: assertCount("paused", paused),
    dueQueued: assertCount("dueQueued", dueQueued),
    pending: assertCount("pending", pending),
    sent: sentCount,
    delivered: deliveredCount,
    failed: failedCount,
    handedOff: sentCount + deliveredCount + failedAfterHandoffCount,
    attempted: sentCount + deliveredCount + failedCount,
    handedOffToday:
      assertCount("handedOffViaSentAtToday", handedOffViaSentAtToday) +
      assertCount("deliveredWithoutSentAtToday", deliveredWithoutSentAtToday),
    failedToday: assertCount("failedToday", failedToday),
    nextScheduledFor: assertSchedule("nextScheduledFor", nextScheduledFor),
    lastScheduledFor: assertSchedule("lastScheduledFor", lastScheduledFor),
    dayBounds,
  };
}
