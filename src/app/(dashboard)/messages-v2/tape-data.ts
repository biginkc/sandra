import { groupStepsByRun, MAX_RUNS, type LooseSupabase } from "./queries";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const CHUNK = 50;

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** The two texts shown beside a seller's text: what we last sent them, and the reply Sandra sent (if any). */
export type RunThread = { lastOutbound: string | null; reply: string | null };

/**
 * Display text for each run's thread. `lastOutbound` is the newest outbound
 * message in the run's conversation sent before the seller's text arrived;
 * `reply` is the outbound message the run itself produced. Safe in the browser
 * (RLS scopes every table), like loadRunLabels.
 */
export async function loadRunThreads(
  supabase: LooseSupabase,
  runs: ReadonlyArray<Pick<PipelineRun, "id" | "conversation_id" | "outbound_message_id" | "started_at">>,
): Promise<Map<string, RunThread>> {
  const replyIds = [...new Set(runs.flatMap((r) => (r.outbound_message_id ? [r.outbound_message_id] : [])))];
  const conversationIds = [...new Set(runs.flatMap((r) => (r.conversation_id ? [r.conversation_id] : [])))];

  const replyBodies = new Map<string, string>();
  const outboundByConversation = new Map<string, Array<{ body: string; at: number }>>();

  await Promise.all([
    ...chunk(replyIds).map(async (ids) => {
      const { data } = await supabase.from("messages").select("id, body").in("id", ids);
      for (const row of (data ?? []) as Array<{ id: string; body: string | null }>) {
        if (row.body) replyBodies.set(row.id, row.body);
      }
    }),
    ...chunk(conversationIds).map(async (ids) => {
      const { data } = await supabase
        .from("messages")
        .select("conversation_id, body, created_at")
        .in("conversation_id", ids)
        .eq("direction", "outbound")
        .order("created_at", { ascending: false })
        .limit(1000);
      for (const row of (data ?? []) as Array<{ conversation_id: string; body: string | null; created_at: string }>) {
        if (!row.body) continue;
        const list = outboundByConversation.get(row.conversation_id) ?? [];
        list.push({ body: row.body, at: Date.parse(row.created_at) });
        outboundByConversation.set(row.conversation_id, list);
      }
    }),
  ]);

  const out = new Map<string, RunThread>();
  for (const run of runs) {
    const startedAt = Date.parse(run.started_at);
    const before = run.conversation_id
      ? (outboundByConversation.get(run.conversation_id) ?? []).find((m) => m.at < startedAt)
      : undefined;
    out.set(run.id, {
      lastOutbound: before?.body ?? null,
      reply: run.outbound_message_id ? (replyBodies.get(run.outbound_message_id) ?? null) : null,
    });
  }
  return out;
}

/** Runs that started in [fromIso, toIso), newest first, with their steps. Same shape as the page's feed query. */
export async function loadRunsWindow(
  supabase: LooseSupabase,
  orgId: string,
  fromIso: string,
  toIso: string,
): Promise<{ runs: RunWithSteps[]; error: string | null }> {
  const res = await supabase
    .from("pipeline_runs")
    .select("*")
    .eq("org_id", orgId)
    .gte("started_at", fromIso)
    .lt("started_at", toIso)
    .order("started_at", { ascending: false })
    .limit(MAX_RUNS);
  if (res.error) return { runs: [], error: "The earlier tape could not be loaded." };
  const runs = (res.data ?? []) as PipelineRun[];
  const stepResults = await Promise.all(
    chunk(runs.map((r) => r.id)).map((ids) =>
      supabase
        .from("pipeline_run_steps")
        .select("*")
        .eq("org_id", orgId)
        .in("run_id", ids)
        .order("seq", { ascending: true }),
    ),
  );
  if (stepResults.some((r) => r.error)) return { runs: [], error: "The earlier tape could not be loaded." };
  const steps = groupStepsByRun(stepResults.flatMap((r) => (r.data ?? []) as PipelineRunStep[]));
  return { runs: runs.map((run) => ({ ...run, steps: steps.get(run.id) ?? [] })), error: null };
}

export const TAPE_TZ = "America/Chicago";

/** "2026-10-14": the America/Chicago calendar day an instant falls on. */
export const chicagoDayKey = (ms: number): string => new Date(ms).toLocaleDateString("en-CA", { timeZone: TAPE_TZ });

/** The day before `key` ("2026-10-14" -> "2026-10-13"). */
export function previousDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const nextDayKey = (key: string): string => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Milliseconds the zone is ahead of UTC at an instant (negative for Chicago). Handles DST. */
function zoneOffsetMs(ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TAPE_TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant Chicago local midnight begins on a calendar day ("2026-10-14"). */
export function chicagoDayStartMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(y, m - 1, d);
  // Two passes settle the offset even when the day contains a DST change.
  let guess = localMidnightAsUtc - zoneOffsetMs(localMidnightAsUtc);
  guess = localMidnightAsUtc - zoneOffsetMs(guess);
  return guess;
}

/**
 * One America/Chicago calendar day as an instant range. `before` narrows it to
 * the part of the day older than a cursor, for a day with more runs than one
 * page holds. Null on a malformed day.
 */
export function chicagoDayWindow(day: string, before?: string | null): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = chicagoDayStartMs(day);
  const end = chicagoDayStartMs(nextDayKey(day));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let to = end;
  if (before) {
    const cursor = Date.parse(before);
    if (!Number.isFinite(cursor)) return null;
    to = Math.min(end, Math.max(start, cursor));
  }
  return { from: new Date(start).toISOString(), to: new Date(to).toISOString() };
}
