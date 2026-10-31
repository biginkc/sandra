import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertStack, Receipt, finishNoLiveClassifier } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, type RunOrg } from "./lib/seed";
import { assertClockAligned, assertZoneQuiet, FIXTURE_ZONES } from "./lib/clock";
import { readdressToInHours } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";
void offsetToChicago;

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/** G4d (BUILD §15): DealMachine claim / expiry / negative cache / 429 storm / rate limit; Haiku timeout; ledger. */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt("G4d-providers.txt");
const pending: Promise<unknown>[] = [];
let CLOCK: { skewMs: number; local: Record<string, string> } = { skewMs: -1, local: {} };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  setClockOffset(0); // skew 0: real time only
  CLOCK = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; measured |app - DB| skew = ${Math.round(CLOCK.skewMs)} ms; local`, CLOCK.local, "; quiet fixture zone Pacific/Honolulu (HI/808)");
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4d-${Date.now()}`, { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, canary_percent: 100 });
  await retirePriorRuns(pg);
});
afterAll(async () => { finishNoLiveClassifier(); setClockOffset(0); stubs.uninstall(); await pg.end(); });

it("G4d provider controls", async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { lookupDealMachineValue, supabaseDealMachineCacheStore } = await import("@/lib/sms-classification/routing-v2/dealmachine-value");
  const { fetchDealMachineEstimatedValue } = await import("@/lib/comps/providers/dealmachine");
  const db = createTestClient();
  const leads = await seedLeads(pg, org, 120, { state: () => ({ state: "MO", fips: null }), address: (i) => `${i} Provider Ctl Ln` });
  const sleeps: number[] = [];
  const lookup = (i: number, opts: { maxWaitMs?: number } = {}) => lookupDealMachineValue(
    { orgId: BMH, propertyId: leads[i]!.propertyId, address: { street: leads[i]!.address, city: "Kansas City", state: "MO", zip: "64111" } },
    { store: supabaseDealMachineCacheStore(db), callProvider: (a, hooks) => fetchDealMachineEstimatedValue(a, { apiKey: "stub", ...hooks, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, Math.min(ms, 50))); } }), ...opts, pollIntervalMs: 100 },
  );
  const dmCalls = (street: string) => stubs.count("dealmachine", (c) => c.key === street);
  const ledger = async (p: string) => (await pg.query("select count(*)::int n from provider_spend_ledger where property_id = $1", [p])).rows[0].n;

  // 1. 20 concurrent price-namers, one property -> exactly 1 provider call.
  stubs.dmLatencyMs = 400;
  const res = await Promise.all(Array.from({ length: 20 }, () => lookup(0)));
  R.check("20 concurrent lookups for one property -> exactly 1 DealMachine call", dmCalls(leads[0]!.address) === 1,
    { calls: dmCalls(leads[0]!.address), results: res.reduce((a: Record<string, number>, r) => { const k = r.kind === "value" ? `value:${r.source}` : `no_value:${r.reason}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}), ledgerRows: await ledger(leads[0]!.propertyId) });
  stubs.dmLatencyMs = 50;

  // 2. Crash after claim: a claim that is never settled; within expiry -> 0 calls; after expiry -> reclaim, 1 call.
  await pg.query("select * from public.fn_dealmachine_value_claim($1, $2)", [leads[1]!.propertyId, BMH]);
  const during = await lookup(1, { maxWaitMs: 500 });
  const callsDuring = dmCalls(leads[1]!.address);
  await pg.query("update public.dealmachine_value_cache set claim_expires_at = now() - interval '1 second' where property_id = $1", [leads[1]!.propertyId]);
  const after = await lookup(1);
  R.check("crash after claim: no call while the claim is live; reclaim after expiry with exactly 1 more call", callsDuring === 0 && dmCalls(leads[1]!.address) === 1,
    { during, callsDuring, after, callsAfter: dmCalls(leads[1]!.address), note: "expiry simulated by moving claim_expires_at into the past (60 s claim)" });

  // 3. Negative cache -> 0 calls in the window.
  stubs.dmForce = { unmatched: true };
  const n1 = await lookup(2); const n2 = await lookup(2); const n3 = await lookup(2);
  stubs.dmForce = {};
  const neg = (await pg.query("select state, valid_until > now() + interval '29 days' v from dealmachine_value_cache where property_id = $1", [leads[2]!.propertyId])).rows[0];
  R.check("negative cache: one call, then 0 calls inside the 30-day window", dmCalls(leads[2]!.address) === 1, { calls: dmCalls(leads[2]!.address), results: [n1, n2, n3], cache: neg });

  // 4. 429 storm: <=2 retries per call, backoff waits, then backoff (no call) on the next lookup.
  stubs.dmForce = { status: 429 };
  sleeps.length = 0;
  const s1 = await lookup(3);
  const stormCalls = dmCalls(leads[3]!.address);
  const s2 = await lookup(3);
  stubs.dmForce = {};
  const ts = stubs.calls.filter((c) => c.key === leads[3]!.address).map((c) => c.at);
  R.check("429 storm: <=3 HTTP attempts (1 + <=2 retries) per lookup, waits between, next lookup in backoff (0 calls)", stormCalls <= 3 && dmCalls(leads[3]!.address) === stormCalls && sleeps.every((ms) => ms >= 500),
    { attempts: stormCalls, backoffWaitsMs: sleeps, gapsMs: ts.slice(1).map((t, i) => t - ts[i]!), first: s1, second: s2, ledgerRows: await ledger(leads[3]!.propertyId) });

  // 5. Global <=60/min: 80 distinct properties at once.
  stubs.dmWindow = [];
  const t0 = Date.now();
  const many = await Promise.all(Array.from({ length: 80 }, (_, k) => lookup(10 + k)));
  const inBurst = stubs.calls.filter((c) => c.provider === "dealmachine" && c.at >= t0).length;
  const ledgerStarted = (await pg.query("select count(*)::int n from provider_spend_ledger where provider = 'dealmachine' and started_at > now() - interval '60 seconds'")).rows[0].n;
  R.check("80 distinct properties at once: <=60 DealMachine calls in the minute (shared ledger slot)", inBurst <= 60,
    { httpCalls: inBurst, ledgerRowsLastMinute: ledgerStarted, rateLimitedNoValue: many.filter((r) => r.kind === "no_value" && /rate/.test(r.reason)).length, http429FromProvider: stubs.count("dealmachine", (c) => c.at >= t0 && c.status === 429) });

  // 6. Every DealMachine call has one ledger row.
  const allProps = leads.map((l) => l.propertyId);
  const lrows = (await pg.query("select count(*)::int n from provider_spend_ledger where property_id = any($1)", [allProps])).rows[0].n;
  const scalls = stubs.count("dealmachine");
  R.check("one spend_ledger row per DealMachine HTTP call", lrows === scalls, { ledgerRows: lrows, httpCalls: scalls });
  const jh = (await pg.query("select provider, count(*)::int n from provider_spend_ledger group by 1")).rows;
  R.line("spend_ledger providers present in the whole stack:", jh, "— no Jev or Haiku ledger writer exists (grep: only dealmachine-value.ts calls fn_provider_attempt_start)");

  // 7. Haiku timeout (10 s) -> escalate (hold + alert), no reply sent.
  stubs.haikuDelayMs = 12_000;
  stubs.jevOverride = (r) => r.includes("BORDER") ? { not_interested: 0.55 } : null;
  const lead = leads[100]!;
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const before = getMockMessageLog().filter((m) => m.to === lead.phone).length;
  const tStart = Date.now();
  await deliverWebhook({ externalId: `${org.runId}-haiku-timeout`, from: lead.phone, to: org.sender, body: "BORDER not sure about selling right now" });
  while (pending.length) await Promise.all(pending.splice(0));
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  await runRoutingV2OutboxReplies(db, { limit: 20 });
  stubs.haikuDelayMs = 0; stubs.jevOverride = null;
  const dec = (await pg.query("select road, status, haiku, action from routing_v2_live_decisions where property_id = $1", [lead.propertyId])).rows[0];
  const box = (await pg.query("select kind, status, payload->>'reason' reason from routing_v2_outbox where property_id = $1", [lead.propertyId])).rows;
  const prop = (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [lead.propertyId])).rows[0];
  const sent = getMockMessageLog().filter((m) => m.to === lead.phone).length - before;
  R.check("Haiku timeout -> escalate (hold + 'Haiku error' alert), no seller send", dec?.road === "haiku_error" && sent === 0 && prop.needs_human_attention === true,
    { tookMs: Date.now() - tStart, haikuAttempts: stubs.count("haiku", (c) => c.key.includes("BORDER")), decision: { road: dec?.road, haiku: dec?.haiku }, outbox: box, prop, sent });
});

it("outbox crash recovery + >200 owner alerts paged", async () => {
  const R2 = new Receipt("G4d-outbox-crash-and-alert-paging.txt");
  const { createTestClient } = await import("@tests/integration/client");
  const { deliverRoutingV2OutboxReply, runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { getMockMessageLog, MockMessagingProvider } = await import("@/lib/messaging/providers/mock");
  const { loadV2OutboxAlerts } = await import("@/lib/hold-alerts/v2-outbox-alerts");
  const db = createTestClient();
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const settleAll = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  // Queue a reply that waits (recipient quiet hours: 05:00 in CA), then open the window.
  const queueReply = async (tag: string) => {
    const [lead] = await seedLeads(pg, org, 1, { state: () => ({ state: "HI", fips: null }) });
    stubs.jevOverride = () => ({ text_only: 0.95 });
    assertZoneQuiet("Pacific/Honolulu"); // HI lead: recipient quiet hours at real time (was a 07:00-Chicago JS shift)
    await deliverWebhook({ externalId: `${org.runId}-crash-${tag}`, from: lead!.phone, to: org.sender, body: `text only please ${tag}` });
    await settleAll();
    await new Promise((r) => setTimeout(r, 1500)); // detached kick: waits on quiet hours, never claims
    stubs.jevOverride = null;
    await readdressToInHours(pg, lead!); // window "opens" by re-addressing, not by moving the clock
    const row = (await pg.query("select id, org_id, property_id, inbound_message_id, kind, payload, created_at::text, status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead!.propertyId])).rows[0];
    return { lead: lead!, row };
  };
  const backdate = async (id: string, mins: number) => {
    await pg.query(`update public.routing_v2_outbox set claimed_at = claimed_at - interval '${mins} minutes', authorized_at = authorized_at - interval '${mins} minutes', created_at = created_at - interval '${mins} minutes' where id = $1`, [id]);
  };
  const state = async (id: string, p: string) => ({
    outbox: (await pg.query("select status, cancel_reason, delivery_state, hold_pending, provider_receipt is not null receipt from routing_v2_outbox where id = $1", [id])).rows[0],
    prop: (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [p])).rows[0],
  });

  // (a) Crash after claim, before the provider call.
  {
    const { lead, row } = await queueReply("a");
    await pg.query("select public.routing_v2_claim_outbox($1)", [row.id]);
    await backdate(row.id, 10);
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    const st = await state(row.id, lead.propertyId);
    R2.check("(a) crash after claim, before provider: released and sent exactly once (or surfaced to a person)", sends(lead.phone) === 1 || (sends(lead.phone) === 0 && st.prop.needs_human_attention), { sends: sends(lead.phone), ...st, initialStatus: row.status });
  }
  // (b) Crash after the provider accepted, before mark-sent.
  {
    const { lead, row } = await queueReply("b");
    let crashed = false;
    const crashing = new Proxy(db, { get(t, p) {
      if (p === "rpc") return (fn: string, args: Record<string, unknown>) => {
        if (fn === "routing_v2_mark_outbox_sent" && !crashed) { crashed = true; return Promise.reject(new Error("simulated crash before mark sent")); }
        return (t as unknown as { rpc: (f: string, a: unknown) => unknown }).rpc(fn, args);
      };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    let threw = "";
    try { await deliverRoutingV2OutboxReply(crashing as typeof db, row); } catch (e) { threw = String(e); }
    const afterCrash = await state(row.id, lead.propertyId);
    await backdate(row.id, 10);
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    const st = await state(row.id, lead.propertyId);
    R2.check("(b) crash after provider call, before mark sent: reconciled to sent from the keyed message, never sent twice", sends(lead.phone) === 1 && st.outbox.status === "sent", { crashed, threw: threw.slice(0, 80), afterCrash, sends: sends(lead.phone), ...st });
  }
  // (c) Unknown delivery (provider never answers): surfaces to a person, never resent.
  {
    const { lead, row } = await queueReply("c");
    const realSend = MockMessagingProvider.prototype.sendSms;
    process.env.AI_RESPONDER_SEND_TIMEOUT_MS = "300";
    MockMessagingProvider.prototype.sendSms = function () { return new Promise(() => undefined); } as typeof realSend;
    let r1: unknown;
    try { r1 = await deliverRoutingV2OutboxReply(db, row); } finally { MockMessagingProvider.prototype.sendSms = realSend; delete process.env.AI_RESPONDER_SEND_TIMEOUT_MS; }
    const afterTimeout = await state(row.id, lead.propertyId);
    await backdate(row.id, 40);
    await pg.query("update public.messages set created_at = created_at - interval '40 minutes' where idempotency_key = $1", [row.id]);
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    const st = await state(row.id, lead.propertyId);
    const keyed = (await pg.query("select status from messages where idempotency_key = $1", [row.id])).rows;
    R2.check("(c) unknown delivery: never resent; held for a person (unknown:held_for_person, property flagged)", sends(lead.phone) === 0 && st.prop.needs_human_attention === true && st.outbox.status !== "pending",
      { firstAttempt: r1, afterTimeout, keyedMessage: keyed, sends: sends(lead.phone), ...st });
  }

  // >200 owner alerts queued -> all paged.
  const N = 250;
  const leads = await seedLeads(pg, org, N, { state: () => ({ state: "MO", fips: null }), address: (i) => `${i} Alert Page Way` });
  stubs.jevOverride = () => ({ asked_call: 0.95 });
  const since = (await pg.query("select (now() - interval '5 minutes')::text t")).rows[0].t as string;
  for (let i = 0; i < N; i += 25) {
    await Promise.all(leads.slice(i, i + 25).map((l, k) => deliverWebhook({ externalId: `${org.runId}-page-${i + k}`, from: l.phone, to: org.sender, body: "call me at 3 please" })));
    await settleAll();
  }
  stubs.jevOverride = null;
  const queued = (await pg.query("select count(*)::int n from routing_v2_outbox where kind = 'alert' and property_id = any($1)", [leads.map((l) => l.propertyId)])).rows[0].n;
  const owner = (await pg.query("select gen_random_uuid() id")).rows[0].id;
  const res = await loadV2OutboxAlerts(db as never, BMH, new Date(since).toISOString(), Date.now(), owner);
  const mine = new Set(leads.map((l) => l.propertyId));
  const paged = res.promotions.filter((p) => mine.has((p as { propertyId?: string }).propertyId ?? "")).length;
  R2.check(">200 owner alerts queued -> all returned by the paged loader", queued >= 200 && paged === queued && res.complete, { queued, pagedForTheseLeads: paged, promotionsTotal: res.promotions.length, complete: res.complete });
});

it("lease-death sweep: an inbound whose webhook died is held for a person once, never sent", async () => {
  const R3 = new Receipt("G4d-lease-death-sweep.txt");
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const db = createTestClient();
  const leads = await seedLeads(pg, org, 3, { state: () => ({ state: "MO", fips: null }), address: (i) => `${i} Lease Death Ct` });
  // Saved by a webhook that then died: message row only (no stamp, claim, keyword exit, decision or audit row), 10 min old.
  const ids: string[] = [];
  for (const l of leads) {
    const { rows } = await pg.query(`insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at)
      values ($1, 'sms', 'inbound', 'received', $2, $3, $4, $5, 'are you still buying?', now() - interval '10 minutes') returning id`, [BMH, l.propertyId, l.contactId, l.phone, org.sender]);
    ids.push(rows[0].id);
  }
  // Read-error injection: the sweep's flag / config reads fail -> no mark, no hold, nothing claimed as held.
  const { sweepUnstampedV2Inbounds } = await import("@/lib/ai-responder/dispatch");
  const failing = (): unknown => {
    const err = { data: null, error: { message: "injected read error", code: "XX000" } };
    const chain: Record<string, unknown> = {};
    const h: ProxyHandler<object> = { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res(err) : () => new Proxy(chain, h)) };
    return new Proxy(chain, h);
  };
  const broken = new Proxy(db, { get(t, k) {
    if (k === "from") return (table: string) => (table === "ai_responder_configs" ? failing() : (t as unknown as { from: (x: string) => unknown }).from(table));
    const v = (t as unknown as Record<string | symbol, unknown>)[k];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  const heldOnError = await sweepUnstampedV2Inbounds(broken as typeof db, Date.now());
  const afterErr = (await pg.query("select p.needs_human_attention nh, m.metadata->'processing'->'routingV2Sweep' mark from messages m join properties p on p.id = m.property_id where m.id = any($1)", [ids])).rows;
  const auditErr = (await pg.query("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = any($1)", [ids])).rows[0].n;
  R3.check("read-error injection (flags/config reads fail): sweep holds 0, marks nothing, writes no audit row", heldOnError === 0 && afterErr.every((r) => !r.nh && (r.mark === null || r.mark === undefined)) && auditErr === 0,
    { heldOnError, afterErr, auditRows: auditErr });
  const before = getMockMessageLog().length;
  const r1 = await runRoutingV2OutboxReplies(db, { limit: 50 });
  const r2 = await runRoutingV2OutboxReplies(db, { limit: 50 });
  const props = (await pg.query("select id, needs_human_attention, last_ai_escalation_reason from properties where id = any($1)", [leads.map((l) => l.propertyId)])).rows;
  const audit = (await pg.query("select inbound_message_id, status, failure_reason from routing_v2_live_decisions where inbound_message_id = any($1)", [ids])).rows;
  const marks = (await pg.query("select id, metadata->'processing'->'routingV2Sweep' mark from messages where id = any($1)", [ids])).rows;
  R3.check("dead-webhook inbounds: each lead held for a person, exactly one audit row per text, marked, zero sends, second pass holds nothing new",
    props.every((p) => p.needs_human_attention) && audit.length === ids.length && new Set(audit.map((a) => a.inbound_message_id)).size === ids.length && getMockMessageLog().length === before && ((r2 as { held?: number }).held ?? 0) === 0,
    { pass1Held: (r1 as { held?: number }).held, pass2Held: (r2 as { held?: number }).held, props, audit, marks, sends: getMockMessageLog().length - before });
});
