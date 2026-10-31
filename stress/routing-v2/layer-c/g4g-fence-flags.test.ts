import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertClockAligned, FIXTURE_ZONES } from "./lib/clock";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { assertStack, finishNoLiveClassifier, Receipt } from "./lib/env";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, setFlags, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

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
const R = new Receipt("G4g-fence-flags-F1-F2.txt");
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
  const { setTestBarrier, clearTestBarriers } = await import("@/lib/testing/test-barriers");
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
  await setFlags(pg, BMH, FLAGS);
});
