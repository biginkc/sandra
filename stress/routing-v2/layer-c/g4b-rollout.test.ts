import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertStack, Receipt } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, setFlags, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/** G4b (BUILD §13.4): stage tests, flag-off-while-queued, flip between decision and send. */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const data = loadReplay();
const stubs = new ProviderStubs(data);
let org: RunOrg;
const R = new Receipt("G4b-rollout.txt");
const pending: Promise<unknown>[] = [];
const ALL = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, wrong_number_all: true, model_stop_suppression: true, canary_percent: 100 };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  setClockOffset(offsetToChicago(12, 0)); // business hours on the JS clock (the stack may be at night)
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4b-${Date.now()}`, {});
  await retirePriorRuns(pg);
});
afterAll(async () => { setClockOffset(0); stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

it("G4b stage tests + flag-off rollback", async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { isV2Eligible, parseRoutingV2Flags } = await import("@/lib/sms-classification/routing-v2/flags");
  const db = createTestClient();
  const sample = data.rows.filter((r) => data.probsByReply.has(r.reply.trim())).filter((_, i) => i % 29 === 0).slice(0, 60);

  // Snapshot of what one inbound produced: stamp, outbound bodies, enrollments, v2 rows.
  const snap = async (lead: Lead, inboundExt: string) => {
    const m = (await pg.query("select id, metadata->'processing'->'aiResponder' st from messages where external_id = $1", [inboundExt])).rows[0];
    const out = getMockMessageLog().filter((x) => x.to === lead.phone).map((x) => x.body);
    const enr = (await pg.query("select s.name, e.status from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 order by s.name", [lead.propertyId])).rows.map((r) => `${r.name}:${r.status}`);
    const v2 = (await pg.query("select (select count(*) from routing_v2_live_decisions where property_id = $1) + (select count(*) from routing_v2_outbox where property_id = $1) + (select count(*) from routing_v2_reply_transitions where property_id = $1) n", [lead.propertyId])).rows[0].n;
    const prop = (await pg.query("select needs_human_attention, last_ai_escalation_reason, outreach_dispo, status from properties where id = $1", [lead.propertyId])).rows[0];
    return { stamp: m?.st ? { outcome: m.st.outcome, reason: m.st.reason } : null, out, enr, prop, v2: Number(v2) };
  };
  const runStage = async (flags: Record<string, unknown>, label: string) => {
    await setFlags(pg, BMH, flags);
    const leads = await seedLeads(pg, org, sample.length, { ourLast: (i) => sample[i]!.our_last ?? "Hi", state: () => ({ state: "MO", fips: null }), address: (i) => `${i} Stage ${label} Ct` });
    const res = [];
    for (let i = 0; i < sample.length; i++) {
      const ext = `${org.runId}-${label}-${i}`;
      await deliverWebhook({ externalId: ext, from: leads[i]!.phone, to: org.sender, body: sample[i]!.reply });
      await settle();
      await runRoutingV2OutboxReplies(db, { limit: 20 });
      res.push(await snap(leads[i]!, ext));
    }
    return res;
  };
  const norm = (s: Awaited<ReturnType<typeof snap>>) => JSON.stringify({ ...s, out: s.out.map((b) => b.replace(/\d+ Stage \w+ Ct/g, "<addr>")) }).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");

  const legacy = await runStage({}, "legacy");
  const allOff = await runStage({ questions_live: false, replies: false, drips: false, haiku: false, price_check: false, alert_on_time_only: false, wrong_number_all: false, model_stop_suppression: false, canary_percent: 0, canary_property_ids: [] }, "alloff");
  const ineligible = await runStage({ ...ALL, canary_percent: 0, canary_property_ids: [] }, "inelig");
  const diff = (a: typeof legacy, b: typeof legacy) => a.map((x, i) => norm(x) === norm(b[i]!) ? null : { i, reply: sample[i]!.reply.slice(0, 40), a: norm(x), b: norm(b[i]!) }).filter(Boolean);
  const d1 = diff(legacy, allOff), d2 = diff(legacy, ineligible);
  R.check("all-off = legacy engine, identical per inbound (stamp, sent bodies, drips, flags) and zero v2 rows", d1.length === 0 && allOff.every((s) => s.v2 === 0), { n: sample.length, diffs: d1.length, v2Rows: allOff.reduce((s, x) => s + x.v2, 0), firstDiff: d1[0] });
  R.check("questions_live on + not eligible (canary 0) = legacy engine, zero v2 rows", d2.length === 0 && ineligible.every((s) => s.v2 === 0), { n: sample.length, diffs: d2.length, v2Rows: ineligible.reduce((s, x) => s + x.v2, 0), firstDiff: d2[0] });
  const v2 = await runStage(ALL, "eligible");
  R.check("eligible = v2 engine (live decision row per inbound)", v2.every((s) => s.v2 > 0 || s.stamp === null || /keyword|opt|dnc|stop/i.test(JSON.stringify(s.stamp))),
    { n: sample.length, withV2Rows: v2.filter((s) => s.v2 > 0).length, withoutV2: v2.filter((s) => s.v2 === 0).map((s) => s.stamp) });

  // Each slice on/off, in rollout order.
  const roadCase: Record<string, { body: string; probs: Record<string, number>; check: (p: string, phone: string) => Promise<unknown> }> = {
    replies: { body: "SLICE text only please", probs: { text_only: 0.95 }, check: async (p) => (await pg.query("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'reply'", [p])).rows[0].n },
    drips: { body: "SLICE not interested", probs: { not_interested: 0.95 }, check: async (p) => (await pg.query("select count(*)::int n from sequence_enrollments where property_id = $1 and routing_v2_engine = 'v2'", [p])).rows[0].n },
    haiku: { body: "SLICE hmm maybe not", probs: { not_interested: 0.55 }, check: async () => stubs.count("haiku", (c) => c.key.startsWith("SLICE hmm")) },
    price_check: { body: "SLICE I want 250000 for it", probs: { named_price: 0.95, talked_price: 0.9 }, check: async (p) => (await pg.query("select price_outcome from routing_v2_live_decisions where property_id = $1", [p])).rows[0]?.price_outcome ?? null },
    alert_on_time_only: { body: "SLICE yes sure", probs: { open_to_selling: 0.95 }, check: async (p) => (await pg.query("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'alert' and status <> 'cancelled'", [p])).rows[0].n },
    wrong_number_all: { body: "SLICE wrong person", probs: { wrong_person: 0.95 }, check: async (p) => (await pg.query("select count(*)::int n from routing_v2_phone_actions where source_property_id = $1", [p])).rows[0].n },
    model_stop_suppression: { body: "SLICE please quit it", probs: { asked_stop: 0.95 }, check: async (p) => (await pg.query("select count(*)::int n from routing_v2_model_stop_events where property_id = $1", [p])).rows[0].n },
  };
  stubs.jevOverride = (r) => Object.values(roadCase).find((c) => c.body === r)?.probs ?? null;
  for (const [slice, c] of Object.entries(roadCase)) {
    const out: Record<string, unknown> = {};
    for (const on of [true, false]) {
      await setFlags(pg, BMH, { ...ALL, [slice]: on });
      const [lead] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }) });
      const before = stubs.count("haiku", (x) => x.key.startsWith("SLICE hmm"));
      await deliverWebhook({ externalId: `${org.runId}-slice-${slice}-${on}`, from: lead!.phone, to: org.sender, body: c.body });
      await settle();
      const v = await c.check(lead!.propertyId, lead!.phone);
      out[on ? "on" : "off"] = slice === "haiku" ? (v as number) - before : v;
      out[(on ? "on" : "off") + "_road"] = (await pg.query("select road from routing_v2_live_decisions where property_id = $1", [lead!.propertyId])).rows[0]?.road;
    }
    const differs = JSON.stringify(out.on) !== JSON.stringify(out.off);
    if (slice === "alert_on_time_only") R.line(`INCONCLUSIVE slice alert_on_time_only: the hot_yes alert row is queued either way; on/off is decided at alert delivery (routing_v2_alert_delivery_gate, hold-alerts fan-out — not run here) ::`, out);
    else R.check(`slice ${slice}: on vs off changes behaviour`, differs, out);
  }
  stubs.jevOverride = null;

  // Percent 10/50/100: stable, nested sets; TS == SQL eligibility.
  const ids = Array.from({ length: 2000 }, () => randomUUID());
  const setAt = (p: number) => new Set(ids.filter((id) => isV2Eligible(parseRoutingV2Flags({ questions_live: true, canary_percent: p }), id)));
  const s10 = setAt(10), s50 = setAt(50), s100 = setAt(100), s10b = setAt(10);
  const nested = [...s10].every((x) => s50.has(x)) && [...s50].every((x) => s100.has(x));
  const stable = s10.size === s10b.size && [...s10].every((x) => s10b.has(x));
  let sqlMismatch = 0;
  for (const p of [10, 50]) {
    const { rows } = await pg.query("select id, public.routing_v2_canary_eligible($1::jsonb, id) e from unnest($2::uuid[]) id", [JSON.stringify({ questions_live: true, canary_percent: p }), ids]);
    const ts = p === 10 ? s10 : s50;
    sqlMismatch += rows.filter((r) => r.e !== ts.has(r.id)).length;
  }
  R.check("canary percent 10/50/100 picks stable nested property sets; SQL and TS agree", nested && stable && s100.size === ids.length && sqlMismatch === 0,
    { n: ids.length, at10: s10.size, at50: s50.size, at100: s100.size, nested, stable, sqlVsTsMismatches: sqlMismatch });

  // Flag-off while queued: a deferred (quiet-hours) reply, a due drip step, then questions_live off.
  await setFlags(pg, BMH, ALL);
  stubs.jevOverride = (r) => r.includes("QTEXT") ? { text_only: 0.95 } : r.includes("QYES") ? { open_to_selling: 0.95 } : null;
  const [qa, qb, qc] = await seedLeads(pg, org, 3, { state: () => ({ state: "CA", fips: null }) });
  setClockOffset(offsetToChicago(7, 0)); // 05:00 in CA: recipient quiet hours -> replies wait in the outbox
  await deliverWebhook({ externalId: `${org.runId}-q1`, from: qa!.phone, to: org.sender, body: "QTEXT text only" });
  await deliverWebhook({ externalId: `${org.runId}-q2`, from: qb!.phone, to: org.sender, body: "QYES yes interested" });
  await settle();
  await runRoutingV2OutboxReplies(db, { limit: 50 });
  setClockOffset(offsetToChicago(12, 0));
  await deliverWebhook({ externalId: `${org.runId}-q3`, from: qc!.phone, to: org.sender, body: "QYES yes" });
  await settle();
  await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = any($1) and status = 'active'; commit;".replace("$1", `array['${qa!.propertyId}','${qb!.propertyId}','${qc!.propertyId}']::uuid[]`));
  const queued = (await pg.query("select kind, status from routing_v2_outbox where property_id = any($1)", [[qa!.propertyId, qb!.propertyId, qc!.propertyId]])).rows;
  const sendsBefore = getMockMessageLog().filter((m) => [qa!.phone, qb!.phone, qc!.phone].includes(m.to)).length;
  await setFlags(pg, BMH, { ...ALL, questions_live: false });
  await runSequenceTick(db as never, { budgetMs: 20_000 });
  await runRoutingV2OutboxReplies(db, { limit: 50 });
  const sendsAfter = getMockMessageLog().filter((m) => [qa!.phone, qb!.phone, qc!.phone].includes(m.to)).length;
  const boxAfter = (await pg.query("select kind, status, cancel_reason from routing_v2_outbox where property_id = any($1)", [[qa!.propertyId, qb!.propertyId, qc!.propertyId]])).rows;
  const enrAfter = (await pg.query("select status, ended_reason, pause_reason from sequence_enrollments where property_id = any($1)", [[qa!.propertyId, qb!.propertyId, qc!.propertyId]])).rows;
  const human = (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = any($1)", [[qa!.propertyId, qb!.propertyId, qc!.propertyId]])).rows;
  R.check("flag off while queued: zero sends; every queued item cancelled; v2 enrollments stopped; leads in the human queue",
    sendsAfter === sendsBefore && boxAfter.every((b) => b.status === "cancelled") && enrAfter.every((e) => e.status !== "active") && human.every((h) => h.needs_human_attention),
    { queuedBefore: queued, sendsBefore, sendsAfter, outbox: boxAfter, enrollments: enrAfter, properties: human });

  // Flip between decision and send.
  const [ra] = await seedLeads(pg, org, 1, { state: () => ({ state: "CA", fips: null }) });
  await setFlags(pg, BMH, ALL);
  setClockOffset(offsetToChicago(7, 0));
  await deliverWebhook({ externalId: `${org.runId}-race`, from: ra!.phone, to: org.sender, body: "QTEXT only text" });
  await settle();
  setClockOffset(offsetToChicago(12, 0));
  const decided = (await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [ra!.propertyId])).rows[0]?.status;
  await setFlags(pg, BMH, { ...ALL, replies: false });
  await runRoutingV2OutboxReplies(db, { limit: 50 });
  const raBox = (await pg.query("select status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply'", [ra!.propertyId])).rows[0];
  R.check("flag flips between decision and send -> no send", getMockMessageLog().filter((m) => m.to === ra!.phone).length === 0 && raBox?.status === "cancelled", { atDecision: decided, after: raBox });
  stubs.jevOverride = null;
  await setFlags(pg, BMH, {});
});
