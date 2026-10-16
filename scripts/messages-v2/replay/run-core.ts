import {
  applyStubEnv,
  assertHandshake,
  assertHarnessEnv,
  assertLocalBaseUrl,
  assertSafeDbUrl,
  assertSafeSupabaseUrl,
  type EnvLike,
} from "./safety";
import type { Query, ReplayExport, ReplayInbound } from "./schema";

export type RunOptions = {
  baseUrl: string;
  supabaseUrl: string;
  dbUrl: string;
  allowProjectRef?: string | null;
  prodRefs: readonly string[];
  webhookSecret: string;
  /** 1 = original pacing, 10 = ten times faster. Ignored when burst. */
  speed: number;
  burst: boolean;
  /** Cap any single idle gap (seconds, after speed is applied); 0 = no cap. */
  maxGapSeconds: number;
  limit: number | null;
  /** Only replay inbound received at/after this ISO time. */
  since: string | null;
  /** Give up waiting for one inbound's run after this long. */
  runTimeoutMs: number;
  pollMs: number;
};

export type Deps = {
  env: EnvLike;
  fetch: typeof fetch;
  query: Query;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
};

/** Pure checks (no I/O): call before opening any connection. */
export function assertStaticSafety(opts: RunOptions, env: EnvLike): { supabaseHost: string } {
  applyStubEnv(env);
  assertHarnessEnv(env);
  assertLocalBaseUrl(opts.baseUrl);
  const target = assertSafeSupabaseUrl(opts.supabaseUrl, { prodRefs: opts.prodRefs, allowProjectRef: opts.allowProjectRef });
  assertSafeDbUrl(opts.dbUrl, { prodRefs: opts.prodRefs, allowProjectRef: opts.allowProjectRef });
  return { supabaseHost: target.host };
}

/** Everything that must hold BEFORE the first byte is sent or written. */
export async function preflight(exp: ReplayExport, opts: RunOptions, deps: Deps): Promise<{ orgId: string }> {
  const target = { host: assertStaticSafety(opts, deps.env).supabaseHost };

  const res = await deps.fetch(new URL("/api/webhooks/replay/handshake", opts.baseUrl), {
    method: "GET",
    redirect: "error",
    cache: "no-store",
  });
  let body: unknown = null;
  if (res.ok) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  assertHandshake(body, { supabaseHost: target.host });

  const { rows } = await deps.query("select org_id from public.replay_batches where id = $1", [exp.batchId]);
  if (rows.length === 0) throw new Error(`batch "${exp.batchId}" is not seeded in this database; run replay:seed first`);
  return { orgId: String(rows[0].org_id) };
}

export function sendilloPayload(item: ReplayInbound, externalId: string): string {
  return JSON.stringify({
    event: "inbound.received",
    data: { messageId: externalId, from: item.from, to: item.to, body: item.body, receivedAt: item.receivedAt },
  });
}

export function gapMs(prevIso: string | null, curIso: string, opts: Pick<RunOptions, "speed" | "burst" | "maxGapSeconds">): number {
  if (opts.burst || !prevIso) return 0;
  const raw = Math.max(0, Date.parse(curIso) - Date.parse(prevIso)) / Math.max(opts.speed, 0.0001);
  const cap = opts.maxGapSeconds > 0 ? opts.maxGapSeconds * 1000 : Infinity;
  return Math.min(raw, cap);
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

type StepRow = { seq: number; kind: string; name: string; result: string; detail: Record<string, unknown> | null; created_at: string | Date };

export type InboundResult = {
  index: number;
  inboundId: string;
  externalId: string;
  httpStatus: number | null;
  runStatus: string | null;
  finalOutcome: string | null;
  jevOutcome: string | null;
  confidence: number | null;
  gate: string;
  disposition: "auto" | "held" | "escalated" | "closed" | "skipped" | "error" | "running" | "post_failed" | "no_run" | "timeout";
  wallMs: number;
  stepLatencies: Array<{ step: string; ms: number }>;
  original: { status: string | null; finalOutcome: string | null } | null;
};

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const t = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));

export function describeRun(
  run: { status: string; final_outcome: string | null; started_at: string | Date } | null,
  steps: readonly StepRow[],
): Pick<InboundResult, "runStatus" | "finalOutcome" | "jevOutcome" | "confidence" | "gate" | "disposition" | "stepLatencies"> {
  const jev = steps.find((s) => s.kind === "jev" && s.name === "classify");
  const blocked = steps.find((s) => s.kind === "gate" && s.result === "block");
  const held = steps.find((s) => s.kind === "hold");
  const rule = blocked?.detail && blocked.detail.rule !== undefined ? `#${String(blocked.detail.rule)}` : "";
  const gate = blocked ? `${blocked.name}${rule}` : held ? `hold:${held.name}` : "pass";

  const status = run?.status ?? null;
  const disposition: InboundResult["disposition"] =
    status === null
      ? "no_run"
      : status === "replied"
        ? "auto"
        : status === "held"
          ? "held"
          : (["escalated", "closed", "skipped", "error", "running"] as const).includes(status as never)
            ? (status as InboundResult["disposition"])
            : "skipped";

  const stepLatencies: Array<{ step: string; ms: number }> = [];
  let prev = run ? t(run.started_at) : null;
  for (const s of steps) {
    const at = t(s.created_at);
    if (prev !== null && Number.isFinite(at)) stepLatencies.push({ step: `${s.kind}:${s.name}`, ms: Math.max(0, at - prev) });
    prev = Number.isFinite(at) ? at : prev;
  }
  return {
    runStatus: status,
    finalOutcome: run?.final_outcome ?? null,
    jevOutcome: typeof jev?.detail?.outcome === "string" ? (jev.detail.outcome as string) : null,
    confidence: asNum(jev?.detail?.nativeConfidence),
    gate,
    disposition,
    stepLatencies,
  };
}

export function formatProgress(i: number, total: number, r: InboundResult): string {
  const conf = r.confidence === null ? "-" : r.confidence.toFixed(2);
  const orig = r.original ? ` orig=${r.original.finalOutcome ?? r.original.status ?? "-"}` : "";
  return `[${String(i).padStart(String(total).length, "0")}/${total}] msg=${r.inboundId.slice(0, 8)} jev=${r.jevOutcome ?? "-"} conf=${conf} gate=${r.gate} disp=${r.disposition} outcome=${r.finalOutcome ?? "-"} ms=${r.wallMs}${orig}`;
}

export type Summary = {
  batchId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  perOutcome: Record<string, number>;
  perJevOutcome: Record<string, number>;
  perDisposition: Record<string, number>;
  auto: number;
  held: number;
  gateRuleHits: Record<string, number>;
  latencyMsPerStep: Record<string, { n: number; p50: number | null; p95: number | null }>;
  wallMs: { p50: number | null; p95: number | null };
  deadLetters: Array<Record<string, unknown>>;
  wouldHaveSent: number;
  agreement: { compared: number; sameFinalOutcome: number };
  failures: Array<{ inboundId: string; reason: string }>;
};

export function summarize(
  results: readonly InboundResult[],
  meta: { batchId: string; runId: string; startedAt: string; finishedAt: string; deadLetters: Array<Record<string, unknown>>; wouldHaveSent: number },
): Summary {
  const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const perOutcome: Record<string, number> = {};
  const perJev: Record<string, number> = {};
  const perDisp: Record<string, number> = {};
  const gates: Record<string, number> = {};
  const stepMs: Record<string, number[]> = {};
  const wall: number[] = [];
  let compared = 0;
  let same = 0;
  const failures: Summary["failures"] = [];
  for (const r of results) {
    inc(perOutcome, r.finalOutcome ?? r.runStatus ?? r.disposition);
    inc(perJev, r.jevOutcome ?? "none");
    inc(perDisp, r.disposition);
    if (r.gate !== "pass") inc(gates, r.gate);
    for (const s of r.stepLatencies) (stepMs[s.step] ??= []).push(s.ms);
    if (["auto", "held", "escalated", "closed", "skipped"].includes(r.disposition)) wall.push(r.wallMs);
    if (r.original) {
      compared += 1;
      if ((r.original.finalOutcome ?? r.original.status) === (r.finalOutcome ?? r.runStatus)) same += 1;
    }
    if (["post_failed", "no_run", "timeout", "error"].includes(r.disposition)) {
      failures.push({ inboundId: r.inboundId, reason: r.disposition });
    }
  }
  const latency: Summary["latencyMsPerStep"] = {};
  for (const [step, ms] of Object.entries(stepMs)) {
    const sorted = [...ms].sort((a, b) => a - b);
    latency[step] = { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
  }
  const wallSorted = [...wall].sort((a, b) => a - b);
  return {
    ...meta,
    total: results.length,
    perOutcome,
    perJevOutcome: perJev,
    perDisposition: perDisp,
    auto: perDisp.auto ?? 0,
    held: perDisp.held ?? 0,
    gateRuleHits: gates,
    latencyMsPerStep: latency,
    wallMs: { p50: percentile(wallSorted, 50), p95: percentile(wallSorted, 95) },
    agreement: { compared, sameFinalOutcome: same },
    failures,
  };
}

/** Replay every selected inbound in original order; one progress line each. */
export async function runReplay(
  exp: ReplayExport,
  opts: RunOptions,
  deps: Deps,
  runId: string,
): Promise<{ results: InboundResult[]; summary: Summary }> {
  const { orgId } = await preflight(exp, opts, deps);

  let items = exp.inbound.filter((i) => !opts.since || Date.parse(i.receivedAt) >= Date.parse(opts.since));
  if (opts.limit !== null) items = items.slice(0, opts.limit);
  const originalByInbound = new Map<string, { status: string | null; finalOutcome: string | null }>();
  for (const r of exp.reference.pipelineRuns) {
    originalByInbound.set(String(r.inbound_message_id), {
      status: (r.status as string) ?? null,
      finalOutcome: (r.final_outcome as string) ?? null,
    });
  }

  const startedAt = new Date(deps.now()).toISOString();
  const results: InboundResult[] = [];
  const pending: Array<Promise<void>> = [];
  let prev: string | null = null;
  let done = 0;

  const finishOne = async (index: number, item: ReplayInbound, externalId: string, httpStatus: number | null, postedAt: number) => {
    const base = {
      index,
      inboundId: item.id,
      externalId,
      httpStatus,
      original: originalByInbound.get(item.id) ?? null,
    };
    let result: InboundResult;
    if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
      result = { ...base, runStatus: null, finalOutcome: null, jevOutcome: null, confidence: null, gate: "-", disposition: "post_failed", wallMs: deps.now() - postedAt, stepLatencies: [] };
    } else {
      result = await awaitRun(base, orgId, externalId, postedAt, opts, deps);
    }
    results.push(result);
    done += 1;
    deps.log(formatProgress(done, items.length, result));
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const wait = gapMs(prev, item.receivedAt, opts);
    if (wait > 0) await deps.sleep(wait);
    prev = item.receivedAt;
    const externalId = `replay-${exp.batchId}-${runId}-${item.externalId}`;
    const postedAt = deps.now();
    let status: number | null = null;
    try {
      const res = await deps.fetch(new URL("/api/webhooks/sendillo/sms", opts.baseUrl), {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-sendillo-webhook-secret": opts.webhookSecret },
        body: sendilloPayload(item, externalId),
      });
      status = res.status;
    } catch {
      status = null;
    }
    pending.push(finishOne(index, item, externalId, status, postedAt));
    // Original-order delivery; completion is observed concurrently so a slow run does not stall pacing.
    // In real-pacing mode wait for each run so the progress feed mirrors production one-by-one.
    if (!opts.burst && opts.speed <= 1) await pending[pending.length - 1];
  }
  await Promise.all(pending);
  results.sort((a, b) => a.index - b.index);

  const { rows: dead } = await deps.query(
    `select id, run_id, inbound_message_id, reason, created_at from public.ai_reply_dead_letters
      where org_id = $1 and created_at >= $2 order by created_at`,
    [orgId, startedAt],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const { rows: sent } = await deps.query(
    `select count(*)::int as n from public.replay_outbound_log where batch_id = $1 and created_at >= $2`,
    [exp.batchId, startedAt],
  ).catch(() => ({ rows: [{ n: 0 }] as Record<string, unknown>[] }));

  const summary = summarize(results, {
    batchId: exp.batchId,
    runId,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
    deadLetters: dead,
    wouldHaveSent: Number(sent[0]?.n ?? 0),
  });
  return { results, summary };
}

async function awaitRun(
  base: Pick<InboundResult, "index" | "inboundId" | "externalId" | "httpStatus" | "original">,
  orgId: string,
  externalId: string,
  postedAt: number,
  opts: RunOptions,
  deps: Deps,
): Promise<InboundResult> {
  const deadline = postedAt + opts.runTimeoutMs;
  type RunRow = { id: string; status: string; final_outcome: string | null; started_at: string | Date };
  let run = null as RunRow | null;
  for (;;) {
    const { rows } = await deps.query(
      `select r.id, r.status, r.final_outcome, r.started_at
         from public.messages m join public.pipeline_runs r on r.inbound_message_id = m.id
        where m.org_id = $1 and m.external_id = $2 and m.direction = 'inbound' limit 1`,
      [orgId, externalId],
    );
    run = (rows[0] as unknown as RunRow | undefined) ?? null;
    if (run && run.status !== "running") break;
    if (deps.now() >= deadline) break;
    await deps.sleep(opts.pollMs);
  }
  if (!run) {
    return { ...base, runStatus: null, finalOutcome: null, jevOutcome: null, confidence: null, gate: "-", disposition: "no_run", wallMs: deps.now() - postedAt, stepLatencies: [] };
  }
  const { rows: steps } = await deps.query(
    `select seq, kind, name, result, detail, created_at from public.pipeline_run_steps where run_id = $1 order by seq`,
    [run.id],
  );
  const described = describeRun(run, steps as unknown as StepRow[]);
  const disposition = run.status === "running" ? "timeout" : described.disposition;
  return { ...base, ...described, disposition, wallMs: deps.now() - postedAt };
}
