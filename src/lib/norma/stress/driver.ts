import type { CallKind, FakeCall, LookupBehavior, SendBehavior, WebhookFlavor } from "./fake-bland";
import type { GateMode, Harness, LeadCtx } from "./harness";
import { stubCallbackProvider } from "./harness";
import type { EnrollmentSeed } from "./db";
import { jitter, rng, sleep, type Rng } from "./trace";

/**
 * Seeded randomised lifecycles. A seed fixes the INPUTS (which lead gets which
 * faults and which concurrent events); real database scheduling still varies
 * between runs, which is exactly why the named races in `races.integration.test.ts`
 * are forced with barriers instead of left to luck.
 */
const KINDS: [CallKind, number][] = [
  ["callback", 26],
  ["reached", 14],
  ["not_interested", 12],
  ["wrong_number", 8],
  ["voicemail", 12],
  ["no_answer_status", 12],
  ["unknown_token", 8],
];
const SENDS: [SendBehavior, number][] = [
  ["accept", 52],
  ["accept_timeout", 10],
  ["accept_5xx", 6],
  ["fail_5xx", 8],
  ["reject_4xx", 7],
  ["network_error_no_call", 6],
  ["accept_unparseable", 6],
];
const LOOKUPS: [LookupBehavior, number][] = [
  ["truth", 58],
  ["not_completed", 12],
  ["not_found", 8],
  ["error_500", 5],
  ["mismatch_key", 6],
  ["mismatch_number", 6],
  ["mismatch_call_id", 5],
];
// The database allows one live (active or paused) enrollment per lead.
const ENROLLMENTS: EnrollmentSeed[][] = [
  [],
  ["active"],
  ["active"],
  ["active"],
  ["paused:call_in_progress"],
  ["paused:call_in_progress"],
  ["paused:inbound_reply"],
  ["paused:rep_sms_human_takeover"],
  ["paused:provider_failed"],
];
const HOSTILE: WebhookFlavor[] = [
  "bad_signature",
  "missing_signature",
  "tampered_body",
  "malformed_json",
  "not_object",
  "no_metadata",
  "mismatch_request_id",
  "mismatch_key",
  "mismatch_number",
];

function weighted<T>(r: Rng, table: readonly [T, number][]): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = r.next() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[0]![0];
}

type EventName = "inbound" | "takeover" | "dnc" | "not_interested" | "softphone_pause" | "softphone_cleanup" | "stale_sweep" | "reconcile" | "slack";
const EVENTS: EventName[] = ["inbound", "takeover", "dnc", "not_interested", "softphone_pause", "softphone_cleanup", "stale_sweep", "reconcile", "slack"];

export type LifecycleRecord = { ctx: LeadCtx; late: boolean; summary: string };

/** Wait (bounded) until Bland has placed a call for this lead's number. */
async function awaitCall(h: Harness, ctx: LeadCtx, ms = 3000): Promise<FakeCall | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const call = h.bland.callForNumber(ctx.lead.phone);
    if (call) return call;
    await sleep(2);
  }
  return null;
}

async function runLifecycle(h: Harness, seed: number, index: number): Promise<LifecycleRecord> {
  const r = rng(seed * 100_003 + index * 7919 + 1);
  const kind = weighted(r, KINDS);
  const send = weighted(r, SENDS);
  const placed = !["fail_5xx", "reject_4xx", "network_error_no_call"].includes(send);
  const before = placed && r.chance(0.16) ? r.int(1, 3) : 0;
  const gateRoll = r.next();
  const requestGate: GateMode = gateRoll < 0.04 ? "disabled" : gateRoll < 0.07 ? "not_allowed" : "open";
  const crash = r.chance(0.07);
  const dispatchGate: GateMode = crash && r.chance(0.5) ? "disabled" : requestGate;
  const preExisting = r.next();
  const enrollmentSeed = r.pick(ENROLLMENTS);
  const ctx = await h.lead(
    {
      enrollments: enrollmentSeed,
      dispo: preExisting < 0.03 ? "not_interested" : null,
    },
    {
      kind,
      send,
      lookup: weighted(r, LOOKUPS),
      webhooksBeforeResponse: before,
      followUp: r.pick(["tomorrow at 3pm", "Thursday morning", "call me next week", "after 5pm Central tomorrow", ""]),
    },
    { request: requestGate, dispatch: dispatchGate },
  );
  if (preExisting > 0.97) await h.dnc(ctx, r.pick(["lock", "registry", "contact"] as const), "seed");

  const summary: string[] = [`kind=${kind}`, `send=${send}`, `before=${before}`, `gate=${requestGate}/${dispatchGate}`, crash ? "crash" : ""];
  const late = placed && r.chance(0.1);
  const tasks: Promise<unknown>[] = [];

  // Seller or rep presses "Have Norma call" (possibly several times, from either user).
  const presses = r.pick([1, 1, 1, 1, 1, 2, 2, 3]);
  for (let i = 0; i < presses; i += 1) {
    tasks.push(
      (async () => {
        await jitter(r, 12);
        await h.requestCall(ctx, r.chance(0.5) ? h.world.rep1 : h.world.rep2, { actor: `press-${i}`, crashBeforeDispatch: crash && i === 0 });
      })(),
    );
  }

  // A provider_failed drip gets Retry pressed while the request is in flight (must be refused under the hold).
  if (enrollmentSeed.includes("paused:provider_failed")) {
    const retries = r.int(1, 3);
    for (let i = 0; i < retries; i += 1) {
      tasks.push(
        (async () => {
          await jitter(r, 70);
          await h.retryStep(ctx, `retry-${i}`);
        })().catch((error) => {
          h.trace.add("event:retry", "mark", "failed", { message: (error as Error).message });
        }),
      );
    }
  }

  // Webhook story: hostile noise, repeats, out-of-order progress, or silence.
  const story = weighted<"none" | "once" | "many" | "ooo_before" | "ooo_after">(r, [
    ["none", 14],
    ["once", 36],
    ["many", 22],
    ["ooo_before", 14],
    ["ooo_after", 14],
  ]);
  summary.push(`story=${story}`);
  if (placed && story !== "none" && before === 0) {
    tasks.push(
      (async () => {
        await jitter(r, 40);
        const call = await awaitCall(h, ctx);
        if (!call) return;
        if (story === "ooo_before") await h.bland.webhook(call, "incomplete");
        const times = story === "many" ? r.int(2, 5) : 1;
        await Promise.all(Array.from({ length: times }, async () => (await jitter(r, 5), h.bland.webhook(call, "good"))));
        if (story === "ooo_after") await h.bland.webhook(call, "incomplete");
      })(),
    );
  }
  if (r.chance(0.45)) {
    tasks.push(
      (async () => {
        await jitter(r, 50);
        const call = await awaitCall(h, ctx);
        const target = call ?? null;
        if (!target) return;
        for (const flavor of r.shuffle(HOSTILE).slice(0, r.int(1, 4))) {
          await h.bland.webhook(target, flavor);
          await jitter(r, 3);
        }
        if (r.chance(0.3)) await h.bland.webhook(target, "unmapped_token");
        // A wrong call id can only be detected once the real one is bound.
        const row = (await h.scratch.pool.query("select bland_call_id from public.norma_call_requests where property_id = $1 limit 1", [ctx.lead.property])).rows[0];
        if (row?.bland_call_id) await h.bland.webhook(target, "mismatch_call_id");
      })(),
    );
  }

  // Concurrent world events.
  const eventNames = r.shuffle(EVENTS).slice(0, r.int(0, 4));
  summary.push(...eventNames);
  for (const name of eventNames) {
    tasks.push(
      (async () => {
        await jitter(r, 60);
        switch (name) {
          case "inbound":
            return h.inboundReply(ctx);
          case "takeover":
            return h.takeover(ctx);
          case "dnc":
            return h.dnc(ctx, r.pick(["lock", "registry", "contact"] as const));
          case "not_interested":
            return h.notInterested(ctx);
          case "softphone_pause":
            return h.softphonePause(ctx);
          case "softphone_cleanup":
            return h.softphoneCleanup(ctx);
          case "stale_sweep":
            return h.staleSweep();
          case "reconcile":
            return h.reconcile({ actor: "reconcile-mid" });
          case "slack":
            return h.slackDrain();
        }
      })().catch((error) => {
        // An event that fails is data, not a crash; the invariants decide if it mattered.
        h.trace.add(`event:${name}`, "mark", "failed", { message: (error as Error).message });
      }),
    );
  }
  h.slack.failNext.set(ctx.lead.property, r.chance(0.2) ? r.int(1, 3) : 0);

  await Promise.all(tasks);
  return { ctx, late, summary: summary.filter(Boolean).join(" ") };
}

export type RunResult = { records: LifecycleRecord[]; lifecycles: number };

/**
 * Runs `count` lifecycles in overlapping batches with background workers
 * (reconcile, stale sweep, Slack, and occasional virtual-clock jumps), then the
 * recovery phase on the virtual clock, then late webhook deliveries after
 * needs_review, then recovery again.
 */
export async function runRandomRun(h: Harness, seed: number, count: number, opts: { concurrency?: number } = {}): Promise<RunResult> {
  const r = rng(seed);
  h.provider = stubCallbackProvider(rng(seed + 17));
  h.slack.failProbability = 0.25;
  const concurrency = opts.concurrency ?? 12;
  const records: LifecycleRecord[] = [];

  for (let start = 0; start < count; start += concurrency) {
    const size = Math.min(concurrency, count - start);
    let running = true;
    const worker = (async () => {
      while (running) {
        await jitter(r, 25);
        const roll = r.next();
        try {
          if (roll < 0.3) await h.reconcile({ actor: "reconcile-bg" });
          else if (roll < 0.5) await h.slackDrain();
          else if (roll < 0.65) await h.staleSweep();
          else if (roll < 0.75) await h.advance(r.int(60, 480) * 1000);
        } catch (error) {
          h.trace.add("worker", "mark", "failed", { message: (error as Error).message });
        }
      }
    })();
    const batch = await Promise.all(Array.from({ length: size }, (_, i) => runLifecycle(h, seed, start + i)));
    running = false;
    await worker;
    records.push(...batch);
  }

  // Recovery on the virtual clock: first small steps so stranded `requested`
  // rows are dispatched by the sweep before they expire, then 5-minute steps.
  for (const ms of [90_000, 90_000]) {
    await h.advance(ms);
    await h.reconcile();
    await h.staleSweep();
  }
  await h.recover({ horizonMs: 3 * 3600_000 });

  // Late webhooks: Bland finally delivers after the request was parked for review.
  for (const rec of records.filter((x) => x.late)) {
    const call = h.bland.callForNumber(rec.ctx.lead.phone);
    if (!call) continue;
    const status = (await h.scratch.pool.query("select status from public.norma_call_requests where property_id = $1", [rec.ctx.lead.property])).rows[0]?.status;
    if (status === "needs_review" || status === "completed") {
      await h.bland.webhook(call, "good");
      if (r.chance(0.5)) await h.bland.webhook(call, "good");
    }
  }
  await h.recover({ horizonMs: 3 * 3600_000 });

  // Slack drains on its own backoff (up to hours); give it room.
  for (let i = 0; i < 40; i += 1) {
    const pending = (await h.scratch.pool.query("select count(*)::int as n from public.norma_notifications where status = 'pending'")).rows[0].n;
    if (pending === 0) break;
    await h.advance(3600_000);
    await h.slackDrain();
  }
  return { records, lifecycles: records.length };
}
