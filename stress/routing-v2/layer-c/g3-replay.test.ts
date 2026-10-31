import { performance } from "node:perf_hooks";

import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertStack, pct, Receipt } from "./lib/env";
import { deliverWebhook, Pool, webhookErrors, workflowSink, type WorkflowCall } from "./lib/driver";

/** reportError histogram (surface | message), captured from console.error. */
const errHist = new Map<string, number>();
const realErr = console.error;
console.error = (...a: unknown[]) => {
  if (a[0] === "[reportError]" && a[1] && typeof a[1] === "object") {
    const o = a[1] as { message?: string; tags?: { surface?: string } };
    const k = `${o.tags?.surface ?? "?"} | ${String(o.message ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").slice(0, 120)}`;
    errHist.set(k, (errHist.get(k) ?? 0) + 1);
    return;
  }
  realErr(...a);
};
import { createRunOrg, retirePriorRuns, seedLeads, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/**
 * G3 (STRESS §3): Oct replay through the REAL webhook path, compressed, then a 2x burst, with the
 * §3.2 chaos the code path allows. All providers stubbed in-process; mock SMS provider.
 * Env knobs: G3_SECONDS (main replay length, default 300), G3_POOL (workflow concurrency, 24).
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const data = loadReplay();
const stubs = new ProviderStubs(data);
const R = new Receipt(process.env.G3_RECEIPT ?? "G3-replay.txt");
const T = Number(process.env.G3_SECONDS ?? 300) * 1000;
const POOL = Number(process.env.G3_POOL ?? 16);
const WEBHOOK_POOL = Number(process.env.G3_WEBHOOK_POOL ?? 12);
let webhook500 = 0;
/** Wait for in-flight workflows, at most `ms`; returns how many were still running. */
async function drainInflight(ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (inflight.size && Date.now() < deadline) await Promise.race([Promise.all([...inflight]), new Promise((r) => setTimeout(r, 5000))]);
  return inflight.size;
}
let org: RunOrg;

type Track = { phase: string; accepted: number; done?: number; outcome?: unknown; fault: string };
const track = new Map<string, Track>();
let phase = "init";
let faultLabel = "none";
const pool = new Pool(POOL);
const inflight = new Set<Promise<unknown>>();
const running = new Map<string, WorkflowCall>();
let paused = false;
let reexecuted = 0;

function launch(c: WorkflowCall, again = false) {
  const id = c.params.inboundMessageId;
  if (!again) track.set(id, { phase, accepted: performance.now(), fault: faultLabel });
  const p = pool.run(async () => {
    while (paused) await new Promise((r) => setTimeout(r, 100));
    running.set(id + (again ? ":re" : ""), c);
    try {
      const out = await c.fn(c.params);
      const t = track.get(id)!;
      if (!again) { t.done = performance.now(); t.outcome = out; }
    } catch (e) {
      const t = track.get(id)!;
      if (!again) { t.done = performance.now(); t.outcome = { error: String(e) }; }
    } finally { running.delete(id + (again ? ":re" : "")); }
  });
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

beforeAll(async () => {
  assertStack();
  await pg.connect();
  stubs.install();
  workflowSink.onStart = (c) => launch(c);
});
afterAll(async () => { setClockOffset(0); stubs.uninstall(); await pg.end(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("G3 blast-day replay", async () => {
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { getMockMessageLog, resetMockState } = await import("@/lib/messaging/providers/mock");
  const { createTestClient } = await import("@tests/integration/client");
  const { checkRecipientQuietHours } = await import("@/lib/messaging/quiet-hours-recipient");
  const db = createTestClient();
  resetMockState();
  const runId = `g3-${Date.now()}`;
  org = await createRunOrg(pg, runId, { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, canary_percent: 100 });
  R.line("run", runId, "flags all slices on except wrong_number_all/model_stop_suppression (PR-G/PR-I paths still exercised via stop/wrong roads); canary_percent 100");
  R.line("retired prior-run pending outbox rows:", await retirePriorRuns(pg));

  // Seed 1,800 leads: rows 0..1751 carry the real our_last; 48 extra get a generic outbound.
  const rows = [...data.rows].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, Number(process.env.G3_LIMIT ?? 1e9));
  const BURST = Math.min(3000, rows.length * 2);
  const t0 = performance.now();
  const leads = await seedLeads(pg, org, rows.length + 48, { ourLast: (i) => rows[i]?.our_last ?? "Hi, are you open to an offer on your house?" });
  R.line(`seeded ${leads.length} leads (+contact, consent, property, outbound campaign text) in ${Math.round(performance.now() - t0)} ms`);

  // Delivery schedule.
  type Ev = { at: number; lead: Lead; body: string; ext: string; wave: string };
  const evs: Ev[] = [];
  const ts = rows.map((r) => Date.parse(r.created_at.replace(" ", "T").replace("+00", "Z")));
  const first = ts[0]!, last = ts[ts.length - 1]!;
  // Oct-28 daily curve: every row placed at its own UTC time of day (1,601 of 1,752 are Oct 28).
  void first; void last;
  rows.forEach((r, i) => evs.push({ at: ((ts[i]! % 86_400_000) / 86_400_000) * T, lead: leads[i]!, body: r.reply, ext: `${runId}-a-${i}`, wave: "replay" }));
  // Newest-first 3-message bursts on 30 extra leads (1752..1781).
  for (let k = 0; k < 30; k++) {
    const lead = leads[rows.length + k]!;
    const at = T * (0.2 + 0.02 * k);
    const bodies = [rows[(k * 37) % rows.length]!.reply, rows[(k * 53 + 7) % rows.length]!.reply, rows[(k * 11 + 3) % rows.length]!.reply];
    bodies.reverse().forEach((b, j) => evs.push({ at: at + j * 50, lead, body: b, ext: `${runId}-nf-${k}-${j}`, wave: "newest_first" }));
  }
  evs.sort((a, b) => a.at - b.at);
  // Duplicates: 5% twice, 1% three times (same provider message id), 2 s apart.
  const dupes: Ev[] = [];
  evs.forEach((e, i) => {
    if (i % 20 === 3) dupes.push({ ...e, at: e.at + 2000, wave: "dup2" });
    if (i % 100 === 7) { dupes.push({ ...e, at: e.at + 2000, wave: "dup2" }); dupes.push({ ...e, at: e.at + 4000, wave: "dup3" }); }
  });
  const all = [...evs, ...dupes].sort((a, b) => a.at - b.at);

  // Quiet-hours opening: the first 150 arrivals happen at 07:50 Chicago (JS clock), then real time.
  const quietCount = Math.min(150, Math.floor(rows.length / 10));
  setClockOffset(offsetToChicago(7, 50));
  phase = "quiet_0750";
  for (const e of all.slice(0, quietCount)) await deliverWebhook({ externalId: e.ext, from: e.lead.phone, to: org.sender, body: e.body });
  await drainInflight(120_000);
  await runRoutingV2OutboxReplies(db, { limit: 200 });
  const quietSends = getMockMessageLog().length;
  R.line(`quiet phase (JS clock 07:50 America/Chicago): ${quietCount} deliveries, sends during phase = ${quietSends}`);
  // Business hours for the rest of the run: JS clock 10:00 Chicago (the stack itself may be at night).
  const DAY = offsetToChicago(10, 0);
  setClockOffset(DAY);
  R.line("main replay + burst run on a JS clock of 10:00 America/Chicago (quiet-hours checks read the JS clock)");

  // Chaos script on the compressed timeline.
  const chaos: Array<[number, number, () => void, string]> = [
    [0.10, 0.18, () => { stubs.fault.jev = "429"; }, "jev_429"],
    [0.18, 0.24, () => { stubs.fault.jev = "latency25s"; }, "jev_latency25s"],
    [0.24, 0.50, () => { stubs.fault.jev = "5xx10"; }, "jev_5xx10"],
    [0.30, 0.36, () => { stubs.fault.haiku = "429"; }, "haiku_429"],
    [0.36, 0.60, () => { stubs.fault.haiku = "malformed5"; }, "haiku_malformed5"],
    [0.40, 0.46, () => { stubs.fault.dm = "creditout"; }, "dm_creditout"],
  ];
  const windows: Array<{ name: string; from: number; to: number }> = [];
  phase = "replay";
  const start = performance.now();
  const consumerTimes: number[] = [];
  let stopConsumer = false;
  const consumer = (async () => {
    while (!stopConsumer) {
      const c0 = performance.now();
      await runRoutingV2OutboxReplies(db, { limit: 50 }).catch((e) => R.line("consumer error", String(e)));
      consumerTimes.push(performance.now() - c0);
      await sleep(2000);
    }
  })();
  const restarts = [0.33, 0.83];
  let ri = 0;
  const applyFaults = (frac: number) => {
    stubs.fault = {};
    const names: string[] = [];
    for (const [a, b, f, n] of chaos) if (frac >= a && frac < b) { f(); names.push(n); }
    faultLabel = names.join("+") || "none";
  };
  const deliverOne = async (e: Ev) => {
    const st = await deliverWebhook({ externalId: e.ext, from: e.lead.phone, to: org.sender, body: e.body });
    if (st !== 200) { webhook500++; if (webhook500 <= 20) R.line("webhook status", st, e.ext); }
  };
  const webhookPool = new Pool(WEBHOOK_POOL);
  const webhookInflight: Promise<void>[] = [];
  const mainEvents = all.slice(quietCount);
  for (let idx = 0; idx < mainEvents.length; idx++) {
    const e = mainEvents[idx]!;
    const wait = e.at - (performance.now() - start);
    if (wait > 0) await sleep(wait);
    // Fault windows and restarts by arrival index (fraction of the main replay's deliveries).
    const frac = idx / mainEvents.length;
    applyFaults(frac);
    if (ri < restarts.length && frac >= restarts[ri]!) {
      // Worker restart: queued workflow work stops for 3 s; every step in flight is executed again
      // (a durable workflow re-runs an interrupted step).
      ri++;
      paused = true;
      const again = [...running.entries()].filter(([k]) => !k.endsWith(":re"));
      for (const [, c] of again) { launch(c, true); reexecuted++; }
      R.line(`worker restart at ${(frac * 100).toFixed(0)}%: re-executing ${again.length} in-flight steps, queue paused 3 s`);
      setTimeout(() => { paused = false; }, 3000);
    }
    webhookInflight.push(webhookPool.run(() => deliverOne(e)));
  }
  await Promise.all(webhookInflight);
  stubs.fault = {}; faultLabel = "none";
  for (const [a, b, , n] of chaos) windows.push({ name: n, from: a, to: b });
  const replayEnd = performance.now();
  const stuckMain = await drainInflight(600_000);
  R.line(`workflows still running 10 min after the main replay: ${stuckMain}`);
  R.line(`main replay: ${all.length - quietCount} deliveries in ${Math.round((replayEnd - start) / 1000)} s (target ${T / 1000} s); workflows drained at +${Math.round((performance.now() - replayEnd) / 1000)} s; re-executed steps ${reexecuted}`);

  // 2x burst: 3,000 second replies across the replay leads in T/2 at 2x the rate.
  phase = "burst";
  const burstStart = performance.now();
  const burst: Ev[] = [];
  for (let k = 0; k < BURST; k++) {
    const lead = leads[(k * 7) % rows.length]!;
    burst.push({ at: (k / BURST) * (T / 2), lead, body: rows[(k * 13 + 5) % rows.length]!.reply, ext: `${runId}-b-${k}`, wave: "burst" });
  }
  const burstInflight: Promise<void>[] = [];
  for (const e of burst) {
    const wait = e.at - (performance.now() - burstStart);
    if (wait > 0) await sleep(wait);
    burstInflight.push(webhookPool.run(() => deliverOne(e)));
  }
  await Promise.all(burstInflight);
  const burstEnd = performance.now();
  const stuckBurst = await drainInflight(600_000);
  R.line(`workflows still running 10 min after the burst: ${stuckBurst}; webhook non-200 responses: ${webhook500}`);
  const wfDrained = performance.now();
  stopConsumer = true;
  await consumer;
  // Drain: run the consumer until nothing is due.
  let drainPasses = 0;
  for (;;) {
    const r = await runRoutingV2OutboxReplies(db, { limit: 200 });
    drainPasses++;
    if (!r.results.some((x) => (x.result.kind as string) === "sent" || (x.result.kind as string) === "accepted") || drainPasses > 60) break;
  }
  const drained = performance.now();
  R.line(`burst: ${BURST} deliveries in ${Math.round((burstEnd - burstStart) / 1000)} s; workflows drained +${Math.round((wfDrained - burstEnd) / 1000)} s; outbox drained +${Math.round((drained - burstEnd) / 1000)} s (${drainPasses} passes)`);

  // ---------------------------------------------------------------- assertions (DB truth)
  const props = leads.map((l) => l.propertyId);
  const q = async (sql: string, args: unknown[] = [props]) => (await pg.query(sql, args)).rows;
  const inbound = await q("select id, property_id, body, created_at, metadata from messages where direction = 'inbound' and property_id = any($1)");
  const inboundIds = inbound.map((m) => m.id as string);
  R.line(`deliveries attempted: ${all.length + burst.length} (unique provider ids ${evs.length + burst.length}, duplicate deliveries ${dupes.length}); inbound rows stored: ${inbound.length}`);
  R.check("one inbound row per unique provider message id (duplicates never stored twice)", inbound.length === evs.length + burst.length, { stored: inbound.length, unique: evs.length + burst.length });

  const claims = await q("select inbound_message_id, count(*)::int n from ai_response_claims where property_id = any($1) group by 1");
  const maxClaims = Math.max(0, ...claims.map((c) => c.n));
  R.check("exactly one classification claim per inbound (ai_response_claims)", maxClaims <= 1, { inboundsWithClaim: claims.length, maxPerInbound: maxClaims });

  const decisions = await q("select inbound_message_id, status, road, provenance, action, failure_reason, haiku, latency_ms, created_at from routing_v2_live_decisions where property_id = any($1)");
  const decByInbound = new Map(decisions.map((d) => [d.inbound_message_id as string, d]));
  R.check("at most one live decision per inbound", decisions.length === decByInbound.size, { decisions: decisions.length, distinct: decByInbound.size });

  // Replies sent: outbox reply rows sent per inbound, and mock-provider sends per phone.
  const outbox = await q("select id, inbound_message_id, property_id, kind, status, cancel_reason, payload, provider_receipt from routing_v2_outbox where property_id = any($1)");
  const sentPerInbound = new Map<string, number>();
  for (const o of outbox) if (o.kind === "reply" && o.status === "sent") sentPerInbound.set(o.inbound_message_id, (sentPerInbound.get(o.inbound_message_id) ?? 0) + 1);
  const dblReply = [...sentPerInbound.values()].filter((n) => n > 1).length;
  R.check("zero double v2 replies per inbound (outbox)", dblReply === 0, { inboundsReplied: sentPerInbound.size, doubles: dblReply });
  const outMsgs = await q("select property_id, body, idempotency_key, created_at from messages where direction = 'outbound' and property_id = any($1) and created_at > now() - interval '2 hours' and coalesce(metadata->>'generated_by','') <> 'seed'");
  const byKey = new Map<string, number>();
  for (const m of outMsgs) if (m.idempotency_key) byKey.set(m.idempotency_key, (byKey.get(m.idempotency_key) ?? 0) + 1);
  R.check("zero duplicate provider submissions per outbox id (messages.idempotency_key)", [...byKey.values()].every((n) => n === 1), { keyed: byKey.size, outboundRows: outMsgs.length });
  const mock = getMockMessageLog();
  R.line(`mock provider sends: ${mock.length}`);

  const linkBad = outbox.filter((o) => !inboundIds.includes(o.inbound_message_id));
  R.check("every outbox row links back to an inbound of the same property", linkBad.length === 0, { outboxRows: outbox.length, unlinked: linkBad.length });
  const replyStatus: Record<string, number> = {};
  for (const o of outbox) { const k = `${o.kind}:${o.status}${o.cancel_reason ? ":" + o.cancel_reason : ""}`; replyStatus[k] = (replyStatus[k] ?? 0) + 1; }
  R.line("outbox status histogram", replyStatus);
  const pendingLeft = outbox.filter((o) => o.kind === "reply" && (o.status === "pending" || o.status === "claimed")).length;
  R.check("queue drained (no reply outbox row left pending/claimed after drain)", pendingLeft === 0, { pendingLeft });

  const alerts = outbox.filter((o) => o.kind === "alert");
  const alertKey = new Map<string, number>();
  for (const a of alerts) { const k = `${a.inbound_message_id}|${a.payload?.reason}`; alertKey.set(k, (alertKey.get(k) ?? 0) + 1); }
  const dblAlert = [...alertKey.values()].filter((n) => n > 1).length;
  const alertsPerInbound = new Map<string, number>();
  for (const a of alerts) alertsPerInbound.set(a.inbound_message_id, (alertsPerInbound.get(a.inbound_message_id) ?? 0) + 1);
  R.check("zero double alerts per inbound+reason (outbox alert rows)", dblAlert === 0, { alertRows: alerts.length, inboundsAlerted: alertsPerInbound.size, doubles: dblAlert, maxAlertRowsOneInbound: Math.max(0, ...alertsPerInbound.values()) });
  const alertReasons: Record<string, number> = {};
  for (const a of alerts) alertReasons[String(a.payload?.reason)] = (alertReasons[String(a.payload?.reason)] ?? 0) + 1;
  R.line("alert rows by reason (whole run incl. burst)", alertReasons);
  const replayInbound = new Set(inbound.filter((m) => !String(m.body).startsWith("\u0000")).map((m) => m.id));
  void replayInbound;

  const enr = await q("select property_id, status, ended_reason, routing_v2_inbound_id from sequence_enrollments where property_id = any($1)");
  const activePer = new Map<string, number>();
  for (const e of enr) if (e.status === "active") activePer.set(e.property_id, (activePer.get(e.property_id) ?? 0) + 1);
  const enrPerInbound = new Map<string, number>();
  for (const e of enr) if (e.routing_v2_inbound_id) enrPerInbound.set(e.routing_v2_inbound_id, (enrPerInbound.get(e.routing_v2_inbound_id) ?? 0) + 1);
  R.check("zero double enrolments (<=1 active per property; <=1 enrolment per inbound)", Math.max(0, ...activePer.values()) <= 1 && Math.max(0, ...enrPerInbound.values()) <= 1,
    { enrollments: enr.length, propsActive: activePer.size, maxActivePerProp: Math.max(0, ...activePer.values()), maxPerInbound: Math.max(0, ...enrPerInbound.values()) });
  const enrHist: Record<string, number> = {};
  for (const e of enr) { const k = `${e.status}:${e.ended_reason ?? ""}`; enrHist[k] = (enrHist[k] ?? 0) + 1; }
  R.line("enrollment status histogram", enrHist);

  // Stamped / decided / dead-lettered with a human flag.
  const propRows = await q("select id, needs_human_attention, last_ai_escalation_reason from properties where id = any($1)");
  const flag = new Map(propRows.map((p) => [p.id, p]));
  let stamped = 0, unstampedNoFlag = 0; const unstampedSamples: unknown[] = [];
  for (const m of inbound) {
    const st = m.metadata?.processing?.aiResponder;
    if (st) stamped++;
    else if (!decByInbound.has(m.id) && !flag.get(m.property_id)?.needs_human_attention) { unstampedNoFlag++; if (unstampedSamples.length < 8) unstampedSamples.push({ id: m.id, body: String(m.body).slice(0, 40), meta: m.metadata?.processing ?? null }); }
  }
  R.check("every inbound stamped, decided, or flagged for a human (no silent drop)", unstampedNoFlag === 0, { inbound: inbound.length, stamped, unstampedNoDecisionNoFlag: unstampedNoFlag, samples: unstampedSamples });
  const stampHist: Record<string, number> = {};
  for (const m of inbound) { const o = m.metadata?.processing?.aiResponder; const k = o ? `${o.outcome}:${String(o.reason ?? "").split(":").slice(0, 2).join(":")}` : "UNSTAMPED"; stampHist[k] = (stampHist[k] ?? 0) + 1; }
  R.line("inbound stamp histogram", Object.fromEntries(Object.entries(stampHist).sort((a, b) => b[1] - a[1])));

  // Provider accounting.
  const jevV2 = stubs.count("jev"), jevEight = stubs.count("jev_eight"), jevNine = stubs.count("jev_nine");
  const dispatched = claims.length; // inbounds that reached dispatchAiResponse (workflow or inline)
  const precheck = inbound.length - dispatched;
  R.line(`delay workflows started ${track.size}; inbounds that reached dispatch (claim rows) ${dispatched}; prechecked at webhook (STOP/DNC/hostile/legal phrases, no workflow) ${precheck}`);
  const jev429 = stubs.count("jev", (c) => c.status === 429), jev5xx = stubs.count("jev", (c) => c.status >= 500);
  R.check("Jev v2 calls = one per v2-classified inbound (no re-classification on retry/duplicate/re-executed step)", jevV2 === decisions.length,
    { jevV2Calls: jevV2, v2Decisions: decisions.length, formula_inbounds_minus_prechecks_minus_dupes: dispatched, extra: jevV2 - decisions.length, jev429, jev5xx, jevAbortedByTimeout: stubs.aborted, reexecutedSteps: reexecuted });
  R.line(`Jev nine-question calls (legacy classify-only for held/terminal leads, classifyOnlyForHotText): ${jevNine}`);
  R.line(`ADDITIONAL Jev calls by v2 path: eight-answer classification for the number-source detector = ${jevEight} (one per reply road) — not in the §3.3 formula`);
  const v2Keys = new Map<string, number>();
  const claimsNoV2 = claims.length - decisions.length;
  R.line(`claims without a v2 decision (skipped before v2: terminal/held, superseded, already replied): ${claimsNoV2}`);
  for (const c of stubs.calls.filter((x) => x.provider === "jev")) v2Keys.set(c.key, (v2Keys.get(c.key) ?? 0) + 1);
  R.line(`Jev retries: v2 askJev maxRetries=0 (dispatch.ts:8495) -> every 429/5xx is final for that inbound; failed decisions = ${decisions.filter((d) => d.status === "failed").length}`);
  const failedFlag = decisions.filter((d) => d.status === "failed");
  const failedNoFlag = failedFlag.filter((d) => !flag.get(propRows.find(() => false)?.id)?.needs_human_attention);
  void failedNoFlag;
  const failedProps = await q("select d.property_id, p.needs_human_attention, p.last_ai_escalation_reason from routing_v2_live_decisions d join properties p on p.id = d.property_id where d.status = 'failed' and d.property_id = any($1)");
  const failedUnflagged = failedProps.filter((p) => !p.needs_human_attention).length;
  R.check("every Jev-fault inbound decided or dead-lettered with a human flag", failedUnflagged === 0, { failedDecisions: failedProps.length, withoutHumanFlagNow: failedUnflagged, reasons: [...new Set(failedProps.map((p) => p.last_ai_escalation_reason))].slice(0, 6) });
  const hk = stubs.calls.filter((c) => c.provider === "haiku");
  const hRetryKeys = new Map<string, number>();
  for (const c of hk) hRetryKeys.set(c.key + "@" + Math.floor(c.at / 10000), (hRetryKeys.get(c.key + "@" + Math.floor(c.at / 10000)) ?? 0) + 1);
  R.line(`Haiku calls ${hk.length} (429s ${hk.filter((c) => c.status === 429).length}); askHaiku = 1 retry max (haiku.ts:118 loop 2 attempts); max inflight jev ${stubs.maxInflight.jev} haiku ${stubs.maxInflight.haiku} dm ${stubs.maxInflight.dealmachine}; workflow pool max ${pool.maxSeen}`);
  const dmCalls = stubs.count("dealmachine");
  const dmBilled = stubs.count("dealmachine", (c) => c.status === 200);
  const dmMax = stubs.maxPerMinute("dealmachine");
  R.check("DealMachine calls <= 60 in any rolling minute (stub log)", dmMax <= 60, { dmCalls, maxPerMinute: dmMax, http429: stubs.count("dealmachine", (c) => c.status === 429), creditOut402: stubs.count("dealmachine", (c) => c.status === 402) });
  const ledger = await q("select provider, status, count(*)::int n from provider_spend_ledger where property_id = any($1) group by 1, 2");
  const ledgerN = ledger.reduce((s, r) => s + r.n, 0);
  R.check("one spend-ledger row per DealMachine HTTP call", ledgerN === dmCalls, { ledgerRows: ledgerN, stubCalls: dmCalls, byStatus: ledger });
  const priceProps = new Set(decisions.filter((d) => d.road === "price_check").map((d) => d.property_id ?? "")).size;
  const dmProps = (await q("select count(distinct property_id)::int n from provider_spend_ledger where provider = 'dealmachine' and property_id = any($1)"))[0].n;
  R.check("DealMachine credits (HTTP 200 calls) <= distinct price-naming properties", dmBilled <= dmProps, { dmBilled, dmHttpCalls: dmCalls, distinctPropsCalled: dmProps, priceCheckProps: priceProps });
  const hTokIn = stubs.calls.filter((c) => c.provider === "haiku").length;
  R.line(`Haiku spend ledger rows: ${(await q("select count(*)::int n from provider_spend_ledger where provider <> 'dealmachine' and property_id = any($1)"))[0].n} (Jev/Haiku have no spend_ledger writer); haiku calls ${hTokIn}`);
  R.line(`unexpected LLM (non-Haiku Anthropic) calls: ${stubs.count("llm")}`);

  // Quiet hours: every mock send's recipient-local time inside 08:00-21:00.
  const qViol = mock.filter((m) => !checkRecipientQuietHours(m.to, m.createdAt).ok);
  R.check("zero sends outside 08-21 recipient-local (mock provider log, send-time clock)", qViol.length === 0, { sends: mock.length, violations: qViol.length, sample: qViol.slice(0, 5).map((m) => ({ to: m.to, at: m.createdAt.toISOString() })) });
  R.line(`sends during the 07:50 Chicago phase: ${quietSends} (allowed only where the recipient is already past 08:00 local, e.g. Eastern; per-recipient check above)`);
  const deferred = outbox.filter((o) => o.kind === "reply" && inbound.find((m) => m.id === o.inbound_message_id && track.get(m.id)?.phase === "quiet_0750"));
  R.line("replies decided during the quiet phase -> status", deferred.reduce((a: Record<string, number>, o) => { a[o.status] = (a[o.status] ?? 0) + 1; return a; }, {}));

  // Audit + provenance.
  const decided = decisions.filter((d) => d.status === "decided");
  const missingProv = decided.filter((d) => !d.provenance || !d.action);
  R.check("every decided v2 row has action + provenance", missingProv.length === 0, { decided: decided.length, missing: missingProv.length });
  const dispatchedNoDecision = [...track.keys()].filter((id) => !decByInbound.has(id));
  R.check("every dispatched inbound has a v2 audit row", dispatchedNoDecision.length === 0, { dispatched: track.size, withoutDecisionRow: dispatchedNoDecision.length,
    sampleOutcomes: dispatchedNoDecision.slice(0, 6).map((id) => track.get(id)?.outcome) });
  R.check("every inbound (incl. webhook prechecks) has a v2 audit row", inbound.every((m) => decByInbound.has(m.id)), { inbound: inbound.length, withRow: inbound.filter((m) => decByInbound.has(m.id)).length });

  // Road agreement with the v7 replay for first replies outside fault windows (no Haiku fault).
  let agree = 0, compared = 0; const dis: Record<string, number> = {};
  for (const m of inbound) {
    const t = track.get(m.id); const d = decByInbound.get(m.id);
    if (!t || !d || t.phase !== "replay" || t.fault !== "none" || d.status !== "decided") continue;
    const exp = data.expectedRoad.get(String(m.body).trim()); if (!exp) continue;
    compared++;
    if (exp === d.road || (exp.startsWith("ALERT_haiku") && d.road === null)) agree++;
    else { const k = `${exp}->${d.road}`; dis[k] = (dis[k] ?? 0) + 1; }
  }
  R.line(`road vs v7 replay (first replies, no fault): ${agree}/${compared} agree (2nd+ replies and newest-first excluded; v7 has no thread/price follow-ups)`);
  R.line("top disagreements", Object.fromEntries(Object.entries(dis).sort((a, b) => b[1] - a[1]).slice(0, 15)));
  const roads: Record<string, number> = {};
  for (const d of decisions) roads[`${d.status}:${d.road}`] = (roads[`${d.status}:${d.road}`] ?? 0) + 1;
  R.line("decision roads (all)", Object.fromEntries(Object.entries(roads).sort((a, b) => b[1] - a[1])));

  // Latency (webhook accept -> workflow decision done), JS clock.
  const lat = (pred: (t: Track) => boolean) => [...track.values()].filter((t) => t.done && pred(t)).map((t) => t.done! - t.accepted).sort((a, b) => a - b);
  const clean = lat((t) => t.fault === "none" && t.phase !== "quiet_0750");
  const faulted = lat((t) => t.fault !== "none");
  const burstLat = lat((t) => t.phase === "burst");
  R.check("p95 inbound->decision <= 60 s outside fault windows", (pct(clean, 95) ?? 0) <= 60_000, { n: clean.length, p50ms: pct(clean, 50), p95ms: pct(clean, 95), maxms: clean[clean.length - 1] });
  R.line("latency in fault windows", { n: faulted.length, p50ms: pct(faulted, 50), p95ms: pct(faulted, 95), maxms: faulted[faulted.length - 1] });
  R.line("latency during 2x burst", { n: burstLat.length, p50ms: pct(burstLat, 50), p95ms: pct(burstLat, 95), maxms: burstLat[burstLat.length - 1] });
  R.check("queue drains within 15 min after the burst", drained - burstEnd <= 15 * 60_000, { drainSeconds: Math.round((drained - burstEnd) / 1000) });
  const outcomes: Record<string, number> = {};
  for (const t of track.values()) { const o = t.outcome as { outcome?: string; reason?: string; error?: string } | undefined; const k = o?.error ? "THREW" : `${o?.outcome}:${String(o?.reason ?? "").split(":").slice(0, 2).join(":")}`; outcomes[k] = (outcomes[k] ?? 0) + 1; }
  R.line("workflow outcomes", Object.fromEntries(Object.entries(outcomes).sort((a, b) => b[1] - a[1])));
  R.line("consumer pass ms p50/p95", pct(consumerTimes.sort((a, b) => a - b), 50), pct(consumerTimes, 95));
  R.line("chaos windows (fraction of main-replay deliveries, by arrival order)", windows);
  R.line(`concurrency: webhook pool ${WEBHOOK_POOL}, workflow pool ${POOL}`);
  const byBody = new Map<string, number>();
  for (const w of webhookErrors) byBody.set(`${w.status} ${w.body}`, (byBody.get(`${w.status} ${w.body}`) ?? 0) + 1);
  R.line(`webhook non-200 by response body (${webhookErrors.length}):`, Object.fromEntries(byBody));
  R.line("reportError histogram (surface | message), top 25:", Object.fromEntries([...errHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)));
  R.check("one Jev call per v2 decision (number-source asked inside the v2 call; no eight-answer call)", jevEight === 0 && jevV2 === decisions.length, { jevV2, decisions: decisions.length, jevEight });
});
