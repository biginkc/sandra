import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertClockAligned, FIXTURE_ZONES } from "./lib/clock";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { assertStack, Receipt } from "./lib/env";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/**
 * G4-4.3 A-2 race cases x N (default 50), each iteration on fresh leads, with NO clock shift
 * (app clock == DB clock, guarded). Non-race 4.3 checks stay in g4-drips.test.ts (x1).
 */
const N = Number(process.env.RACE_N ?? 50);
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt(process.env.RACE_RECEIPT ?? "G4-4.3-skew0-x50.txt");
const pending: Promise<unknown>[] = [];
const FLAGS = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, model_stop_suppression: true, wrong_number_all: true, canary_percent: 100 };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  const clock = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; measured |app - DB| skew = ${Math.round(clock.skewMs)} ms; local times`, clock.local);
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `race-${Date.now()}`, FLAGS);
  await retirePriorRuns(pg);
  stubs.jevOverride = (r) => r.includes("YESBOOK") ? { open_to_selling: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : r.includes("LATER") ? { maybe_later: 0.95 } : null;
});
afterAll(async () => { stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

it(`A-2 race cases x${N} at skew 0`, async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const db = createTestClient();
  let n = 0;
  const ext = () => `${org.runId}-r-${n++}`;
  const say = async (l: Lead, body: string, id = ext()) => { await deliverWebhook({ externalId: id, from: l.phone, to: org.sender, body }); await settle(); await pause(300); };
  const enr = async (p: string) => (await pg.query("select s.routing_v2_key k, e.status, e.pause_reason, e.ended_reason from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1", [p])).rows;
  const prop = async (p: string) => (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r, last_ai_escalation_at at from properties where id = $1", [p])).rows[0];
  const stamps = async (p: string) => (await pg.query("select left(body, 12) b, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at", [p])).rows;
  const makeDue = async (p: string) => pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + p + "' and status = 'active'; commit;");
  const tick = async () => { await runSequenceTick(db as never, { budgetMs: 20_000 }); };
  const sendsTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);
  const fresh = async () => (await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), address: () => `${n} Race Way` }))[0]!;

  type Res = { pass: boolean; mode: string; heldActive: boolean; sendsToHeld: number };
  const common = async (l: Lead, t0: number): Promise<{ heldActive: boolean; sendsToHeld: number; p: Awaited<ReturnType<typeof prop>>; rows: Awaited<ReturnType<typeof enr>>; st: Awaited<ReturnType<typeof stamps>> }> => {
    const p = await prop(l.propertyId); const rows = await enr(l.propertyId); const st = await stamps(l.propertyId);
    const heldAt = p.at ? new Date(p.at).getTime() : Infinity;
    const sendsToHeld = p.nh ? sendsTo(l.phone).filter((m) => m.createdAt.getTime() > Math.max(heldAt, t0)).length : 0;
    return { heldActive: !!p.nh && rows.some((e) => e.status === "active"), sendsToHeld, p, rows, st };
  };
  const mode = (c: Awaited<ReturnType<typeof common>>) => {
    const parts: string[] = [];
    if (c.p.nh) parts.push(`hold=${String(c.p.r).split(":").slice(0, 2).join(":")}`);
    for (const s of c.st) if (s.o !== "auto_closed") parts.push(`${s.b.trim()}:${s.o}:${String(s.r).split(":").slice(0, 1).join("")}`);
    if (c.rows.some((e) => e.status === "paused")) parts.push("drip_paused");
    return parts.join(" | ") || "ok";
  };

  const cases: Record<string, () => Promise<Res>> = {
    "reply onto an active drip": async () => {
      const l = await fresh(); const t0 = Date.now();
      await say(l, "YESBOOK sure what's the offer");
      await say(l, "NOTINT actually never mind");
      await makeDue(l.propertyId); await tick();
      const c = await common(l, t0);
      const pass = c.rows.some((e) => e.k === "book_appointment" && e.ended_reason === "rerouted") && c.rows.some((e) => e.k === "not_interested" && e.status === "active") && !c.p.nh;
      return { pass, mode: mode(c), heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
    "reply onto a paused drip": async () => {
      const l = await fresh(); const t0 = Date.now();
      await say(l, "YESBOOK yes");
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
      await say(l, "LATER maybe next year");
      const c = await common(l, t0);
      const pass = c.rows.some((e) => e.k === "book_appointment" && e.ended_reason === "rerouted") && c.rows.some((e) => e.k === "maybe_later" && e.status === "active") && !c.rows.some((e) => e.status === "paused") && !c.p.nh;
      return { pass, mode: mode(c), heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
    "two concurrent replies": async () => {
      const l = await fresh(); const t0 = Date.now();
      await say(l, "YESBOOK yes");
      await Promise.all([deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "NOTINT no thanks" }), deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "LATER maybe later" })]);
      await settle(); await pause(300);
      const tr = (await pg.query("select inbound_message_id, outcome from routing_v2_reply_transitions where property_id = $1", [l.propertyId])).rows;
      const c = await common(l, t0);
      const oneEach = new Set(tr.map((t) => t.inbound_message_id)).size === tr.length && c.rows.filter((e) => e.status === "active").length <= 1;
      const latestWins = tr.length > 1 && !c.rows.some((e) => e.status === "paused") && c.rows.some((e) => e.k === "book_appointment" && e.ended_reason === "rerouted");
      return { pass: oneEach && latestWins && !c.p.nh, mode: `${oneEach ? "" : "DUP_TRANSITION "}${mode(c)}`, heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
    "reply vs tick": async () => {
      const l = await fresh(); const t0 = Date.now();
      await say(l, "YESBOOK yes");
      await makeDue(l.propertyId);
      const before = sendsTo(l.phone).length;
      await Promise.all([tick(), deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "NOTINT not interested" })]);
      await settle(); await pause(300); await tick();
      const stepSends = sendsTo(l.phone).slice(before).filter((m) => /Mel here|can I hold|talk about/.test(m.body)).length;
      const c = await common(l, t0);
      const routed = c.rows.some((e) => e.k === "book_appointment" && e.ended_reason === "rerouted") && c.rows.some((e) => e.k === "not_interested");
      return { pass: stepSends <= 1 && routed && !c.p.nh, mode: `${stepSends > 1 ? "RETIRED_STEP_SENT " : ""}${mode(c)}`, heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
    "case 1 double-text (0.4 s)": async () => {
      const l = await fresh(); const t0 = Date.now();
      const a = deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "YESBOOK sure what's the offer" });
      await pause(400);
      const b = deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "NOTINT actually never mind" });
      await Promise.all([a, b]); await settle(); await pause(500);
      const c = await common(l, t0);
      const routed = c.st.some((s) => s.b.startsWith("NOTINT") && s.o === "auto_closed" && /not_interested_drip/.test(s.r ?? "")) && !c.rows.some((e) => e.k === "book_appointment" && e.status === "active");
      return { pass: routed && !c.p.nh && !c.heldActive, mode: mode(c), heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
    "duplicate webhook": async () => {
      const l = await fresh(); const t0 = Date.now(); const id = ext();
      await say(l, "YESBOOK yes", id); await say(l, "YESBOOK yes", id);
      const tr = (await pg.query("select count(*)::int n from routing_v2_reply_transitions where property_id = $1", [l.propertyId])).rows[0].n;
      const replies = sendsTo(l.phone).length;
      const c = await common(l, t0);
      return { pass: tr === 1 && replies <= 1, mode: `transitions=${tr} sends=${replies} ${mode(c)}`, heldActive: c.heldActive, sendsToHeld: c.sendsToHeld };
    },
  };

  for (const [name, fn] of Object.entries(cases)) {
    let pass = 0, heldActive = 0, sendsToHeld = 0;
    const modes: Record<string, number> = {};
    const failSamples: string[] = [];
    for (let i = 0; i < N; i++) {
      let r: Res;
      try { r = await fn(); } catch (e) { r = { pass: false, mode: `THREW ${String(e).slice(0, 80)}`, heldActive: false, sendsToHeld: 0 }; }
      if (r.pass) pass++; else if (failSamples.length < 3) failSamples.push(r.mode);
      modes[r.pass ? "PASS" : r.mode] = (modes[r.pass ? "PASS" : r.mode] ?? 0) + 1;
      if (r.heldActive) heldActive++; sendsToHeld += r.sendsToHeld;
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} ${name}: ${pass}/${N} :: held-with-active-drip ${heldActive}; sends to held leads ${sendsToHeld}`);
    R.line(`   modes`, Object.fromEntries(Object.entries(modes).sort((a, b) => b[1] - a[1])));
  }
  void BMH;
});
