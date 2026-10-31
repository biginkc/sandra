import { readFileSync, writeFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertClockAligned, assertZoneQuiet, FIXTURE_ZONES } from "./lib/clock";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { assertStack, Receipt, SCRATCH, finishNoLiveClassifier } from "./lib/env";
import { BMH, createRunOrg, readdressToInHours, retirePriorRuns, seedLeads, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/**
 * G4e quiet-hours resume (bounded, local, deterministic). NO clock is moved: the reply is deferred because the
 * recipient is a Hawaii (808 / state HI) lead in real quiet hours; "the window opens" = readdressToInHours, which
 * rewrites exactly the fields the outbox prepare reads (see the receipt header). N iterations per case, fresh leads.
 * G4E_MODE=cases (default) | bonus_defer | bonus_resume (real-clock Hawaii 08:00 HST check).
 */
const N = Number(process.env.G4E_N ?? 20);
const MODE = process.env.G4E_MODE ?? "cases";
const BONUS_FILE = `${SCRATCH}/g4e-bonus-outbox.json`;
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt(MODE === "cases" ? "G4e-quiet-resume.txt" : `G4e-quiet-resume-${MODE}.txt`);
const pending: Promise<unknown>[] = [];
const FLAGS = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, model_stop_suppression: true, wrong_number_all: true, canary_percent: 100 };

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  const clock = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; |app - DB| skew = ${Math.round(clock.skewMs)} ms; local`, clock.local, `; Honolulu ${new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Honolulu", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4e-${Date.now()}`, FLAGS);
  if (MODE !== "bonus_resume" && !process.env.G4E_KEEP) await retirePriorRuns(pg);
  stubs.jevOverride = (r) => r.includes("TONLY") ? { text_only: 0.95 } : r.includes("YESBOOK") ? { open_to_selling: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : null;
});
afterAll(async () => { finishNoLiveClassifier(); stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEADER = [
  "BOUNDARY (read from code at ac1f, src/lib/ai-responder/dispatch.ts outbox prepare ~9020-9056 and send.ts ~825):",
  "  - prepare refuses when properties.needs_human_attention = true (held_for_person) BEFORE any window check;",
  "  - recipient window = evaluateRecipientWindow -> resolveSendDestinationPhone: contacts.phone_1..3 (+types), the one matching the",
  "    inbound messages.from_address (input.inboundFromPhone); checkRecipientQuietHours(area code -> zone, JS Date) -> 'wait' when closed;",
  "  - property window = checkQuietHours(properties.state, JS Date) -> 'wait' when closed (unknown state goes on and is refused at send);",
  "  - send.ts step 4 re-checks checkQuietHours(property.state) at send time.",
  "  readdressToInHours rewrites contacts.phone_1, the property's inbound from_address / outbound to_address and properties.state (HI -> MO, 808 -> 816):",
  "  exactly the inputs of both windows. No clock (JS or DB) is moved; app and DB clocks are asserted aligned (< 2 s).",
];

it(`G4e quiet resume (${MODE})`, async () => {
  const { createTestClient } = await import("@tests/integration/client");
  const { runRoutingV2OutboxReplies, deliverRoutingV2OutboxReply } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { pauseHotBookAppointmentOnTakeover } = await import("@/lib/sequences/hot-lead-takeover");
  const db = createTestClient();
  let n = 0;
  const ext = () => `${org.runId}-e-${n++}`;
  const sendsTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const hi = async () => (await seedLeads(pg, org, 1, { state: () => ({ state: "HI", fips: null }), address: () => `${n} Resume Rd` }))[0]!;
  const box = async (p: string) => (await pg.query("select id, org_id, property_id, inbound_message_id, kind, payload, created_at::text, status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply' order by created_at", [p])).rows;
  const keyed = async (outboxId: string) => (await pg.query("select count(*)::int n from messages where idempotency_key = $1", [outboxId])).rows[0].n;
  const defer = async (l: Lead, body: string) => {
    assertZoneQuiet("Pacific/Honolulu");
    await assertClockAligned(pg, FIXTURE_ZONES);
    await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body });
    await settle(); await pause(400);
    await runRoutingV2OutboxReplies(db, { limit: 50 }); // in quiet hours: must wait, not send
    return box(l.propertyId);
  };

  if (MODE === "bonus_defer") {
    for (const h of HEADER) R.line(h);
    const ids: Array<{ id: string; phone: string; prop: string }> = [];
    for (let i = 0; i < 3; i++) { const l = await hi(); const b = await defer(l, "TONLY text only please"); ids.push({ id: b[0]!.id, phone: l.phone, prop: l.propertyId }); }
    writeFileSync(BONUS_FILE, JSON.stringify(ids));
    const st = await pg.query("select status from routing_v2_outbox where id = any($1)", [ids.map((x) => x.id)]);
    R.line(`bonus defer (real clock, Hawaii in quiet hours): ${ids.length} HI replies queued, statuses ${JSON.stringify(st.rows.map((r) => r.status))}, sends ${ids.reduce((a, x) => a + sendsTo(x.phone), 0)}`);
    return;
  }
  if (MODE === "bonus_resume") {
    const ids = JSON.parse(readFileSync(BONUS_FILE, "utf8")) as Array<{ id: string; phone: string; prop: string }>;
    const hst = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Honolulu", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date());
    await runRoutingV2OutboxReplies(db, { limit: 200 });
    await runRoutingV2OutboxReplies(db, { limit: 200 });
    const rows = (await pg.query("select id, status, cancel_reason from routing_v2_outbox where id = any($1)", [ids.map((x) => x.id)])).rows;
    const k = await Promise.all(ids.map((x) => keyed(x.id)));
    R.check(`bonus resume at REAL Honolulu ${hst} (no fixture move): every deferred HI reply sent exactly once, keyed by its outbox id`,
      rows.every((r) => r.status === "sent") && k.every((c) => c === 1), { rows, keyedMessagesPerOutboxId: k });
    return;
  }

  for (const h of HEADER) R.line(h);
  R.line(`N = ${N} iterations per case, each on a fresh HI lead.`);
  type Res = { pass: boolean; mode: string; sendsToHeld: number };
  const cases: Record<string, () => Promise<Res>> = {
    "1 deferred -> window opens -> exactly 1 send (idempotency key = outbox id); 2nd tick + retry send nothing": async () => {
      const l = await hi(); const b = await defer(l, "TONLY text only please");
      const row = b[0]!; const pendingOk = row.status === "pending";
      await readdressToInHours(pg, l);
      await runRoutingV2OutboxReplies(db, { limit: 50 });
      const s1 = sendsTo(l.phone);
      await runRoutingV2OutboxReplies(db, { limit: 50 });
      try { await deliverRoutingV2OutboxReply(db, row); } catch { /* retry of a finished row */ }
      const s2 = sendsTo(l.phone); const k = await keyed(row.id);
      const st = (await box(l.propertyId))[0]!.status;
      return { pass: pendingOk && s1 === 1 && s2 === 1 && k === 1 && st === "sent", mode: `deferred=${row.status} sendsAfterOpen=${s1} afterRetry=${s2} keyed=${k} final=${st}`, sendsToHeld: 0 };
    },
    "2 person takeover during deferral -> window opens -> 0 sends (no reply, no drip)": async () => {
      const l = await hi(); const b = await defer(l, "YESBOOK sure what's the offer");
      await pauseHotBookAppointmentOnTakeover({ propertyIds: [l.propertyId], actor: { kind: "system" } as never });
      await readdressToInHours(pg, l);
      await runRoutingV2OutboxReplies(db, { limit: 50 });
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
      await runSequenceTick(db as never, { budgetMs: 20_000 });
      const s = sendsTo(l.phone); const after = await box(l.propertyId);
      const enr = (await pg.query("select status, pause_reason from sequence_enrollments where property_id = $1", [l.propertyId])).rows;
      return { pass: s === 0, mode: `sends=${s} reply=${after.map((x) => `${x.status}:${x.cancel_reason ?? ""}`).join(",")} enr=${enr.map((e) => `${e.status}:${e.pause_reason ?? ""}`).join(",")} deferred=${b[0]?.status}`, sendsToHeld: s };
    },
  };
  for (const [reason, label] of [["nine_asked_stop", "possible stop"], ["nine_needs_person", "needs person"], ["keyword:distressed_seller", "keyword"], ["keyword:legal_contract", "legal"]] as const) {
    cases[`3 lead held during deferral (${label}: needs_human_attention + last_ai_escalation_reason='${reason}', written as markPropertyNeedsAttention does) -> 0 sends`] = async () => {
      const l = await hi(); const b = await defer(l, "YESBOOK yes please");
      await pg.query("update public.properties set needs_human_attention = true, last_ai_escalation_reason = $2, last_ai_escalation_at = now() where id = $1", [l.propertyId, reason]);
      await readdressToInHours(pg, l);
      await runRoutingV2OutboxReplies(db, { limit: 50 });
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
      await runSequenceTick(db as never, { budgetMs: 20_000 });
      const s = sendsTo(l.phone); const after = await box(l.propertyId);
      return { pass: s === 0, mode: `sends=${s} reply=${after.map((x) => `${x.status}:${x.cancel_reason ?? ""}`).join(",")} deferred=${b[0]?.status}`, sendsToHeld: s };
    };
  }
  cases["3b lead held during deferral via the REAL webhook keyword path ('You can talk to my lawyer about it') -> 0 sends"] = async () => {
    const l = await hi(); const b = await defer(l, "YESBOOK yes please");
    await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "You can talk to my lawyer about it" });
    await settle(); await pause(300);
    const held = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
    await readdressToInHours(pg, l);
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + l.propertyId + "' and status = 'active'; commit;");
    await runSequenceTick(db as never, { budgetMs: 20_000 });
    const s = sendsTo(l.phone); const after = await box(l.propertyId);
    return { pass: s === 0 && held.nh, mode: `hold=${held.r} sends=${s} reply=${after.map((x) => `${x.status}:${x.cancel_reason ?? ""}`).join(",")} deferred=${b[0]?.status}`, sendsToHeld: s };
  };
  cases["4 newer seller text during deferral (real webhook) -> newest wins, old deferred reply never sends"] = async () => {
    const l = await hi(); const b = await defer(l, "TONLY text only please");
    const oldId = b[0]!.id;
    await deliverWebhook({ externalId: ext(), from: l.phone, to: org.sender, body: "NOTINT actually not interested" });
    await settle(); await pause(400);
    await readdressToInHours(pg, l);
    await runRoutingV2OutboxReplies(db, { limit: 50 }); await runRoutingV2OutboxReplies(db, { limit: 50 });
    const oldKeyed = await keyed(oldId);
    const rows = await box(l.propertyId);
    const st = (await pg.query("select left(body, 10) b, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where property_id = $1 and direction = 'inbound' order by created_at", [l.propertyId])).rows;
    const p = (await pg.query("select needs_human_attention nh, last_ai_escalation_reason r from properties where id = $1", [l.propertyId])).rows[0];
    const newer = st[st.length - 1]!;
    return { pass: oldKeyed === 0 && rows.find((r) => r.id === oldId)?.status !== "sent", mode: `old=${rows.find((r) => r.id === oldId)?.status}:${rows.find((r) => r.id === oldId)?.cancel_reason} newer=${newer.o}:${newer.r} newReply=${rows.filter((r) => r.id !== oldId).map((r) => `${r.payload?.key}:${r.status}`).join(",")} hold=${p.nh ? p.r : "-"} sends=${sendsTo(l.phone)}`, sendsToHeld: p.nh ? sendsTo(l.phone) : 0 };
  };
  cases["5 duplicate cron / concurrent claims at window open (5 consumer passes in parallel) -> exactly 1 send"] = async () => {
    const l = await hi(); const b = await defer(l, "TONLY text only please");
    await readdressToInHours(pg, l);
    await Promise.all(Array.from({ length: 5 }, () => runRoutingV2OutboxReplies(db, { limit: 50 })));
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    const s = sendsTo(l.phone); const k = await keyed(b[0]!.id);
    return { pass: s === 1 && k === 1, mode: `sends=${s} keyed=${k}`, sendsToHeld: 0 };
  };

  for (const [name, fn] of Object.entries(cases)) {
    let pass = 0, held = 0; const modes: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      let r: Res;
      try { r = await fn(); } catch (e) { r = { pass: false, mode: `THREW ${String(e).slice(0, 120)}`, sendsToHeld: 0 }; }
      if (r.pass) pass++;
      const k = (r.pass ? "PASS " : "FAIL ") + r.mode.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>");
      modes[k] = (modes[k] ?? 0) + 1; held += r.sendsToHeld;
    }
    R.line(`${pass === N ? "PASS" : "FAIL"} ${name}: ${pass}/${N}; sends to held / taken-over leads ${held}`);
    R.line("   modes", Object.fromEntries(Object.entries(modes).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  }
  R.line("PROVEN: with app and DB clocks aligned, a reply deferred by real recipient quiet hours (HI) waits; once the inputs the window checks read say 'in hours', the outbox consumer sends it exactly once keyed by its outbox id, and the cases above hold. NOT PROVEN: the passage of real time opening the window (fixture move stands in for it; see the optional bonus receipt), Vercel cron cadence, the Workflow runtime (mocked), real providers. This is NOT a full E2E test.");
  void BMH;
});
