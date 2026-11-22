import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertClockAligned, FIXTURE_ZONES } from "./lib/clock";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { assertStack, finishNoLiveClassifier, Receipt } from "./lib/env";
import { createRunOrg, retirePriorRuns, seedLeads, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/**
 * M14 / M15 / M16 hold stacking (x N, default 20, fresh MO lead each, real time, skew-guarded).
 * A = mechanics hold: the reply-only text_only road twice ("TONLY text only please" both times); the repeat reply is
 *     refused template_already_sent and the lead is held (the app's own outbox path).
 * B = M14 possible stop: real webhook text "QSTOP I am all set for good, thanks" with stub Jev asked_stop 0.65 and stub
 *       Haiku answering asked_stop (the app decides what that does on an already-held lead);
 *     M15 keyword hold: real webhook text "You can talk to my lawyer about it" (existing fixture text, keyword:legal_contract);
 *     M16 rep-SMS takeover: an outbound rep SMS row written the way the rep-SMS send stores it (metadata.repSms
 *       maria-through-mel / Mel / Maria / actorUserId, status sent, from the run's sender); the app records the takeover
 *       when the next seller text arrives (inbound.ts findRepSmsHumanTakeoverSource -> recordRepSmsHumanTakeover).
 * C = next seller text via the real webhook: "NOTINT actually never mind" (stub not_interested 0.95).
 * After C: lead still held; no auto reply sent after A; no v2 drip enrolled or sent; exactly one audit row per inbound.
 * No rule or seller text is added: all bodies are existing harness fixture texts; the rep SMS body is a placeholder.
 */
const N = Number(process.env.M_N ?? 20);
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt("G4f-hold-stacking-M14-M15-M16.txt");
const pending: Promise<unknown>[] = [];
const FLAGS = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, model_stop_suppression: true, wrong_number_all: true, canary_percent: 100 };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  const clock = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; |app - DB| skew = ${Math.round(clock.skewMs)} ms; local`, clock.local);
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `m14-${Date.now()}`, FLAGS);
  await retirePriorRuns(pg);
  stubs.jevOverride = (r) => r.includes("TONLY") ? { text_only: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : r.includes("QSTOP") ? { asked_stop: 0.65 } : null;
  stubs.haikuOverride = (thread) => /SELLER: QSTOP[^\n]*$/.test(thread.split("\n\nReturn JSON")[0]!) ? { status: 200, text: JSON.stringify({ road: "asked_stop", confidence: 0.9 }) } : null;
});
afterAll(async () => { finishNoLiveClassifier(); stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

it(`M14/M15/M16 hold stacking x${N}`, async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const db = createTestClient();
  let n = 0;
  const ext = () => `${org.runId}-m-${n++}`;
  const say = async (l: Lead, body: string) => {
    await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body });
    await settle(); await pause(300); await runRoutingV2OutboxReplies(db, { limit: 50 }); await pause(200);
  };
  const prop = async (p: string) => (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [p])).rows[0];
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);

  const cases: Record<string, (l: Lead) => Promise<void>> = {
    M14: async (l) => { await say(l, "QSTOP I am all set for good, thanks"); },
    M15: async (l) => { await say(l, "You can talk to my lawyer about it"); },
    M16: async (l) => {
      const conv = (await pg.query("select conversation_id from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [l.propertyId])).rows[0]?.conversation_id;
      await pg.query(`insert into public.messages (org_id, channel, direction, status, property_id, contact_id, conversation_id, from_address, to_address, body, sent_at, metadata)
        values ($1, 'sms', 'outbound', 'sent', $2, $3, $4, $5, $6, '[stress placeholder rep sms]', now(), $7)`,
        [org.orgId, l.propertyId, l.contactId, conv, org.sender, l.phone, JSON.stringify({ repSms: { workflow: "maria-through-mel", persona: "Mel", assistant: "Maria", actorUserId: "00000000-0000-4000-8000-0000000000aa", senderAssignmentId: null } })]);
      // The rep SMS row's sent_at is DB time; the seller's reply is timed by the app clock (skew < 2 s), so the reply
      // is sent >= 2.5 s later (as in real life) to keep it strictly after the rep SMS on both clocks.
      await pause(2500);
    },
  };

  for (const [name, b] of Object.entries(cases)) {
    let pass = 0; const modes: Record<string, number> = {}; let sendsAfterA = 0, dripsBad = 0;
    for (let i = 0; i < N; i++) {
      const l = (await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), address: () => `${n} Stack Ln` }))[0]!;
      try {
        await say(l, "TONLY text only please");
        await say(l, "TONLY text only please");
        const a = await prop(l.propertyId);
        const sentAtA = sends(l.phone).length;
        await b(l);
        const afterB = await prop(l.propertyId);
        await say(l, "NOTINT actually never mind");
        await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
        await runSequenceTick(db as never, { budgetMs: 20_000 });
        const c = await prop(l.propertyId);
        const extraSends = sends(l.phone).length - sentAtA;
        const enr = (await pg.query("select status from sequence_enrollments where property_id = $1 and routing_v2_engine = 'v2'", [l.propertyId])).rows;
        const audit = (await pg.query("select m.id, (select count(*)::int from routing_v2_live_decisions d where d.inbound_message_id = m.id) n from messages m where m.property_id = $1 and m.direction = 'inbound'", [l.propertyId])).rows;
        const auditOk = audit.every((x) => x.n === 1);
        const ok = a.nh === true && c.nh === true && extraSends === 0 && enr.length === 0 && auditOk;
        if (ok) pass++;
        sendsAfterA += extraSends; if (enr.length) dripsBad++;
        const k = `${ok ? "PASS" : "FAIL"} A=${String(a.r).split(":").slice(0, 2).join(":")} B=${String(afterB.r).split(":").slice(0, 2).join(":")} C=${String(c.r).split(":").slice(0, 2).join(":")} held=${c.nh} sendsAfterA=${extraSends} v2enr=${enr.map((e) => e.status).join("/") || 0} audit=${audit.map((x) => x.n).join("")}`;
        modes[k] = (modes[k] ?? 0) + 1;
      } catch (e) { modes[`THREW ${String(e).slice(0, 100)}`] = (modes[`THREW ${String(e).slice(0, 100)}`] ?? 0) + 1; }
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} ${name}: ${pass}/${N}; auto sends after the mechanics hold ${sendsAfterA}; leads with a v2 enrollment ${dripsBad}`);
    R.line("   modes", Object.fromEntries(Object.entries(modes).sort((x, y) => y[1] - x[1]).slice(0, 8)));
  }
});
