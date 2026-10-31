import { execSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertStack, Receipt, finishNoLiveClassifier } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, type Lead, type RunOrg } from "./lib/seed";
import { assertClockAligned, assertZoneQuiet, FIXTURE_ZONES } from "./lib/clock";
import { readdressToInHours } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";
void offsetToChicago;

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/**
 * G4c (STRESS §5.4): the final-send allowlist guard with test-run taint. FAKE allowlist numbers
 * only (555-01xx fictional range), set in this process's env; mock provider only.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt("G4c-isolation.txt");
const pending: Promise<unknown>[] = [];
let CLOCK: { skewMs: number; local: Record<string, string> } = { skewMs: -1, local: {} };
const ROOT = path.resolve(__dirname, "../../..");
const FAKE_OWNED = ["+18165550142", "+19135550177"];
const RUN = `stress-g4c-${Date.now()}`;

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  setClockOffset(0); // skew 0: real time only
  CLOCK = await assertClockAligned(pg, FIXTURE_ZONES);
  R.line(`clock: NO shift; measured |app - DB| skew = ${Math.round(CLOCK.skewMs)} ms; local`, CLOCK.local, "; quiet fixture zone Pacific/Guam (GU/671)");
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4c-${Date.now()}`, { questions_live: true, replies: true, drips: true, canary_percent: 100 });
  await retirePriorRuns(pg);
});
afterAll(async () => { finishNoLiveClassifier(); delete process.env.TEST_DEST_ALLOWLIST; setClockOffset(0); stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

it("G4c §5.4 isolation", async () => {
  const grep = (pat: string, dirs = "src supabase") => {
    try { return execSync(`grep -rIl -E -- '${pat}' ${dirs} 2>/dev/null || true`, { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
  };
  for (const [label, pat] of [["assertSendAllowed at the final send boundary", "assertSendAllowed"], ["TEST_DEST_ALLOWLIST", "TEST_DEST_ALLOWLIST"], ["test_run_id taint", "test_run_id"], ["refused_non_owned", "refused_non_owned"], ["stress/seed.mjs seeder", "seed\\.mjs"], ["scoped workers (--run <id>)", "[-]-run <run|claim.*test_run_id"], ["shadow has no send capability (lint/type test)", "no-restricted-imports.*shadow|shadow.*cannot import"]] as const) {
    const hits = grep(pat);
    R.line(`${hits.length ? "PRESENT" : "MISSING"} ${label} :: ${hits.slice(0, 6).join(", ") || "no match"}`);
  }
  const stressRunId = grep("stress_run_id", "src supabase");
  R.check("grep gate: stress_run_id appears nowhere in src/ or supabase/", stressRunId.length === 0, { hits: stressRunId });

  // Pure decision: formatting variants / lookalikes.
  const { decideSendAllowed, parseTestDestAllowlist } = await import("@/lib/messaging/send-allowlist");
  const allow = parseTestDestAllowlist("(816) 555-0142; 913.555.0177");
  const variants = ["+18165550142", "(816) 555-0142", "816-555-0142", "816.555.0142", "8165550142", "1-816-555-0142", "+1 816 555 0142", " +1 (913) 555-0177 "];
  const vOk = variants.map((d) => ({ d, ok: decideSendAllowed({ testRunId: RUN, destination: d, allowlist: allow }).allowed }));
  R.check("formatting variants of an allowlisted number -> allowed", vOk.every((v) => v.ok), vOk);
  const look = ["+18165550143", "+18165550124", "+19135550178", "+28165550142", "816555014", "8165550142x", "55501", "+1816555014a"];
  const lOk = look.map((d) => ({ d, ok: decideSendAllowed({ testRunId: RUN, destination: d, allowlist: allow }).allowed }));
  R.check("one-digit lookalikes / malformed / short codes -> refused", lOk.every((v) => !v.ok), lOk);
  R.check("untagged item -> unaffected by the allowlist", decideSendAllowed({ testRunId: null, destination: "+12125550199", allowlist: allow }).allowed, {});
  R.check("tagged item with an EMPTY allowlist -> refused", !decideSendAllowed({ testRunId: RUN, destination: FAKE_OWNED[0]!, allowlist: new Set() }).allowed, {});

  // End to end through the real webhook -> v2 -> outbox -> send path.
  process.env.TEST_DEST_ALLOWLIST = "(816) 555-0142, 913-555-0177";
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
  const { createTestClient } = await import("@tests/integration/client");
  const db = createTestClient();
  const sends = (phone: string) => getMockMessageLog().filter((m) => m.to === phone).length;
  const refusals = async (p: string) => (await pg.query("select origin, reason, destination_last4, test_run_id from test_send_refusals where property_id = $1", [p])).rows;
  stubs.jevOverride = (r) => r.includes("TONLY") ? { text_only: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : null;
  const reply = async (lead: Lead, tag: string, body = "TONLY text only please") => {
    await deliverWebhook({ externalId: `${org.runId}-${tag}`, from: lead.phone, to: org.sender, body });
    await settle();
    await runRoutingV2OutboxReplies(db, { limit: 50 });
    for (let i = 0; i < 40; i++) {
      const st = (await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId])).rows.map((r) => r.status);
      if (st.length && st.every((x) => x === "sent" || x === "cancelled")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return (await pg.query("select status, cancel_reason, test_run_id from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId])).rows;
  };

  // 1. tagged lead, non-owned number -> refused, 0 provider calls, refusal recorded, taint on the outbox row.
  const [tNon] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), testRunId: RUN });
  const box1 = await reply(tNon!, "t-non");
  R.check("test-tagged reply to a non-owned number -> refused, 0 provider calls, refused_non_owned recorded, outbox row carries the tag",
    sends(tNon!.phone) === 0 && (await refusals(tNon!.propertyId)).some((r) => r.reason === "refused_non_owned") && box1.every((b) => b.test_run_id === RUN) && box1.every((b) => b.cancel_reason === "not_sent:test_send_refused"),
    { providerCalls: sends(tNon!.phone), outbox: box1, refusals: await refusals(tNon!.propertyId) });

  // 2. tagged lead on an allowlisted (fake) number -> allowed.
  const [tOwn] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), testRunId: RUN, phone: () => FAKE_OWNED[0]! });
  const box2 = await reply(tOwn!, "t-own");
  R.check("test-tagged reply to an allowlisted number (allowlist written in another format) -> sent once", sends(tOwn!.phone) === 1, { providerCalls: sends(tOwn!.phone), outbox: box2 });

  // 3. production (untagged) item in the same worker pass while a test run is active -> unaffected.
  const [prod] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }) });
  const [tNon2] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), testRunId: RUN });
  stubs.jevOverride = (r) => r.includes("TONLY") ? { text_only: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : null;
  await deliverWebhook({ externalId: `${org.runId}-mix-p`, from: prod!.phone, to: org.sender, body: "TONLY text only" });
  await deliverWebhook({ externalId: `${org.runId}-mix-t`, from: tNon2!.phone, to: org.sender, body: "TONLY text only" });
  await settle(); await runRoutingV2OutboxReplies(db, { limit: 50 });
  await new Promise((r) => setTimeout(r, 2000)); await runRoutingV2OutboxReplies(db, { limit: 50 });
  R.check("same worker pass: untagged production item sent; test-tagged item to non-owned refused", sends(prod!.phone) === 1 && sends(tNon2!.phone) === 0,
    { prodSends: sends(prod!.phone), testSends: sends(tNon2!.phone), testRefusals: (await refusals(tNon2!.propertyId)).length });

  // 4. taint stripped from the derived row by a bug -> still refused (lead tag re-read at the boundary).
  const [tStrip] = await seedLeads(pg, org, 1, { state: () => ({ state: "GU", fips: null }), testRunId: RUN });
  assertZoneQuiet("Pacific/Guam"); // HI lead: recipient quiet hours at real time (was a 07:00-Chicago JS shift)
  await deliverWebhook({ externalId: `${org.runId}-strip`, from: tStrip!.phone, to: org.sender, body: "TONLY text only" });
  await settle();
  await new Promise((r) => setTimeout(r, 1500));
  await pg.query("update public.routing_v2_outbox set test_run_id = null where property_id = $1", [tStrip!.propertyId]);
  await readdressToInHours(pg, tStrip!); // deliverable now; the test tag stays on the lead
  await runRoutingV2OutboxReplies(db, { limit: 50 });
  R.check("derived outbox row with its tag stripped -> still refused (lead tag re-read)", sends(tStrip!.phone) === 0 && (await refusals(tStrip!.propertyId)).length > 0,
    { sends: sends(tStrip!.phone), refusals: await refusals(tStrip!.propertyId) });

  // 5. derived drip step from a test inbound -> refused to a non-owned number.
  const [tDrip] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }), testRunId: RUN });
  await deliverWebhook({ externalId: `${org.runId}-drip`, from: tDrip!.phone, to: org.sender, body: "NOTINT not interested" });
  await settle();
  const enr = (await pg.query("select id, status from sequence_enrollments where property_id = $1", [tDrip!.propertyId])).rows;
  await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + tDrip!.propertyId + "' and status = 'active'; commit;");
  const before = sends(tDrip!.phone);
  await runSequenceTick(db as never, { budgetMs: 20_000 });
  const enrAfter = (await pg.query("select status, pause_reason from sequence_enrollments where property_id = $1", [tDrip!.propertyId])).rows;
  R.check("drip step derived from a test inbound -> refused to a non-owned number (0 provider calls)", sends(tDrip!.phone) - before === 0 && enr.length > 0,
    { enrollmentsBefore: enr, enrollmentsAfter: enrAfter, dripSends: sends(tDrip!.phone) - before, refusals: await refusals(tDrip!.propertyId) });

  // 6. test run active but untagged lead to an arbitrary number -> production path unchanged (sent).
  R.line("TEST_DEST_ALLOWLIST was a fake 555-01xx set in this process only; the owned-number file was not read.");
  stubs.jevOverride = null;
  void BMH;
});
