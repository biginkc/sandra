import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertClockAligned, FIXTURE_ZONES } from "./lib/clock";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { assertStack, finishNoLiveClassifier, headSha, Receipt } from "./lib/env";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, setFlags, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));
// F6 parking: dispatch kicks an inline outbox consumer through next/server after() (falling back to a
// detached promise outside a request). That consumer raced the test's own consumer and was caught
// mid-send ("claimed, never sent"). Only while PARK_AFTER.on is set, after() tasks are dropped, i.e. the
// inline kick is lost and the cron consumer (the test's call) is the one that delivers. Otherwise the
// mock throws exactly as after() does outside a request scope, so every other lane is unchanged.
const PARK_AFTER = vi.hoisted(() => ({ on: false, dropped: 0 }));
vi.mock("next/server", async (o) => ({
  ...((await o()) as object),
  after: (_task: unknown) => { if (PARK_AFTER.on) { PARK_AFTER.dropped++; return; } throw new Error("after() outside a request scope (stress mock)"); },
}));

/**
 * F1 fence race: a hold committed between the outbox authorize step and the provider fence (real path; the app's own
 *   test barrier "outbox:before_fence" in src/lib/ai-responder/dispatch.ts, the hold written through the app's hold
 *   writer routing_v2_write_hold(…, 'keyword:legal_contract', 'safety')). Expect: reply cancelled, 0 provider calls.
 * F2 flags off after a mechanics hold: TONLY twice (template_already_sent mechanics hold), then routing_v2_flags = {}
 *   (all off), then the next seller text "NOTINT actually never mind". Expect a terminal outcome, 0 sends, no drip.
 * Existing fixture texts only. x N (default 20), fresh MO lead each, real time, skew guarded.
 */
const N = Number(process.env.F_N ?? 20);
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt("G4g-fence-flags-F1-F2-F3.txt");
const pending: Promise<unknown>[] = [];
const FLAGS = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, model_stop_suppression: true, wrong_number_all: true, canary_percent: 100 };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  const clock = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; |app - DB| skew = ${Math.round(clock.skewMs)} ms; local`, clock.local);
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `f12-${Date.now()}`, FLAGS);
  await retirePriorRuns(pg);
  stubs.jevOverride = (r) => r.includes("TONLY") ? { text_only: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : null;
});
afterAll(async () => { finishNoLiveClassifier(); stubs.uninstall(); await setFlags(pg, BMH, {}); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

it(`F1 / F2 x${N}`, async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { setTestBarrier, clearTestBarriers, setTestFault } = await import("@/lib/testing/test-barriers");
  const db = createTestClient();
  let n = 0;
  const ext = () => `${org.runId}-f-${n++}`;
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const fresh = async () => (await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), address: () => `${n} Fence Ct` }))[0]!;
  const say = async (l: Lead, body: string) => { await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body }); await settle(); await pause(300); await runRoutingV2OutboxReplies(db, { limit: 50 }); await pause(300); };

  // F1
  {
    let pass = 0; const modes: Record<string, number> = {}; let calls = 0;
    for (let i = 0; i < N; i++) {
      await setFlags(pg, BMH, FLAGS);
      const l = await fresh();
      let fired = 0;
      setTestBarrier("outbox:before_fence", async (ctx) => {
        if (ctx.propertyId !== l.propertyId) return;
        fired++;
        await pg.query("select public.routing_v2_write_hold($1, $2, 'keyword:legal_contract', 'safety')", [l.propertyId, ctx.inboundMessageId]);
      });
      await say(l, "TONLY text only please");
      clearTestBarriers();
      const box = (await pg.query("select id, status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply'", [l.propertyId])).rows[0];
      const keyed = box ? (await pg.query("select status from messages where idempotency_key = $1", [box.id])).rows : [];
      const p = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
      const s = sends(l.phone); calls += s;
      const ok = fired >= 1 && s === 0 && box?.status === "cancelled";
      if (ok) pass++;
      const k = `${ok ? "PASS" : "FAIL"} barrier=${fired} outbox=${box?.status}:${box?.cancel_reason ?? ""} keyedRows=${keyed.map((x) => x.status).join("/") || 0} providerCalls=${s} hold=${p.nh ? p.r : "-"}`;
      modes[k] = (modes[k] ?? 0) + 1;
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} F1 fence race (hold committed at outbox:before_fence): ${pass}/${N}; provider calls ${calls}`);
    R.line("   modes", modes);
  }
  // F2
  {
    let pass = 0; const modes: Record<string, number> = {}; let totalSends = 0;
    for (let i = 0; i < N; i++) {
      await setFlags(pg, BMH, FLAGS);
      const l = await fresh();
      await say(l, "TONLY text only please");
      await say(l, "TONLY text only please");
      const a = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
      const sAtA = sends(l.phone);
      await setFlags(pg, BMH, {});
      await say(l, "NOTINT actually never mind");
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
      await runSequenceTick(db as never, { budgetMs: 20_000 });
      const st = (await pg.query("select metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [l.propertyId])).rows[0];
      const c = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
      const enr = (await pg.query("select status from sequence_enrollments where property_id = $1", [l.propertyId])).rows;
      const extra = sends(l.phone) - sAtA; totalSends += extra;
      const terminal = !!st?.o && st.o !== "pending";
      const ok = terminal && extra === 0 && !enr.some((e) => e.status === "active");
      if (ok) pass++;
      const k = `${ok ? "PASS" : "FAIL"} A=${a.nh ? String(a.r).split(":").slice(0, 2).join(":") : "-"} C-stamp=${st?.o}:${String(st?.r).split(":").slice(0, 2).join(":")} hold=${c.nh ? String(c.r).split(":").slice(0, 2).join(":") : "-"} sendsAfterA=${extra} enr=${enr.map((e) => e.status).join("/") || 0}`;
      modes[k] = (modes[k] ?? 0) + 1;
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} F2 flags off after a mechanics hold, then the next text: ${pass}/${N}; sends after the hold ${totalSends}`);
    R.line("   modes", modes);
  }
  // F3: mechanics hold, then on text B the one-shot "dispatch:v2_live_read" fault (the app's own test fault).
  {
    await setFlags(pg, BMH, FLAGS);
    let pass = 0; const modes: Record<string, number> = {}; let totalSends = 0;
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      await say(l, "TONLY text only please");
      await say(l, "TONLY text only please");
      const a = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
      const sAtA = sends(l.phone);
      const nineBefore = stubs.count("jev_nine", (c) => c.key.startsWith("NOTINT actually never mind"));
      setTestFault("dispatch:v2_live_read", (ctx) => ctx.propertyId === l.propertyId);
      await say(l, "NOTINT actually never mind");
      clearTestBarriers();
      const b = (await pg.query("select id, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [l.propertyId])).rows[0];
      const p = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
      const alerts = (await pg.query("select payload->>'reason' reason, status from routing_v2_outbox where inbound_message_id = $1 and kind = 'alert'", [b.id])).rows;
      const audit = (await pg.query("select m.id, (select count(*)::int from routing_v2_live_decisions d where d.inbound_message_id = m.id) n, (select status || ':' || coalesce(failure_reason, '') from routing_v2_live_decisions d where d.inbound_message_id = m.id limit 1) s from messages m where m.property_id = $1 and m.direction = 'inbound'", [l.propertyId])).rows;
      const nineRuns = stubs.count("jev_nine", (c) => c.key.startsWith("NOTINT actually never mind")) - nineBefore;
      const legacyStamp = /^nine_questions:/.test(b.r ?? "");
      const extra = sends(l.phone) - sAtA; totalSends += extra;
      const ok = p.nh === true && extra === 0 && !legacyStamp && audit.every((x) => x.n === 1);
      if (ok) pass++;
      const k = `${ok ? "PASS" : "FAIL"} A=${a.nh ? String(a.r).split(":").slice(0, 2).join(":") : "-"} B-stamp=${b.o}:${b.r} hold=${p.nh ? p.r : "-"} outboxAlerts=${alerts.map((x) => `${x.reason}:${x.status}`).join(",") || 0} nineQuestionJevCalls=${nineRuns} sends=${extra} audit=${audit.map((x) => x.n).join("")} Baudit=${audit[audit.length - 1]?.s}`;
      modes[k] = (modes[k] ?? 0) + 1;
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} F3 mechanics hold + one-shot dispatch:v2_live_read fault on text B: ${pass}/${N}; sends ${totalSends}`);
    R.line("   modes", Object.fromEntries(Object.entries(modes).map(([k, v]) => [k.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>"), v])));
  }
  await setFlags(pg, BMH, FLAGS);
});

/**
 * F4-F7 baselines (round-14 queue). Hooks: F4/F7 = the app's own barrier "dispatch:before_transition" (throws = crash
 * after the v2 decision row is persisted, before transition/hold); F5 = "outbox:before_hold" (throws = crash after
 * routing_v2_mark_outbox_not_sent committed the cancel, before writeV2Hold); F6 = vi fake Date (whole app clock) around the consumer call only, inline after() consumer parked, the row
 * aged by backdating routing_v2_outbox.created_at in SQL. Ages of the crashed claim/inbound for the sweep are backdated
 * in SQL (DB clock untouched). Existing fixture texts only.
 */
const R2 = new Receipt("G4g-F4-F5-F6-F7.txt");
it(`F4 / F5 / F6 / F7 x${N}`, async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { setTestBarrier, clearTestBarriers } = await import("@/lib/testing/test-barriers");
  const { loadFreshSeen } = await import("@/app/(dashboard)/messages-v2/hold-seen");
  const db = createTestClient();
  await setFlags(pg, BMH, FLAGS);
  let n = 0;
  const ext = () => `${org.runId}-f47-${n++}`;
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const fresh = async () => (await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), address: () => `${n} Crash Ct` }))[0]!;
  const sweep = async () => { try { await runRoutingV2OutboxReplies(db, { limit: 50 }); } catch (e) { return String(e); } return null; };
  const say = async (l: Lead, body: string) => { await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body }); await settle(); await pause(300); const e = await sweep(); await pause(300); return e; };
  const prop = async (id: string) => (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [id])).rows[0];
  const lastIn = async (id: string) => (await pg.query("select id, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [id])).rows[0];
  const decisions = async (mid: string) => (await pg.query("select status, coalesce(failure_reason,'') fr from routing_v2_live_decisions where inbound_message_id = $1", [mid])).rows;
  const claim = async (mid: string) => (await pg.query("select status, outcome, error_message em from ai_response_claims where inbound_message_id = $1", [mid])).rows[0];
  const ageCrashed = async (mid: string) => {
    await pg.query("update messages set created_at = now() - interval '1 hour' where id = $1", [mid]);
    await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 hour' where inbound_message_id = $1 and status = 'processing'", [mid]);
  };
  const crashAtTransition = (pid: string) => {
    let fired = 0;
    setTestBarrier("dispatch:before_transition", async (ctx) => { if (ctx.propertyId !== pid || fired) return; fired++; throw new Error("stress-crash:before_transition"); });
    return () => fired;
  };
  const sh = (s: unknown) => String(s ?? "-").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>");
  const tally = (modes: Record<string, number>, k: string) => { modes[k] = (modes[k] ?? 0) + 1; };
  const verdict = (pass: number) => (pass === N ? "PASS" : "FAIL");
  R2.line(`head under test: ${headSha()}`);

  // F4: crash after the decision persists, before transition/hold; sweep; later text held, 0 sends.
  {
    let pass = 0; const modes: Record<string, number> = {}; let total = 0;
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      const fired = crashAtTransition(l.propertyId);
      await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "TONLY text only please" }); await settle();
      clearTestBarriers();
      const a = await lastIn(l.propertyId); const d = await decisions(a.id); const c0 = await claim(a.id);
      await ageCrashed(a.id); const err = await sweep();
      const afterSweep = await prop(l.propertyId);
      const s0 = sends(l.phone);
      await say(l, "NOTINT actually never mind");
      const b = await lastIn(l.propertyId); const p = await prop(l.propertyId);
      const s = sends(l.phone); total += s;
      const ok = fired() === 1 && afterSweep.nh === true && p.nh === true && s === 0;
      if (ok) pass++;
      tally(modes, `${ok ? "PASS" : "FAIL"} barrier=${fired()} decision=${d.map((x) => `${x.status}:${x.fr}`).join(",") || 0} claim=${c0?.status}:${sh(c0?.outcome)}:${sh(c0?.em)} A-stamp=${a.o}:${sh(a.r)} sweepErr=${err ? "y" : "n"} holdAfterSweep=${afterSweep.nh ? afterSweep.r : "-"} sendsBeforeB=${s0} B-stamp=${b.o}:${sh(b.r)} hold=${p.nh ? p.r : "-"} sends=${s}`);
    }
    R2.line(`${verdict(pass)} F4 crash at dispatch:before_transition (decision persisted, no hold) -> sweep -> later text: ${pass}/${N}; sends ${total}`);
    R2.line("   modes", modes);
  }
  // F5: TONLY (sent), TONLY again -> cancel committed (template_already_sent) -> crash at outbox:before_hold; tick; sweep.
  {
    let pass = 0; const modes: Record<string, number> = {}; let total = 0;
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      await say(l, "TONLY text only please");
      const s1 = sends(l.phone);
      let fired = 0;
      setTestBarrier("outbox:before_hold", async (ctx) => { if (ctx.propertyId !== l.propertyId || fired) return; fired++; throw new Error("stress-crash:before_hold"); });
      const e2 = await say(l, "TONLY text only please");
      clearTestBarriers();
      const box = (await pg.query("select status, cancel_reason, hold_pending from routing_v2_outbox where property_id = $1 and kind = 'reply' order by created_at desc limit 1", [l.propertyId])).rows[0];
      const pCrash = await prop(l.propertyId);
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
      await runSequenceTick(db as never, { budgetMs: 20_000 });
      const sTick = sends(l.phone) - s1;
      const err = await sweep();
      const box2 = (await pg.query("select status, cancel_reason, hold_pending from routing_v2_outbox where property_id = $1 and kind = 'reply' order by created_at desc limit 1", [l.propertyId])).rows[0];
      const p = await prop(l.propertyId);
      const enr = (await pg.query("select status from sequence_enrollments where property_id = $1", [l.propertyId])).rows;
      const s = sends(l.phone) - s1; total += s;
      const ok = fired === 1 && sTick === 0 && p.nh === true && s === 0;
      if (ok) pass++;
      tally(modes, `${ok ? "PASS" : "FAIL"} barrier=${fired} crashSurfaced=${e2 ? "y" : "n"} outboxAtCrash=${box?.status}:${box?.cancel_reason}:hold_pending=${box?.hold_pending} holdAtCrash=${pCrash.nh ? pCrash.r : "-"} tickSends=${sTick} sweepErr=${err ? "y" : "n"} outboxAfter=${box2?.status}:${box2?.cancel_reason}:hold_pending=${box2?.hold_pending} hold=${p.nh ? p.r : "-"} enr=${enr.map((x) => x.status).join("/") || 0} sendsAfterFirst=${s}`);
    }
    R2.line(`${verdict(pass)} F5 cancel committed then crash at outbox:before_hold -> tick -> sweep: ${pass}/${N}; sends after the first reply ${total}`);
    R2.line("   modes", modes);
  }
  // F6: reply expiry vs DB age with only the app clock skewed.
  for (const sc of [{ name: "a", ageH: 23.5, skewH: 1, wantExpire: false }, { name: "b", ageH: 24.5, skewH: -1, wantExpire: true }]) {
    let pass = 0; const modes: Record<string, number> = {}; let total = 0;
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      // Park the queued reply: deliver the text and let its dispatch finish, but run no outbox consumer.
      PARK_AFTER.on = true; const dropped0 = PARK_AFTER.dropped;
      await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "TONLY text only please" }); await settle(); await pause(300);
      PARK_AFTER.on = false; const parked = PARK_AFTER.dropped - dropped0;
      const before = (await pg.query("select id, status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply' order by created_at desc limit 1", [l.propertyId])).rows[0];
      const s0 = sends(l.phone);
      await pg.query("update routing_v2_outbox set created_at = now() - make_interval(secs => $2), status = case when status = 'claimed' then 'queued' else status end where id = $1", [before?.id, Math.round(sc.ageH * 3600)]);
      const ready = (await pg.query("select status from routing_v2_outbox where id = $1", [before?.id])).rows[0];
      // App clock skew = the whole app process's clock (a server whose clock is off): vi fake Date for
      // the consumer call only. The inline after() consumer is parked above, so only this consumer runs.
      // (runRoutingV2OutboxReplies opts.now is not threaded into deliverRoutingV2OutboxReply's expiry
      // read at a0c9, so the seam alone would not skew the expiry decision.)
      const skewMs = sc.skewH * 3600_000;
      let err: string | null = null; let res = "-";
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + skewMs);
      try { const out = await runRoutingV2OutboxReplies(db, { propertyId: l.propertyId, limit: 5 }); res = out.results.map((x) => JSON.stringify(x.result)).join("|") || "none"; } catch (e) { err = String(e); }
      vi.useRealTimers();
      await assertClockAligned(pg, FIXTURE_ZONES);
      const after = (await pg.query("select status, cancel_reason, hold_pending from routing_v2_outbox where id = $1", [before?.id])).rows[0];
      const p = await prop(l.propertyId);
      const s = sends(l.phone) - s0; total += s;
      const expired = after?.status === "cancelled" && /expired/.test(after?.cancel_reason ?? "");
      const sentOk = after?.status === "sent" && s === 1;
      const ok = parked >= 1 && before?.status === "pending" && (sc.wantExpire ? expired && (after.hold_pending === true || (p.nh === true && /expired/.test(p.r ?? ""))) && s === 0 : sentOk);
      if (ok) pass++;
      tally(modes, `${ok ? "PASS" : "FAIL"} parkedInlineKicks=${parked} before=${before?.status}:${before?.cancel_reason ?? ""} ready=${ready?.status} consumer=${res} err=${err ? sh(err).slice(0, 60) : "n"} after=${after?.status}:${after?.cancel_reason ?? ""}:hold_pending=${after?.hold_pending} hold=${p.nh ? p.r : "-"} sends=${s}`);
    }
    R2.line(`${verdict(pass)} F6${sc.name} DB age ${sc.ageH} h, app clock ${sc.skewH > 0 ? "+" : ""}${sc.skewH} h -> ${sc.wantExpire ? "must expire + hold_pending, 0 sends" : "must NOT expire: sent once"}: ${pass}/${N}; sends ${total}`);
    R2.line("   modes", modes);
  }
  // F7: crash after decision persist; sweep; a person dismisses through fn_resolve_hold (the app's clear path); new ordinary text routes normally.
  {
    // The fresh stack has no members: a run-owned stress owner (auth user + owner membership in the BMH org) is the person.
    const user = "00000000-0000-4000-8000-00000000f7f7";
    await pg.query("insert into auth.users (id, email, aud, role) values ($1, 'stress-f7-owner@example.test', 'authenticated', 'authenticated') on conflict (id) do nothing", [user]);
    await pg.query("insert into public.memberships (user_id, org_id, role) select $1, $2, 'owner' where not exists (select 1 from public.memberships where user_id = $1 and org_id = $2)", [user, BMH]);
    let pass = 0; const modes: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      const fired = crashAtTransition(l.propertyId);
      await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "NOTINT actually never mind" }); await settle();
      clearTestBarriers();
      const a = await lastIn(l.propertyId);
      await ageCrashed(a.id); await sweep();
      const held = await prop(l.propertyId);
      let clearRes = "skipped:not_held";
      if (held.nh && user) {
        const seen = (await loadFreshSeen(db as never, BMH, [l.propertyId]))?.get(l.propertyId);
        const r = await pg.query("select public.fn_resolve_hold($1,$2,$3,'dismiss','stress F7 cleared by person',$4,$5,$6) x", [BMH, l.propertyId, user, seen?.through ?? null, seen?.flagReason ?? null, seen?.flagAt ?? null]).catch((e) => ({ rows: [{ x: { error: String(e) } }] }));
        clearRes = sh(JSON.stringify(r.rows[0]?.x)).slice(0, 80);
      }
      const cleared = await prop(l.propertyId);
      const s0 = sends(l.phone);
      await say(l, "TONLY text only please");
      const b = await lastIn(l.propertyId); const d = await decisions(b.id); const p = await prop(l.propertyId);
      const enr = (await pg.query("select status from sequence_enrollments where property_id = $1 and status = 'active'", [l.propertyId])).rows.length;
      const s = sends(l.phone) - s0;
      const ok = fired() === 1 && held.nh === true && cleared.nh === false && d.length === 1 && p.nh === false && (s >= 1 || enr >= 1);
      if (ok) pass++;
      tally(modes, `${ok ? "PASS" : "FAIL"} barrier=${fired()} holdAfterSweep=${held.nh ? held.r : "-"} clear=${clearRes} afterClear=${cleared.nh ? cleared.r : "clear"} B-stamp=${b.o}:${sh(b.r)} Baudit=${d.length}:${d.map((x) => x.status).join(",")} hold=${p.nh ? p.r : "-"} sends=${s} activeDrips=${enr}`);
    }
    R2.line(`${verdict(pass)} F7 crash at decision persist -> sweep -> person dismisses (fn_resolve_hold) -> ordinary TONLY routes normally: ${pass}/${N}`);
    R2.line("   modes", modes);
  }
  await setFlags(pg, BMH, FLAGS);
});

/**
 * F8-F10 baselines (round 16, Astra findings). Run alone with RECEIPT_SUFFIX set so the F1-F7 receipts are not rewritten.
 * Safety decision = existing fixture "You can talk to my lawyer about it" (M15 keyword:legal_contract) — the hold road has
 * no app barrier after the decision, so the worker "death" is the hold write raising: a temporary per-lead trigger on
 * properties (raise when needs_human_attention flips to true for a lead listed in stress_hold_fail). F8 drops the trigger
 * after the crash (cron DOWN: no sweep, no outbox consumer; claim + inbound backdated 2 h in SQL), F9 keeps it through B.
 * B = "TONLY text only please". F10 = M16 rep SMS row, seller reply handled with the app clock -1 h (fake Date only).
 */
it(`F8 / F9 / F10 x${N}`, async () => {
  const R3 = new Receipt("G4g-F8-F9-F10.txt");
  const c = await assertClockAligned(pg, FIXTURE_ZONES);
  R3.line(`clock: NO shift; |app - DB| skew = ${Math.round(c.skewMs)} ms; local`, c.local);
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  await setFlags(pg, BMH, FLAGS);
  let n = 0;
  const ext = () => `${org.runId}-f810-${n++}`;
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const fresh = async () => (await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), address: () => `${n} Dead Ct` }))[0]!;
  const prop = async (id: string) => (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [id])).rows[0];
  const lastIn = async (id: string) => (await pg.query("select id, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [id])).rows[0];
  const claim = async (mid: string) => (await pg.query("select status, outcome, error_message em from ai_response_claims where inbound_message_id = $1", [mid])).rows[0];
  const dec = async (mid: string) => (await pg.query("select status from routing_v2_live_decisions where inbound_message_id = $1", [mid])).rows.map((x) => x.status).join(",") || "0";
  const drips = async (id: string) => (await pg.query("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [id])).rows[0].n;
  const sh = (s: unknown) => String(s ?? "-").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").slice(0, 90);
  const verdict = (p: number) => (p === N ? "PASS" : "FAIL-expected-at-b6a0");
  await pg.query(`create table if not exists public.stress_hold_fail (property_id uuid primary key);
    create or replace function public.stress_hold_fail_fn() returns trigger language plpgsql as $$ begin
      if new.needs_human_attention and not coalesce(old.needs_human_attention, false) and exists (select 1 from public.stress_hold_fail f where f.property_id = new.id)
      then raise exception 'stress: hold write failed'; end if; return new; end $$;
    drop trigger if exists stress_hold_fail_trg on public.properties;
    create trigger stress_hold_fail_trg before update on public.properties for each row execute function public.stress_hold_fail_fn();`);
  try {
    for (const which of ["F8", "F9"] as const) {
      let pass = 0; const modes: Record<string, number> = {}; let total = 0;
      for (let i = 0; i < N; i++) {
        const l = await fresh();
        await pg.query("insert into public.stress_hold_fail values ($1) on conflict do nothing", [l.propertyId]);
        await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "You can talk to my lawyer about it" }); await settle();
        const a = await lastIn(l.propertyId); const ca = await claim(a.id); const da = await dec(a.id); const pa = await prop(l.propertyId);
        if (which === "F8") {
          await pg.query("delete from public.stress_hold_fail where property_id = $1", [l.propertyId]);
          await pg.query("update messages set created_at = now() - interval '2 hours' where id = $1", [a.id]);
          await pg.query("update ai_response_claims set lease_expires_at = now() - interval '2 hours', created_at = now() - interval '2 hours' where inbound_message_id = $1", [a.id]).catch(() => pg.query("update ai_response_claims set lease_expires_at = now() - interval '2 hours' where inbound_message_id = $1", [a.id]));
        }
        const s0 = sends(l.phone);
        await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "TONLY text only please" }); await settle(); await pause(500);
        await pg.query("delete from public.stress_hold_fail where property_id = $1", [l.propertyId]);
        const b = await lastIn(l.propertyId); const p = await prop(l.propertyId); const dr = await drips(l.propertyId);
        const queued = (await pg.query("select count(*)::int n from routing_v2_outbox where inbound_message_id = $1 and kind = 'reply' and status in ('pending','claimed','sent')", [b.id])).rows[0].n;
        const s = sends(l.phone) - s0; total += s;
        const routed = /^routing_v2:/.test(b.r ?? "") && b.o === "auto_closed";
        const ok = !routed && s === 0 && dr === 0 && queued === 0;
        if (ok) pass++;
        const k = `${ok ? "PASS" : "FAIL"} A-stamp=${a.o}:${sh(a.r)} A-claim=${ca?.status}:${sh(ca?.outcome)}:${sh(ca?.em)} A-decision=${da} holdAfterA=${pa.nh ? pa.r : "-"} B-stamp=${b.o}:${sh(b.r)} B-decision=${await dec(b.id)} hold=${p.nh ? p.r : "-"} replyQueued=${queued} sends=${s} activeDrips=${dr}`;
        modes[k] = (modes[k] ?? 0) + 1;
      }
      R3.line(`${verdict(pass)} ${which} ${which === "F8" ? "worker dies at the safety hold write, cron DOWN >1 h (no sweep / consumer), then B" : "every hold write fails (per-lead trigger) through B, no sweep"}: ${pass}/${N}; sends ${total}`);
      R3.line("   modes", modes);
    }
  } finally {
    await pg.query("drop trigger if exists stress_hold_fail_trg on public.properties; drop function if exists public.stress_hold_fail_fn(); drop table if exists public.stress_hold_fail;");
  }
  // F10
  {
    let pass = 0; const modes: Record<string, number> = {}; let total = 0;
    for (let i = 0; i < N; i++) {
      const l = await fresh();
      const conv = null; // fresh lead: no thread yet (M16 reuses the prior inbound's conversation_id)
      await pg.query(`insert into public.messages (org_id, channel, direction, status, property_id, contact_id, conversation_id, from_address, to_address, body, sent_at, metadata)
        values ($1, 'sms', 'outbound', 'sent', $2, $3, $4, $5, $6, '[stress placeholder rep sms]', now(), $7)`,
        [org.orgId, l.propertyId, l.contactId, conv, org.sender, l.phone, JSON.stringify({ repSms: { workflow: "maria-through-mel", persona: "Mel", assistant: "Maria", actorUserId: "00000000-0000-4000-8000-0000000000aa", senderAssignmentId: null } })]);
      await pause(2500);
      const s0 = sends(l.phone);
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() - 3600_000);
      try { await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "TONLY text only please" }); await settle(); }
      finally { vi.useRealTimers(); }
      await assertClockAligned(pg, FIXTURE_ZONES);
      await pause(500);
      const b = await lastIn(l.propertyId); const p = await prop(l.propertyId);
      const s = sends(l.phone) - s0; total += s;
      const ok = p.nh === true && /rep_sms_human_takeover/.test(p.r ?? "") && s === 0;
      if (ok) pass++;
      const k = `${ok ? "PASS" : "FAIL"} B-stamp=${b.o}:${sh(b.r)} B-decision=${await dec(b.id)} hold=${p.nh ? p.r : "-"} sends=${s} activeDrips=${await drips(l.propertyId)}`;
      modes[k] = (modes[k] ?? 0) + 1;
    }
    R3.line(`${verdict(pass)} F10 rep SMS, then seller reply handled with app clock -1 h -> rep_sms_human_takeover, 0 auto sends: ${pass}/${N}; sends ${total}`);
    R3.line("   modes", modes);
  }
  await setFlags(pg, BMH, FLAGS);
});
