import { randomUUID } from "node:crypto";

import { dialpadEventPayload, postDialpadEvent, signDialpadWebhook } from "../support/my-leads-close-fixture";
import { quickPickDueAt } from "../../src/lib/my-leads/quick-picks";
import type { FaultName, StressConfig } from "./config";
import { asRep, asService, errCode, type Db } from "./db";
import type { StubServer } from "./stubs";
import type { QuickPickName } from "./manifest";
import type { World, WorldLead } from "./world";
import { CI_DIALPAD_USER_ID } from "./world";

/**
 * Building blocks the replay engine uses to model what the app's server actions do, one RPC at a
 * time, plus the signed-webhook and cron HTTP calls that hit the REAL app under test.
 * Server actions need a browser session, so the replay engine calls the same database functions the
 * actions call (service role for the dial gate, the rep's JWT claim for the prompt/next-step writes).
 */

/** The per-tick watchdog. The harness pacing itself against the app's dial guards is not the tick running slow: `reset()` restarts the countdown once the dial window opens. */
export class TickDeadline {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ms: number, private readonly onTimeout: () => void) {
    this.reset();
  }
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.onTimeout, this.ms);
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export type Ctx = {
  tickDeadline?: TickDeadline;
  cfg: StressConfig;
  db: Db;
  world: World;
  stub: StubServer;
  faults: FaultState;
  sleep: (ms: number) => Promise<void>;
};

/** A fault fires exactly once per run (the first matching opportunity); the self-test needs one injected defect, not a storm. */
export class FaultState {
  private used = new Set<FaultName>();
  constructor(readonly name: FaultName) {}
  take(f: FaultName): boolean {
    if (this.name !== f || this.used.has(f)) return false;
    this.used.add(f);
    return true;
  }
  get fired(): boolean {
    return this.used.size > 0;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function callIdFor(cfg: StressConfig, tick: number, n = 1): string {
  // Digits only (the verifier keeps int64 ids intact), deterministic per (seed, tick, n).
  return `8${String(cfg.seed % 1e10).padStart(10, "0")}${String(tick).padStart(3, "0")}${n}`;
}

// ---------------------------------------------------------------------------------------------
// Dial gate (intent -> authorize -> provider dispatch)

export type Intent = { intentId: string; customData: string; key: string };

export async function prepareIntent(ctx: Ctx, lead: WorldLead, key: string = randomUUID()): Promise<Intent> {
  const r = await asService(ctx.db, (c) =>
    c.query<{ v: { intentId: string; customData: string } }>(
      "select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v",
      [ctx.cfg.orgId, ctx.world.repUserId, lead.propertyId, lead.contactId, key],
    ),
  );
  const v = r.rows[0]!.v;
  return { intentId: v.intentId, customData: String(v.customData), key };
}

/** The TypeScript-layer guards `startDialpadCall` runs BEFORE it prepares an intent (api-dial.ts / dispatch.ts). They are not atomic by design ("accepted race"). */
export type GuardRefusal = "rate_limited" | "call_in_flight" | "prior_call_unresolved";
const DIAL_RATE_LIMIT_PER_MINUTE = 4;
const IN_FLIGHT_WINDOW_SECONDS = 20;

export async function dialGuards(ctx: Ctx, lead: WorldLead): Promise<GuardRefusal | null> {
  const r = await ctx.db.query<{ last_minute: number; unmatched_20s: number; unresolved_on_lead: number }>(
    `select
       (select count(*)::int from public.dialpad_call_intents where org_id=$1 and rep_user_id=$2 and dispatch_authorized_at is not null and dispatch_authorized_at >= now() - interval '60 seconds') as last_minute,
       (select count(*)::int from public.dialpad_call_intents where org_id=$1 and rep_user_id=$2 and status='prepared' and matched_at is null and dispatch_authorized_at is not null and dispatch_authorized_at >= now() - make_interval(secs => ${IN_FLIGHT_WINDOW_SECONDS})) as unmatched_20s,
       (select count(*)::int from public.dialpad_call_intents where org_id=$1 and rep_user_id=$2 and property_id=$3 and status='prepared' and matched_at is null and dispatch_authorized_at is not null and expires_at > now()) as unresolved_on_lead`,
    [ctx.cfg.orgId, ctx.world.repUserId, lead.propertyId],
  );
  const g = r.rows[0]!;
  if (g.last_minute >= DIAL_RATE_LIMIT_PER_MINUTE) return "rate_limited";
  if (g.unmatched_20s > 0) return "call_in_flight";
  if (g.unresolved_on_lead > 0) return "prior_call_unresolved";
  return null;
}

/** Waits (real time, no clock tricks) until the app's own guards would let a dial through. The harness paces itself like a rep. */
export async function awaitDialWindow(ctx: Ctx, lead: WorldLead, maxMs = 150_000): Promise<void> {
  const until = Date.now() + maxMs;
  ctx.tickDeadline?.clear(); // pacing against the app's guards is not the tick running slow; the countdown restarts when the window opens
  for (;;) {
    const g = await dialGuards(ctx, lead);
    if (!g) {
      ctx.tickDeadline?.reset();
      return;
    }
    if (g === "prior_call_unresolved") throw new Error("prior_call_unresolved: an earlier dial for this lead is still unresolved");
    if (Date.now() > until) throw new Error(`dial window did not open within ${maxMs}ms (${g})`);
    await sleep(g === "rate_limited" ? 2000 : 500);
  }
}

export type StartDial = { refused: GuardRefusal | null; intent: Intent | null; dispatch: DispatchResult | null };

/** What the Call button does end to end: guards, then intent, then authorize + provider. `wait` paces; otherwise a refusal is returned. */
export async function startDial(ctx: Ctx, lead: WorldLead, opts: { key?: string; wait?: boolean; abortAfterMs?: number } = {}): Promise<StartDial> {
  if (opts.wait !== false) await awaitDialWindow(ctx, lead);
  else {
    const g = await dialGuards(ctx, lead);
    if (g) return { refused: g, intent: null, dispatch: null };
  }
  const intent = await prepareIntent(ctx, lead, opts.key ?? randomUUID());
  const dispatch = await dispatchCall(ctx, lead, intent, { abortAfterMs: opts.abortAfterMs });
  return { refused: null, intent, dispatch };
}

export type DispatchResult = { status: string; dialed: boolean; denial?: string };

/** What the dial server action does: authorize (the only function that releases the payload), then post to the provider ONLY if authorized. */
export async function dispatchCall(ctx: Ctx, lead: WorldLead, intent: Intent, opts: { abortAfterMs?: number; noProvider?: boolean } = {}): Promise<DispatchResult> {
  const auth = await asService(ctx.db, (c) =>
    c.query<{ v: { status: string; denial?: string; dial?: { phoneNumber: string; customData: string; dialpadUserId: string } } }>(
      "select public.fn_authorize_dialpad_dispatch($1,$2,$3) as v",
      [ctx.cfg.orgId, ctx.world.repUserId, intent.intentId],
    ),
  );
  const v = auth.rows[0]!.v;
  if (v.status !== "authorized" || !v.dial) return { status: v.status, dialed: false, denial: v.denial };
  // Lever demonstrations authorize but never post to the provider stub, so they add no dial to the run's totals.
  if (opts.noProvider) return { status: "authorized", dialed: false };
  const post = async (signal?: AbortSignal) =>
    fetch(`${ctx.stub.url}/dialpad/api/v2/users/${v.dial!.dialpadUserId ?? CI_DIALPAD_USER_ID}/initiate_call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number: v.dial!.phoneNumber, custom_data: v.dial!.customData }),
      signal,
    });
  if (opts.abortAfterMs !== undefined) {
    const ac = new AbortController();
    const p = post(ac.signal).catch(() => null);
    await sleep(opts.abortAfterMs);
    ac.abort();
    await p;
  } else {
    await post();
  }
  if (ctx.faults.take("duplicate_send")) await post(); // injected defect: the same intent dialled twice
  return { status: "authorized", dialed: true };
}

// ---------------------------------------------------------------------------------------------
// Signed Dialpad webhooks (HTTP to the real app)

export type CallState = "calling" | "connected" | "hangup";

export async function postCallEvent(
  ctx: Ctx,
  lead: WorldLead,
  input: { callId: string; state: CallState; at: number; startedAt: number; customData?: string; shareLink?: string; direction?: "outbound" | "inbound" },
): Promise<{ status: number; body: string }> {
  const payload = dialpadEventPayload({
    callId: input.callId,
    state: input.state,
    at: input.at,
    customData: input.customData,
    externalNumber: lead.phoneE164,
    targetUserId: CI_DIALPAD_USER_ID,
    dateStarted: input.startedAt,
    dateConnected: input.startedAt + 1000,
    direction: input.direction,
    shareLink: input.state === "hangup" ? input.shareLink : undefined,
  });
  const r = await postDialpadEvent(ctx.cfg.appUrl, ctx.world.connectionId, signDialpadWebhook(payload, ctx.cfg.webhookSecret));
  return { status: r.status, body: await r.text().catch(() => "") };
}

/** Sends the three states in `order`, each repeated `dupes` times (concurrently), with `delayMs` between states. */
export async function sendCallEvents(
  ctx: Ctx,
  lead: WorldLead,
  input: { callId: string; customData?: string; order?: readonly CallState[]; dupes?: number; delayMs?: number; durationMs?: number; direction?: "outbound" | "inbound" },
): Promise<string[]> {
  const order = input.order ?? ["calling", "connected", "hangup"];
  const startedAt = Date.now() - 3000;
  const dur = input.durationMs ?? 3000;
  const at: Record<CallState, number> = { calling: startedAt, connected: startedAt + 1000, hangup: startedAt + 1000 + Math.min(dur, 2500) };
  const results: string[] = [];
  for (const state of order) {
    const copies = Math.max(1, input.dupes ?? 1);
    const rs = await Promise.all(
      Array.from({ length: copies }, () =>
        postCallEvent(ctx, lead, { callId: input.callId, state, at: at[state], startedAt, customData: input.customData, direction: input.direction, shareLink: `https://dialpad.com/callreview/stress-${input.callId}` }),
      ),
    );
    for (const r of rs) {
      if (r.status !== 200) throw new Error(`webhook ${state} -> ${r.status} ${r.body.slice(0, 120)}`);
      results.push(`${state}:${(JSON.parse(r.body) as { disposition?: string }).disposition ?? "?"}`);
    }
    if (input.delayMs) await sleep(input.delayMs);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Prompt save: outcome + note + next step (what the post-call prompt does)

export async function pendingCallActivity(ctx: Ctx, lead: WorldLead): Promise<string | null> {
  const r = await ctx.db.query<{ call_activity_id: string }>(
    "select call_activity_id from public.acquisition_attempts where property_id=$1 and source='dialpad' and call_activity_id is not null order by created_at desc limit 1",
    [lead.propertyId],
  );
  return r.rows[0]?.call_activity_id ?? null;
}

export async function finalizeAttempt(
  ctx: Ctx,
  lead: WorldLead,
  input: { callActivityId: string; key: string; occurredAt: string; outcome: string; note?: string },
): Promise<{ ok: boolean; code?: string; duplicate?: boolean }> {
  try {
    const r = await asRep(ctx.db, ctx.world.repUserId, (c) =>
      c.query<{ v: { duplicate?: boolean; attemptId?: string } }>("select public.fn_finalize_acquisition_attempt($1::jsonb) as v", [
        JSON.stringify({ orgId: ctx.cfg.orgId, propertyId: lead.propertyId, callActivityId: input.callActivityId, idempotencyKey: input.key, outcome: input.outcome, occurredAt: input.occurredAt, note: input.note, recordingUrl: `https://dialpad.com/callreview/stress-${lead.slot}` }),
      ]),
    );
    // The prompt acknowledges the call prompt once the attempt is saved; without it the rep's queue keeps every old prompt.
    const attemptId = r.rows[0]!.v.attemptId;
    if (attemptId) await asRep(ctx.db, ctx.world.repUserId, (c) => c.query("select public.fn_acknowledge_call_prompt($1,$2,'saved')", [ctx.cfg.orgId, attemptId])).catch(() => {});
    return { ok: true, duplicate: r.rows[0]!.v.duplicate };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

export async function addNote(ctx: Ctx, propertyId: string, body: string, key: string = randomUUID()): Promise<{ ok: boolean; code?: string }> {
  try {
    await asRep(ctx.db, ctx.world.repUserId, (c) =>
      c.query("insert into public.lead_notes(org_id,property_id,author_user_id,body,idempotency_key) values ($1,$2,$3,$4,$5)", [ctx.cfg.orgId, propertyId, ctx.world.repUserId, body, key]),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

export type NextStep = { ok: boolean; code?: string; taskId?: string; duplicate?: boolean; dueAt?: string };

export async function createAppointment(ctx: Ctx, lead: WorldLead, input: { title: string; pick: QuickPickName; now: Date; key?: string; leadNextActionKey?: string | null }): Promise<NextStep> {
  const due = quickPickDueAt(input.pick, input.now);
  try {
    const r = await asRep(ctx.db, ctx.world.repUserId, (c) =>
      c.query<{ v: { task_id: string; duplicate: boolean } }>(
        "select public.fn_create_next_step($1,$2,$3,'appointment',$4,$5,$6,$7,'phone',null,null,null,null,$8,$9,'app',true,false) as v",
        [ctx.cfg.orgId, ctx.world.repUserId, ctx.world.repUserId, input.title, due.toISOString(), lead.propertyId, lead.contactId, input.key ?? randomUUID(), input.leadNextActionKey ?? null],
      ),
    );
    return { ok: true, taskId: r.rows[0]!.v.task_id, duplicate: r.rows[0]!.v.duplicate, dueAt: due.toISOString() };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

export async function rescheduleAppointment(ctx: Ctx, taskId: string, pick: QuickPickName, now: Date, key: string = randomUUID()): Promise<NextStep> {
  const start = quickPickDueAt(pick, now);
  const end = new Date(start.getTime() + 15 * 60_000);
  try {
    await asRep(ctx.db, ctx.world.repUserId, (c) =>
      c.query("select public.fn_reschedule_appointment($1,$2,$3,'America/Chicago',$4)", [taskId, start.toISOString(), end.toISOString(), key]),
    );
    return { ok: true, taskId, dueAt: start.toISOString() };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

/** A reschedule replaces the task row (same chain). A tab holding the old task id is stale; a refreshed tab reads the chain's current open task. */
export async function currentOpenTaskInChain(ctx: Ctx, taskId: string): Promise<string | null> {
  const r = await ctx.db.query<{ id: string }>(
    "select t.id from public.tasks t where t.calendar_chain_id=(select calendar_chain_id from public.tasks where id=$1) and t.status in ('open','snoozed') order by t.created_at desc limit 1",
    [taskId],
  );
  return r.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Cron routes (HTTP to the real app)

export const CRON_ROUTES = [
  "dialpad-call-events-sweep",
  "dialpad-artifact-sweep",
  "seller-appointment-reminders",
  "offer-projection-sweep",
  "appointment-reminder-sweep",
  "calendar-mutation-sweep",
] as const;
export type CronRoute = (typeof CRON_ROUTES)[number];

export async function runCron(ctx: Ctx, route: string): Promise<{ route: string; status: number; body: string }> {
  const r = await fetch(`${ctx.cfg.cronBase}/api/cron/${route}`, { headers: { authorization: `Bearer ${ctx.cfg.cronSecret}` } });
  return { route, status: r.status, body: (await r.text().catch(() => "")).slice(0, 400) };
}

// ---------------------------------------------------------------------------------------------
// Seller history (the reminder text is an "opening" SMS unless the seller already has a thread)

export async function seedSellerReplyHistory(ctx: Ctx, lead: WorldLead): Promise<void> {
  await ctx.db.query(
    "insert into public.messages(org_id,channel,direction,property_id,contact_id,provider,from_address,to_address,body,status,sent_at) values ($1,'sms','inbound',$2,$3,'mock',$4,'+15551234567',$5,'received',now())",
    [ctx.cfg.orgId, lead.propertyId, lead.contactId, lead.phoneE164, `${ctx.cfg.runTag} seller reply`],
  );
}
