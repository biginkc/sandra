import { CHICAGO_TZ } from "./chicago-time";
import { fetchAllKeyset } from "./paged";
import { compareInstants, groupStepsByRun, MAX_RUNS, type LooseSupabase } from "./queries";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const CHUNK = 50;

function chunk<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs per step query: a run has ~10-20 steps and a response is capped at 1,000 rows, so keep well under it. */
const STEP_RUNS_PER_QUERY = 25;

/** The two texts shown beside a seller's text: what we last sent them, and the reply Sandra sent (if any). */
export type RunThread = { lastOutbound: string | null; reply: string | null };

const PARALLEL = 10;

/** Runs `task` over `items` with a small fixed concurrency. */
async function inBatches<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(task));
}

/**
 * Display text for each run's thread. `lastOutbound` is the newest outbound
 * message in the run's conversation sent before the seller's text arrived;
 * `reply` is the outbound message the run itself produced. Each run gets its own
 * bounded query (newest outbound before the run, limit 1), so a busy conversation
 * can never crowd another run's text out of a shared row limit. Safe in the
 * browser (RLS scopes every table), like loadRunLabels.
 */
export async function loadRunThreads(
  supabase: LooseSupabase,
  runs: ReadonlyArray<Pick<PipelineRun, "id" | "conversation_id" | "outbound_message_id" | "started_at"> & { inbound_message_id?: string }>,
): Promise<{ threads: Map<string, RunThread>; failedRunIds: string[] }> {
  const replyIds = [...new Set(runs.flatMap((r) => (r.outbound_message_id ? [r.outbound_message_id] : [])))];
  const replyBodies = new Map<string, string>();
  const failedReplyIds = new Set<string>();
  const foundReplyIds = new Set<string>();
  const lastOutbound = new Map<string, string>();
  const failed = new Set<string>();

  // "Our last text" is the last one before the SELLER'S text arrived, not before the run started (an outbound can
  // land in between). Cut-off = the inbound message's created_at; the run start only if that is unavailable.
  const inboundIds = [...new Set(runs.flatMap((r) => (r.inbound_message_id ? [r.inbound_message_id] : [])))];
  const inboundAt = new Map<string, string>();
  for (const ids of chunk(inboundIds)) {
    const res = await fetchAllKeyset<{ id: string; created_at: string }>(() => supabase.from("messages").select("id, created_at").in("id", ids));
    if (res.error) {
      for (const r of runs) if (r.inbound_message_id && ids.includes(r.inbound_message_id)) failed.add(r.id);
      continue;
    }
    for (const m of res.rows) inboundAt.set(m.id, m.created_at);
  }
  // An inbound id with no row is a failed lookup (retried), never a silent fall-back to the run start.
  for (const r of runs) {
    if (r.inbound_message_id && !inboundAt.has(r.inbound_message_id)) failed.add(r.id);
  }

  await Promise.all([
    inBatches(chunk(replyIds), async (ids) => {
      const res = await supabase.from("messages").select("id, body").in("id", ids);
      if (res.error) {
        for (const id of ids) failedReplyIds.add(id);
        return;
      }
      for (const row of (res.data ?? []) as Array<{ id: string; body: string | null }>) {
        foundReplyIds.add(row.id);
        if (row.body) replyBodies.set(row.id, row.body);
      }
    }),
    inBatches(
      runs.filter((r) => r.conversation_id && !failed.has(r.id)),
      async (run) => {
        // The run start is used only when the run has no inbound message id at all.
        const cutoff = run.inbound_message_id ? inboundAt.get(run.inbound_message_id)! : run.started_at;
        const res = await supabase
          .from("messages")
          .select("id, body")
          .eq("conversation_id", run.conversation_id)
          .eq("direction", "outbound")
          .lt("created_at", cutoff)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1);
        if (res.error) {
          failed.add(run.id);
          return;
        }
        const body = ((res.data ?? []) as Array<{ body: string | null }>)[0]?.body;
        if (body) lastOutbound.set(run.id, body);
      },
    ),
  ]);

  const threads = new Map<string, RunThread>();
  for (const run of runs) {
    // A referenced message with no row is a failed lookup (retried), never "no reply": the same rule as the inbound.
    if (run.outbound_message_id && (failedReplyIds.has(run.outbound_message_id) || !foundReplyIds.has(run.outbound_message_id))) failed.add(run.id);
    // A failed run gets no entry: it is retried, never cached as "no text".
    if (failed.has(run.id)) continue;
    threads.set(run.id, {
      lastOutbound: lastOutbound.get(run.id) ?? null,
      reply: run.outbound_message_id ? (replyBodies.get(run.outbound_message_id) ?? null) : null,
    });
  }
  return { threads, failedRunIds: [...failed] };
}

/** Page cursor over (started_at, id) descending: stable when several runs share one timestamp. */
export type RunCursor = { at: string; id: string };

/** A cursor from untrusted input: a strict timestamp and a uuid, so nothing else can reach the filter string. */
export function parseRunCursor(input: unknown): RunCursor | null {
  if (!input || typeof input !== "object") return null;
  const { at, id } = input as { at?: unknown; id?: unknown };
  if (typeof at !== "string" || typeof id !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(at)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { at: at.replace(/\+00:00$/, "Z"), id };
}

/** PostgREST `or` filter for "strictly older than the cursor" in (started_at, id) order. */
export function olderThanCursorFilter(c: RunCursor): string {
  return `started_at.lt."${c.at}",and(started_at.eq."${c.at}",id.lt.${c.id})`;
}

/** Same rule in code, for tests and for sanity checks. */
export function isOlderThanCursor(run: { started_at: string; id: string }, c: RunCursor): boolean {
  const cmp = compareInstants(run.started_at, c.at);
  return cmp < 0 || (cmp === 0 && run.id < c.id);
}

/** Runs that started in [fromIso, toIso), newest first, with their steps. Same shape as the page's feed query. */
export async function loadRunsWindow(
  supabase: LooseSupabase,
  orgId: string,
  fromIso: string,
  toIso: string,
  before?: RunCursor | null,
): Promise<{ runs: RunWithSteps[]; error: string | null }> {
  let query = supabase
    .from("pipeline_runs")
    .select("*")
    .eq("org_id", orgId)
    .gte("started_at", fromIso)
    .lt("started_at", toIso);
  if (before) query = query.or(olderThanCursorFilter(before));
  const res = await query
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_RUNS);
  if (res.error) return { runs: [], error: "The earlier tape could not be loaded." };
  const runs = (res.data ?? []) as PipelineRun[];
  const stepResults = await Promise.all(
    chunk(runs.map((r) => r.id), STEP_RUNS_PER_QUERY).map((ids) =>
      fetchAllKeyset<PipelineRunStep>(() =>
        supabase.from("pipeline_run_steps").select("*").eq("org_id", orgId).in("run_id", ids),
      ),
    ),
  );
  if (stepResults.some((r) => r.error)) return { runs: [], error: "The earlier tape could not be loaded." };
  const steps = groupStepsByRun(stepResults.flatMap((r) => r.rows));
  return { runs: runs.map((run) => ({ ...run, steps: steps.get(run.id) ?? [] })), error: null };
}

export const TAPE_TZ = CHICAGO_TZ;

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

/** One America/Chicago calendar day as an instant range. Null on a malformed day. */
export function chicagoDayWindow(day: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = chicagoDayStartMs(day);
  const end = chicagoDayStartMs(nextDayKey(day));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
