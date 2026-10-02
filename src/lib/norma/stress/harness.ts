import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { promotePropertyEnrollmentPauseReason, pausePropertyEnrollments, resumeByProperty, retrySequenceStep } from "@/lib/sequences/enrollment";

import { createBlandClient } from "../bland";
import type { CallbackTimeProvider } from "../callback-time";
import type { NormaBlandConfig, NormaEnv } from "../config";
import { readNormaGateConfig } from "../config";
import { dispatchNormaCall, type DispatchResult } from "../dispatch";
import { evaluateNormaGate } from "../gate";
import { reconcileNormaCalls, type ReconcileSummary } from "../reconcile";
import { requestNormaCallCore, type RequestNormaCallResult } from "../request-call";
import { sweepResumeCallInProgress, upgradeNormaHoldPauses } from "../rpc";
import { drainNormaNotifications, type NormaNotificationSummary, type NormaSlackPost } from "../slack-worker";
import { handleBlandCallWebhook } from "../webhook";
import { createScratchDb, seedWorld, type Lead, type LeadOptions, type Scratch, type World } from "./db";
import { FakeBland, WEBHOOK_SECRET, type Plan, type WebhookResult } from "./fake-bland";
import { createPgSupabase, type OpHook, type OpInfo } from "./pg-client";
import { Trace, type Rng } from "./trace";

type Client = SupabaseClient<Database>;

export type GateMode = "open" | "disabled" | "not_allowed";
export type LeadCtx = {
  lead: Lead;
  plan: Plan;
  /** Gate seen by the request action (creates no request when closed). */
  requestGate: GateMode;
  /** Gate seen by dispatchNormaCall; tests may flip it between phases. */
  dispatchGate: GateMode;
  /** Writes the driver made that the dispatch eligibility recheck must respect. */
  writes: { kind: "dnc" | "not_interested"; startTick: number; doneTick: number }[];
};

export type DispatchEval = { requestId: string; tick: number; open: boolean };

export const BLAND_CONFIG: NormaBlandConfig = {
  apiKey: "stress-key",
  baseUrl: "https://bland.stress.invalid",
  pathwayId: "pathway-stress",
  pathwayVersion: 3,
  voice: "voice-stress",
  fromNumber: "+18165550000",
  webhookUrl: "https://sandra.stress.invalid/api/webhooks/bland/call",
  timeoutMs: 10_000,
  waitForGreeting: true,
  backgroundTrack: "office",
};

/** A deterministic stand-in for the callback-time AI fallback (never a real model call). */
export function stubCallbackProvider(r: Rng): CallbackTimeProvider {
  return async () => {
    const roll = r.next();
    if (roll < 0.4) return null;
    if (roll < 0.6) throw new Error("stub ai failure");
    return { local_date: null, local_time: null, confidence: 0 };
  };
}

export class FakeSlack {
  posts: { tick: number; propertyId: string | null; ts: string }[] = [];
  /** Posts that Slack accepted but whose response was lost (client sees an error). */
  lostAcks = new Set<string>();
  failNext = new Map<string, number>();
  failProbability = 0;
  private counter = 0;
  constructor(private readonly trace: Trace, private readonly rand: Rng) {}

  post: NormaSlackPost = async (message) => {
    const text = JSON.stringify(message);
    const propertyId = /\/leads\/([0-9a-f-]{36})/.exec(text)?.[1] ?? null;
    const queued = propertyId ? (this.failNext.get(propertyId) ?? 0) : 0;
    if (propertyId && queued > 0) {
      this.failNext.set(propertyId, queued - 1);
      throw new Error("slack_post_failed:fake_outage");
    }
    if (this.failProbability > 0 && this.rand.chance(this.failProbability)) throw new Error("slack_post_failed:fake_flake");
    const ts = `1700000000.${String(++this.counter).padStart(6, "0")}`;
    this.posts.push({ tick: this.trace.tick(), propertyId, ts });
    if (propertyId && this.lostAcks.has(propertyId)) {
      this.lostAcks.delete(propertyId);
      throw new Error("slack_post_failed:response_lost");
    }
    return { ts };
  };
  postsFor(propertyId: string) {
    return this.posts.filter((p) => p.propertyId === propertyId);
  }
}

export class Harness {
  readonly trace = new Trace();
  readonly leads = new Map<string, LeadCtx>();
  readonly dispatchEvals: DispatchEval[] = [];
  /** The error behind each 500 a webhook answered, for diagnosis. */
  readonly webhook500Causes: string[] = [];
  readonly inflightDispatch = new Map<string, boolean[]>();
  readonly hooks: OpHook[] = [];
  readonly bland: FakeBland;
  readonly slack: FakeSlack;
  readonly reports = (globalThis as { __normaStressReports?: { message: string; surface: string | null }[] }).__normaStressReports ?? [];
  private readonly clients = new Map<string, Client>();
  /** Makes the next webhook-triggered retry dispatch fail (a crash between scheduling and dialling). */
  skipRetryDispatchOnce = false;
  /** Set per run so the random AI stand-in is reproducible. */
  provider: CallbackTimeProvider | null = null;
  /** The database clock can drift from this process's (Docker); workers use DB-aligned time. */
  private clockOffsetMs = 0;

  private constructor(
    readonly scratch: Scratch,
    readonly world: World,
    readonly rand: Rng,
  ) {
    this.bland = new FakeBland({
      trace: this.trace,
      secret: WEBHOOK_SECRET,
      fromNumber: BLAND_CONFIG.fromNumber,
      deliver: async (request) => {
        const response = await handleBlandCallWebhook(request, {
          client: this.client("webhook"),
          secret: WEBHOOK_SECRET,
          callbackTimeProvider: this.provider,
          // The route's call-twice retry: the ordinary dispatch path, gate and recheck included.
          dispatch: (id) => {
            // Test seam: the process "dies" after the retry was scheduled, before it was dialled.
            if (this.skipRetryDispatchOnce) {
              this.skipRetryDispatchOnce = false;
              return Promise.reject(new Error("simulated crash before the retry dispatch"));
            }
            return this.dispatch(id, "webhook-retry");
          },
        });
        if (response.status === 500) {
          const last = [...this.reports].reverse().find((x) => x.surface === "norma_webhook");
          this.webhook500Causes.push(last?.message ?? "unknown");
        }
        return response;
      },
    });
    this.slack = new FakeSlack(this.trace, rand);
  }

  static async create(rand: Rng, scratch?: Scratch, world?: World): Promise<Harness> {
    const s = scratch ?? (await createScratchDb());
    const w = world ?? (await seedWorld(s.pool));
    const h = new Harness(s, w, rand);
    await h.syncClock();
    return h;
  }

  async syncClock() {
    const before = Date.now();
    const { rows } = await this.scratch.pool.query<{ ms: string }>("select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms");
    this.clockOffsetMs = Number(rows[0]!.ms) - Math.round((before + Date.now()) / 2);
  }

  /** "Now" as the database sees it. */
  nowMs() {
    return Date.now() + this.clockOffsetMs;
  }

  /** One logical caller. All callers share the pool, so they interleave for real. */
  client(actor: string): Client {
    let c = this.clients.get(actor);
    if (!c) {
      c = createPgSupabase(this.scratch.pool, {
        actor,
        trace: this.trace,
        before: async (info) => {
          for (const hook of this.hooks) await hook(info);
        },
      });
      this.clients.set(actor, c);
    }
    return c;
  }

  addHook(hook: OpHook) {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** Hold the first operation matching `match` until `until` resolves. */
  holdOnce(match: (info: OpInfo) => boolean, until: Promise<void>, onArrive?: () => void) {
    let used = false;
    const remove = this.addHook(async (info) => {
      if (used || !match(info)) return;
      used = true;
      onArrive?.();
      await until;
    });
    return remove;
  }

  async lead(opts: LeadOptions = {}, plan?: Partial<Plan>, gates?: { request?: GateMode; dispatch?: GateMode }): Promise<LeadCtx> {
    const lead = await this.world.nextLead(opts);
    const ctx: LeadCtx = {
      lead,
      plan: { kind: "callback", send: "accept", lookup: "truth", webhooksBeforeResponse: 0, ...plan },
      requestGate: gates?.request ?? "open",
      dispatchGate: gates?.dispatch ?? gates?.request ?? "open",
      writes: [],
    };
    this.bland.plan(lead.phone, ctx.plan);
    this.leads.set(lead.property, ctx);
    return ctx;
  }

  private gateEnv(number: string, mode: GateMode): NormaEnv {
    const base: NormaEnv = {
      NORMA_CALLBACK_ASSIGNEE_ID: this.world.assignee,
      NEXT_PUBLIC_APP_URL: "https://sandra.stress.invalid",
    };
    if (mode === "disabled") return { ...base, NORMA_DISPATCH_ENABLED: "0", NORMA_ALLOWED_NUMBERS: number };
    if (mode === "not_allowed") return { ...base, NORMA_DISPATCH_ENABLED: "1", NORMA_ALLOWED_NUMBERS: "+18165550001" };
    return { ...base, NORMA_DISPATCH_ENABLED: "1", NORMA_ALLOWED_NUMBERS: number };
  }

  // ---- the product paths under test ---------------------------------------

  /** Real action core; only the auth and client plumbing is substituted. */
  requestCall(ctx: LeadCtx, userId: string, opts: { actor?: string; crashBeforeDispatch?: boolean } = {}): Promise<RequestNormaCallResult> {
    const actor = opts.actor ?? "request";
    const client = this.client(actor);
    return requestNormaCallCore(ctx.lead.property, "stress context", {
      getUserId: async () => userId,
      sessionClient: client,
      adminClient: client,
      env: this.gateEnv(ctx.lead.phone, ctx.requestGate),
      dispatch: opts.crashBeforeDispatch
        ? async () => {
            throw new Error("simulated crash before dispatch");
          }
        : (id) => this.dispatch(id, actor),
    });
  }

  async dispatch(requestId: string, actor = "dispatch"): Promise<DispatchResult> {
    const row = (await this.scratch.pool.query<{ phone_e164: string }>("select phone_e164 from public.norma_call_requests where id = $1", [requestId])).rows[0];
    const number = row?.phone_e164 ?? "";
    const ctx = [...this.leads.values()].find((l) => l.lead.phone === number);
    const mode = ctx?.dispatchGate ?? "open";
    const gate = readNormaGateConfig(this.gateEnv(number, mode));
    const open = evaluateNormaGate(number, gate).open;
    this.dispatchEvals.push({ requestId, tick: this.trace.tick(), open });
    const inflight = this.inflightDispatch.get(requestId) ?? [];
    inflight.push(open);
    this.inflightDispatch.set(requestId, inflight);
    try {
      return await dispatchNormaCall(requestId, {
        client: this.client(actor),
        bland: createBlandClient(BLAND_CONFIG, this.bland.fetch),
        blandConfig: BLAND_CONFIG,
        gate,
      });
    } finally {
      inflight.splice(inflight.indexOf(open), 1);
    }
  }

  /**
   * Deliver the (good) webhook of every call a lead's request places, in order:
   * a no-answer first call places the retry, whose own webhook is then delivered.
   * Stops when a delivery places no further call (at most two calls exist).
   */
  async finish(ctx: LeadCtx, flavor: "good" = "good"): Promise<WebhookResult[]> {
    const results: WebhookResult[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const call = this.bland.callsForNumber(ctx.lead.phone).find((c) => !seen.has(c.callId));
      if (!call) break;
      seen.add(call.callId);
      results.push(await this.bland.webhook(call, flavor));
    }
    return results;
  }

  async reconcile(opts: { includeNeedsReview?: boolean; actor?: string } = {}): Promise<ReconcileSummary> {
    const actor = opts.actor ?? "reconcile";
    await this.syncClock();
    return reconcileNormaCalls({
      client: this.client(actor),
      bland: createBlandClient(BLAND_CONFIG, this.bland.fetch),
      dispatch: (id) => this.dispatch(id, actor),
      includeNeedsReview: opts.includeNeedsReview,
      now: this.nowMs(),
      callbackTimeProvider: this.provider,
    });
  }

  async slackDrain(): Promise<NormaNotificationSummary> {
    await this.syncClock();
    return drainNormaNotifications({
      client: this.client("slack"),
      post: this.slack.post,
      now: this.nowMs(),
      env: { NEXT_PUBLIC_APP_URL: "https://sandra.stress.invalid" },
    });
  }

  // ---- concurrent events the seller / reps / other systems cause -----------

  /** Seller texts back. Same two calls, same order, as the inbound webhook. */
  async inboundReply(ctx: LeadCtx, actor = "inbound") {
    const client = this.client(actor);
    await upgradeNormaHoldPauses(client, { propertyId: ctx.lead.property, reason: "inbound_reply" });
    await pausePropertyEnrollments(client, { propertyId: ctx.lead.property, reason: "inbound_reply" });
  }

  /** A rep texts the seller; the seller's reply then becomes a human takeover. */
  async takeover(ctx: LeadCtx, actor = "takeover") {
    const client = this.client(actor);
    await upgradeNormaHoldPauses(client, { propertyId: ctx.lead.property, reason: "rep_sms_human_takeover" });
    await pausePropertyEnrollments(client, { propertyId: ctx.lead.property, reason: "rep_sms_human_takeover" });
    await promotePropertyEnrollmentPauseReason(client, {
      propertyId: ctx.lead.property,
      fromReason: "inbound_reply",
      reason: "rep_sms_human_takeover",
    });
  }

  /** Do-not-contact: lead lock, contact flag, and permanent opt-out of every drip. */
  async dnc(ctx: LeadCtx, how: "lock" | "registry" | "contact", actor = "dnc") {
    const startTick = this.trace.tick();
    const pool = this.scratch.pool;
    const org = this.world.org;
    if (how === "registry") {
      await pool.query(
        `insert into public.global_phone_dnc_registry (org_id, phone_e164, first_consumer_id, first_source_event_id, first_evidence_sha256)
         values ($1, $2, gen_random_uuid(), 'stress', repeat('a', 64)) on conflict do nothing`,
        [org, ctx.lead.phone],
      );
    } else if (how === "contact") {
      await pool.query("update public.contacts set do_not_contact = true where id = $1", [ctx.lead.contact]);
    } else {
      await pool.query("update public.properties set is_dnc_locked = true, outreach_dispo = 'dnc' where id = $1", [ctx.lead.property]);
    }
    await pausePropertyEnrollments(this.client(actor), { propertyId: ctx.lead.property, reason: "consent_revoked" as never, permanent: true });
    ctx.writes.push({ kind: "dnc", startTick, doneTick: this.trace.tick() });
    this.trace.add(actor, "mark", `dnc:${how}`, { property: ctx.lead.property });
  }

  /** A rep sets the disposition to not_interested (never downgrades a DNC lead). */
  async notInterested(ctx: LeadCtx, actor = "dispo") {
    const startTick = this.trace.tick();
    await this.scratch.pool.query(
      `update public.properties set outreach_dispo = 'not_interested', updated_at = now()
        where id = $1 and not is_dnc_locked and (outreach_dispo is null or outreach_dispo <> all (array['dnc','opted_out','bad_number','wrong_number']))`,
      [ctx.lead.property],
    );
    ctx.writes.push({ kind: "not_interested", startTick, doneTick: this.trace.tick() });
    this.trace.add(actor, "mark", "not_interested", { property: ctx.lead.property });
  }

  /** Softphone dials the lead: pauses active drips as call_in_progress. */
  async softphonePause(ctx: LeadCtx, actor = "softphone") {
    await pausePropertyEnrollments(this.client(actor), { propertyId: ctx.lead.property, reason: "call_in_progress" });
  }

  /** Softphone hangs up: the real cleanup path. */
  async softphoneCleanup(ctx: LeadCtx, actor = "softphone") {
    await resumeByProperty(this.client(actor), { propertyId: ctx.lead.property });
  }

  /** A rep presses Retry on a provider_failed drip (the retry_sequence_step RPC; refused under a Norma hold). */
  async retryStep(ctx: LeadCtx, actor = "retry") {
    for (const id of ctx.lead.enrollments) await retrySequenceStep(this.client(actor), id);
  }

  /**
   * The stale-call cron (sweep-stuck-call-in-progress), same candidate rule
   * (call_in_progress older than 30 minutes) and the same hold-aware RPC. The
   * route's runSoftphoneSweep is not exported, so this is its SQL equivalent.
   */
  async staleSweep(actor = "stale-sweep"): Promise<number> {
    await this.syncClock();
    const cutoff = new Date(this.nowMs() - 30 * 60 * 1000).toISOString();
    const { rows } = await this.scratch.pool.query<{ id: string }>(
      "select id from public.sequence_enrollments where status = 'paused' and pause_reason = 'call_in_progress' and updated_at < $1 order by updated_at limit 200",
      [cutoff],
    );
    if (!rows.length) return 0;
    return sweepResumeCallInProgress(this.client(actor), { enrollmentIds: rows.map((r) => r.id), resumeAt: new Date(this.nowMs()).toISOString() });
  }

  async advance(ms: number) {
    this.trace.add("clock", "mark", "advance", { ms });
    await this.scratch.advance(ms);
  }

  /**
   * Recovery workers on a virtual clock: each round moves time forward and runs
   * the reconcile sweep (needs_review rows hourly), the stale-call sweep and the
   * Slack worker. Stops early once every request is terminal or needs_review.
   */
  async recover(opts: { horizonMs: number; stepMs?: number; orgScope?: string } = { horizonMs: 3 * 3600_000 }) {
    const step = opts.stepMs ?? 5 * 60_000;
    let elapsed = 0;
    let rounds = 0;
    while (elapsed < opts.horizonMs) {
      await this.advance(step);
      elapsed += step;
      rounds += 1;
      await this.reconcile({ includeNeedsReview: rounds % 12 === 0 });
      await this.staleSweep();
      await this.slackDrain();
      // Never stop before the 30-minute stale-call window has passed once, so a
      // softphone pause made just before the end is still swept.
      if (elapsed >= 45 * 60_000 && (await this.allSettled())) break;
    }
    return { elapsed, rounds };
  }

  async allSettled() {
    const r = await this.scratch.pool.query(
      "select count(*)::int as n from public.norma_call_requests where org_id = $1 and status in ('requested','dispatching','dispatched','dispatch_unknown')",
      [this.world.org],
    );
    return r.rows[0].n === 0;
  }

  async close() {
    await this.scratch.drop();
  }
}
