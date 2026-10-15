import { groupStepsByRun, MAX_RUNS, type LooseSupabase } from "./queries";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const CHUNK = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** The 24 hours before `beforeIso` (the oldest run already on screen), so days load without gaps or overlap. */
export function previousDayWindow(beforeIso: string): { from: string; to: string } | null {
  const to = Date.parse(beforeIso);
  if (!Number.isFinite(to)) return null;
  return { from: new Date(to - DAY_MS).toISOString(), to: new Date(to).toISOString() };
}
