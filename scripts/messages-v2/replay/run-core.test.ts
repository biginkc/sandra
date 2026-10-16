import { describe, expect, it, vi } from "vitest";

import {
  describeRun,
  formatProgress,
  gapMs,
  percentile,
  preflight,
  runReplay,
  sendilloPayload,
  summarize,
  type Deps,
  type InboundResult,
  type RunOptions,
} from "./run-core";
import { PROD_PROJECT_REF } from "./safety";
import type { ReplayExport, ReplayInbound } from "./schema";

const mkInbound = (n: number, at: string): ReplayInbound => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  externalId: `ext-${n}`,
  from: "+19135550101",
  to: "+18165559999",
  body: `message ${n}`,
  receivedAt: at,
  contactId: null,
  propertyId: null,
  conversationId: null,
});

const exp = (inbound: ReplayInbound[]): ReplayExport => ({
  version: 1,
  batchId: "b1",
  createdAt: "2026-10-07T00:00:00Z",
  sourceOrgId: "src",
  window: { start: "2026-09-07T00:00:00Z", end: "2026-10-07T00:00:00Z", days: 30, contextDays: 60 },
  businessNumbers: [],
  tables: { contacts: [], properties: [], property_contacts: [], message_threads: [], messages: [], sms_phone_suppressions: [], consent_events: [], ai_responder_configs: [], jev_outcome_thresholds: [] },
  inbound,
  reference: { pipelineRuns: [{ inbound_message_id: inbound[0]?.id, status: "replied", final_outcome: "sent" }], outboundInWindow: [] },
  counts: {},
});

const baseOpts: RunOptions = {
  baseUrl: "http://localhost:3101",
  supabaseUrl: "http://127.0.0.1:54331",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
  prodRefs: [PROD_PROJECT_REF],
  webhookSecret: "whsec-local",
  speed: 1,
  burst: true,
  maxGapSeconds: 0,
  limit: null,
  since: null,
  runTimeoutMs: 1000,
  pollMs: 1,
};

const goodHandshake = { replayStub: true, sendilloApiKeyPresent: false, llmAutosend: "0", supabaseHost: "127.0.0.1:54331" };

function fakeDeps(over: Partial<Deps> & { handshake?: unknown; runs?: Record<string, { status: string; final_outcome: string | null }>; steps?: Record<string, unknown[]> } = {}) {
  const posted: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const lines: string[] = [];
  let clock = 1_000;
  const deps: Deps = {
    env: { SMS_PROVIDER_STUB: "1" },
    now: () => (clock += 5),
    sleep: async (ms) => {
      clock += ms;
    },
    log: (l) => lines.push(l),
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/webhooks/replay/handshake")) {
        const h = over.handshake === undefined ? goodHandshake : over.handshake;
        return new Response(JSON.stringify(h), { status: h === null ? 404 : 200 });
      }
      posted.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    query: async (sql: string, params?: unknown[]) => {
      if (/from public.replay_batches/.test(sql)) return { rows: [{ org_id: "org-r" }] };
      if (/join public.pipeline_runs/.test(sql)) {
        const ext = String(params?.[1]);
        const key = ext.split("-").slice(-1)[0];
        const run = over.runs?.[key] ?? { status: "replied", final_outcome: "sent" };
        return { rows: [{ id: `run-${key}`, started_at: new Date(1000), ...run }] };
      }
      if (/from public.pipeline_run_steps/.test(sql)) {
        const key = String(params?.[0]).replace("run-", "");
        return { rows: (over.steps?.[key] ?? []) as never[] };
      }
      if (/replay_outbound_log/.test(sql)) return { rows: [{ n: 2 }] };
      return { rows: [] };
    },
    ...over,
  };
  return { deps, posted, lines };
}

describe("preflight refuses before touching anything", () => {
  it("rejects a non-local base URL without making a single request or query", async () => {
    const { deps } = fakeDeps();
    const fetchSpy = vi.fn(deps.fetch);
    const querySpy = vi.fn(deps.query);
    await expect(preflight(exp([]), { ...baseOpts, baseUrl: "https://sandra.example.com" }, { ...deps, fetch: fetchSpy as never, query: querySpy })).rejects.toThrow(/localhost/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("rejects the production Supabase project", async () => {
    const { deps } = fakeDeps();
    await expect(preflight(exp([]), { ...baseOpts, supabaseUrl: `https://${PROD_PROJECT_REF}.supabase.co` }, deps)).rejects.toThrow(/production/i);
  });

  it("rejects when the harness process holds a Sendillo key", async () => {
    const { deps } = fakeDeps({ env: { SMS_PROVIDER_STUB: "1", SENDILLO_API_KEY: "sk" } });
    await expect(preflight(exp([]), baseOpts, deps)).rejects.toThrow(/SENDILLO_API_KEY/);
  });

  it("sets SMS_PROVIDER_STUB=1 and AI_RESPONDER_LLM_AUTOSEND=0 on the harness process", async () => {
    const env: Record<string, string | undefined> = {};
    const { deps } = fakeDeps({ env });
    await preflight(exp([]), baseOpts, deps);
    expect(env.SMS_PROVIDER_STUB).toBe("1");
    expect(env.AI_RESPONDER_LLM_AUTOSEND).toBe("0");
  });

  it.each([
    [null, /handshake/i],
    [{ ...goodHandshake, replayStub: false }, /stub/i],
    [{ ...goodHandshake, sendilloApiKeyPresent: true }, /api key/i],
    [{ ...goodHandshake, llmAutosend: "1" }, /autosend/i],
    [{ ...goodHandshake, supabaseHost: "somewhere.supabase.co" }, /supabase/i],
  ])("rejects a server that does not prove it is stubbed (%j)", async (handshake, re) => {
    const { deps, posted } = fakeDeps({ handshake });
    await expect(runReplay(exp([mkInbound(1, "2026-10-01T00:00:00Z")]), baseOpts, deps, "r1")).rejects.toThrow(re);
    expect(posted).toHaveLength(0); // nothing was ever sent to the webhook
  });

  it("rejects an unseeded batch", async () => {
    const { deps } = fakeDeps({ query: async () => ({ rows: [] }) });
    await expect(preflight(exp([]), baseOpts, deps)).rejects.toThrow(/not seeded/);
  });
});

describe("pacing", () => {
  const opts = { speed: 10, burst: false, maxGapSeconds: 0 };
  it("scales original gaps by speed, burst is zero, and a cap applies", () => {
    expect(gapMs("2026-10-01T00:00:00Z", "2026-10-01T00:01:00Z", { ...opts, speed: 1 })).toBe(60_000);
    expect(gapMs("2026-10-01T00:00:00Z", "2026-10-01T00:01:00Z", opts)).toBe(6_000);
    expect(gapMs("2026-10-01T00:00:00Z", "2026-10-01T00:01:00Z", { ...opts, burst: true })).toBe(0);
    expect(gapMs("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", { ...opts, maxGapSeconds: 5 })).toBe(5_000);
    expect(gapMs(null, "2026-10-01T00:00:00Z", opts)).toBe(0);
  });
});

describe("percentile", () => {
  it("nearest-rank p50/p95", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("describeRun", () => {
  const started = new Date("2026-10-07T12:00:00.000Z");
  const at = (ms: number) => new Date(started.getTime() + ms);
  it("extracts the Jev judgment, the gate hit, disposition and per-step latency", () => {
    const d = describeRun(
      { status: "held", final_outcome: "escalated", started_at: started },
      [
        { seq: 1, kind: "gate", name: "pre_gates", result: "pass", detail: null, created_at: at(100) },
        { seq: 2, kind: "jev", name: "classify", result: "pass", detail: { outcome: "not_interested", nativeConfidence: 0.91 }, created_at: at(900) },
        { seq: 3, kind: "gate", name: "outbound_policy", result: "block", detail: { rule: 4 }, created_at: at(950) },
        { seq: 4, kind: "hold", name: "llm_draft_held", result: "held", detail: {}, created_at: at(1000) },
      ],
    );
    expect(d).toMatchObject({ jevOutcome: "not_interested", confidence: 0.91, gate: "outbound_policy#4", disposition: "held", finalOutcome: "escalated" });
    expect(d.stepLatencies).toEqual([
      { step: "gate:pre_gates", ms: 100 },
      { step: "jev:classify", ms: 800 },
      { step: "gate:outbound_policy", ms: 50 },
      { step: "hold:llm_draft_held", ms: 50 },
    ]);
  });
  it("auto when the run replied; no_run when there is none", () => {
    expect(describeRun({ status: "replied", final_outcome: "sent", started_at: started }, []).disposition).toBe("auto");
    expect(describeRun(null, []).disposition).toBe("no_run");
  });
});

describe("runReplay", () => {
  const three = [mkInbound(1, "2026-10-01T00:00:00Z"), mkInbound(2, "2026-10-01T00:00:30Z"), mkInbound(3, "2026-10-01T00:01:00Z")];

  it("posts to the sendillo webhook in original order with the local secret and unique ids", async () => {
    const { deps, posted, lines } = fakeDeps();
    const { results, summary } = await runReplay(exp(three), baseOpts, deps, "run9");
    expect(posted.map((p) => JSON.parse(p.body).data.body)).toEqual(["message 1", "message 2", "message 3"]);
    expect(posted.every((p) => p.url === "http://localhost:3101/api/webhooks/sendillo/sms")).toBe(true);
    expect(posted[0].headers["x-sendillo-webhook-secret"]).toBe("whsec-local");
    expect(JSON.parse(posted[0].body)).toEqual({
      event: "inbound.received",
      data: { messageId: "replay-b1-run9-ext-1", from: "+19135550101", to: "+18165559999", body: "message 1", receivedAt: "2026-10-01T00:00:00Z" },
    });
    expect(results.map((r) => r.inboundId)).toEqual(three.map((i) => i.id));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[1\/3\] msg=00000001 jev=- conf=- gate=pass disp=auto outcome=sent ms=\d+ orig=sent$/);
    expect(summary).toMatchObject({ total: 3, auto: 3, held: 0, wouldHaveSent: 2 });
  });

  it("burst mode never sleeps; speed 1 sleeps the original gaps", async () => {
    const burst = fakeDeps();
    const sleepBurst = vi.spyOn(burst.deps, "sleep");
    await runReplay(exp(three), baseOpts, burst.deps, "r");
    expect(sleepBurst.mock.calls.filter(([ms]) => ms >= 1000)).toHaveLength(0);

    const real = fakeDeps();
    const sleepReal = vi.spyOn(real.deps, "sleep");
    await runReplay(exp(three), { ...baseOpts, burst: false, speed: 1 }, real.deps, "r");
    expect(sleepReal.mock.calls.map(([ms]) => ms).filter((ms) => ms >= 1000)).toEqual([30_000, 30_000]);
  });

  it("honours --limit and --since", async () => {
    const a = fakeDeps();
    await runReplay(exp(three), { ...baseOpts, limit: 2 }, a.deps, "r");
    expect(a.posted).toHaveLength(2);
    const b = fakeDeps();
    await runReplay(exp(three), { ...baseOpts, since: "2026-10-01T00:00:45Z" }, b.deps, "r");
    expect(b.posted).toHaveLength(1);
  });

  it("records a failed POST, a run that never appears, and a run stuck running", async () => {
    const failing = fakeDeps();
    const orig = failing.deps.fetch;
    failing.deps.fetch = (async (input: URL | string, init?: RequestInit) =>
      String(input).includes("/sendillo/sms") ? new Response("nope", { status: 500 }) : orig(input, init)) as typeof fetch;
    const r1 = await runReplay(exp([three[0]]), baseOpts, failing.deps, "r");
    expect(r1.results[0].disposition).toBe("post_failed");

    const noRun = fakeDeps();
    const q = noRun.deps.query;
    noRun.deps.query = async (sql, params) => (/join public.pipeline_runs/.test(sql) ? { rows: [] } : q(sql, params));
    const r2 = await runReplay(exp([three[0]]), baseOpts, noRun.deps, "r");
    expect(r2.results[0].disposition).toBe("no_run");

    const stuck = fakeDeps({ runs: { "1": { status: "running", final_outcome: null } } });
    const r3 = await runReplay(exp([three[0]]), baseOpts, stuck.deps, "r");
    expect(r3.results[0].disposition).toBe("timeout");
    expect(r3.summary.failures.map((f) => f.reason)).toEqual(["timeout"]);
  });
});

describe("summarize", () => {
  const mk = (over: Partial<InboundResult>): InboundResult => ({
    index: 0, inboundId: "x", externalId: "e", httpStatus: 200, runStatus: "replied", finalOutcome: "sent",
    jevOutcome: "nurture", confidence: 0.9, gate: "pass", disposition: "auto", wallMs: 100, stepLatencies: [{ step: "jev:classify", ms: 100 }],
    original: { status: "replied", finalOutcome: "sent" }, ...over,
  });
  it("counts outcomes, auto vs held, gate hits, latency percentiles, agreement and failures", () => {
    const s = summarize(
      [
        mk({ wallMs: 100 }),
        mk({ wallMs: 300, stepLatencies: [{ step: "jev:classify", ms: 300 }], disposition: "held", runStatus: "held", finalOutcome: "escalated", gate: "outbound_policy#4" }),
        mk({ wallMs: 200, disposition: "timeout", runStatus: "running", finalOutcome: null, original: null }),
      ],
      { batchId: "b", runId: "r", startedAt: "s", finishedAt: "f", deadLetters: [{ id: "d1" }], wouldHaveSent: 1 },
    );
    expect(s.perOutcome).toEqual({ sent: 1, escalated: 1, running: 1 });
    expect(s.auto).toBe(1);
    expect(s.held).toBe(1);
    expect(s.gateRuleHits).toEqual({ "outbound_policy#4": 1 });
    expect(s.latencyMsPerStep["jev:classify"]).toEqual({ n: 3, p50: 100, p95: 300 });
    expect(s.agreement).toEqual({ compared: 2, sameFinalOutcome: 1 });
    expect(s.deadLetters).toHaveLength(1);
    expect(s.failures).toEqual([{ inboundId: "x", reason: "timeout" }]);
  });
});

describe("formatProgress / payload", () => {
  it("formats confidence and original outcome", () => {
    const line = formatProgress(7, 120, {
      index: 6, inboundId: "abcdef12-0000", externalId: "e", httpStatus: 200, runStatus: "held", finalOutcome: "escalated",
      jevOutcome: "wrong_number", confidence: 0.8765, gate: "pass", disposition: "held", wallMs: 4321, stepLatencies: [], original: null,
    });
    expect(line).toBe("[007/120] msg=abcdef12 jev=wrong_number conf=0.88 gate=pass disp=held outcome=escalated ms=4321");
  });
  it("payload round-trips through the real Sendillo parser", async () => {
    const { SendilloMessagingProvider } = await import("../../../src/lib/messaging/providers/sendillo");
    const provider = new SendilloMessagingProvider("k", null, "whsec-local");
    const events = provider.parseInboundWebhook(sendilloPayload(mkInbound(1, "2026-10-01T00:00:00Z"), "replay-b1-r-ext-1"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalId: "replay-b1-r-ext-1", from: "+19135550101", to: "+18165559999", body: "message 1" });
    expect(events[0].receivedAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    const ok = new Headers({ "x-sendillo-webhook-secret": "whsec-local" });
    expect(provider.verifyWebhookSignature("{}", ok)).toBe(true);
  });
});
