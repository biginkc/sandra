import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import type { NineQuestionId } from "@/lib/sms-classification/nine-questions";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { compareSnapshots, deleteTagged, snapshot, type Snapshot } from "./cleanup";
import { assertStressDbEnv, mulberry32, stubProbabilities } from "./core";
import { loadCorpus } from "./corpus";
import { asUser, ensureCanaryOrg, installStubJev, seedBystanders, seedLead, seedOwner, seedResponderConfig } from "./d-lane-fixture";

/**
 * Messages v2 Stage 5, Run 6 (kill switches mid-burst) + Run 7 (cleanup proof), D LANE ONLY.
 *
 * A burst of stub inbound texts goes through the REAL dispatchAiResponse (stub Jev, mock SMS provider) on a
 * DISPOSABLE stack, in the canary-style org. Mid-burst, each rule switch is flipped off through the owner-only
 * RPC the rules panel uses (called as an active org owner: role authenticated + JWT claims), and separately
 * outbound_mode is set to 'hold' through the owner's RLS update. Each is restored after its window.
 *
 * Gates (STRESS-PLAN Run 6):
 *   - after a flip is committed, ZERO controlled actions on every following text of that shape (within one text)
 *   - outbound_mode=hold: ZERO sends (no outbound message row, no mock-provider send)
 *   - after restore: no held text is sent late or twice; the next 20 texts are 100% handled
 *   - retry/replay: re-dispatching an already handled inbound produces no second send, run or alert
 * Run 7 gates: tag-only deletes; every untagged count identical before seeding and after cleanup; 0 tagged left.
 *
 *   MV2_STRESS_BURSTS   default 3     MV2_STRESS_RUN_ID   default ks-<epoch>     MV2_STRESS_OUT_DIR
 * Run: npm run stress:messages-v2:kill-switch
 */
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));

const BURSTS = Number(process.env.MV2_STRESS_BURSTS ?? "3");
const RUN_ID = process.env.MV2_STRESS_RUN_ID ?? `ks-${Date.now()}`;
const OUT = path.resolve(process.env.MV2_STRESS_OUT_DIR ?? "test-results/messages-v2-stress");
const NO_ANTHROPIC: AnthropicLike = {
  messages: { create: async () => { throw new Error("Claude must not be called on the nine-question path"); } } as unknown as AnthropicLike["messages"],
};

const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const supabase = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const realFetch = globalThis.fetch;
let orgId = "";
let ownerId = "";
let configId = "";
let seqIds: string[] = [];
let nextStub: Record<NineQuestionId, number> | null = null;
const jev = { calls: 0 };
const rnd = mulberry32(20261016);
let leadN = 0;

type Effect = { outbound: number; enrollments: number; status: string | null; dispo: string | null; hold: boolean; pendingDrafts: number; runs: number; alerts: number };
type Shape = { scenario: string; controls: "any" | "enrollment" };

/** Switch -> the corpus shape it governs and the action it controls. */
const SWITCHES: Array<{ name: string; shape: Shape; off: () => Promise<void>; on: () => Promise<void> }> = [];

async function effectOf(propertyId: string): Promise<Effect> {
  const [{ rows: m }, { rows: e }, { rows: p }, { rows: d }, { rows: r }] = await Promise.all([
    pg.query("select count(*)::int c from public.messages where property_id = $1 and direction = 'outbound'", [propertyId]),
    pg.query("select count(*)::int c from public.sequence_enrollments where property_id = $1", [propertyId]),
    pg.query("select status, outreach_dispo, needs_human_attention from public.properties where id = $1", [propertyId]),
    pg.query("select count(*)::int c from public.ai_reply_drafts where property_id = $1 and status = 'pending'", [propertyId]),
    pg.query("select count(*)::int c from public.pipeline_runs where property_id = $1", [propertyId]),
  ]);
  const { rows: a } = await pg.query("select count(*)::int c from public.hold_alert_deliveries where property_id = $1", [propertyId]).catch(() => ({ rows: [{ c: 0 }] }));
  const { rows: dec } = await pg.query("select count(*)::int c from public.jev_lead_decisions where property_id = $1 and status = 'pending'", [propertyId]);
  return { outbound: m[0].c, enrollments: e[0].c, status: p[0].status, dispo: p[0].outreach_dispo, hold: p[0].needs_human_attention || d[0].c > 0 || dec[0].c > 0, pendingDrafts: d[0].c, runs: r[0].c, alerts: a[0].c };
}

const acted = (e: Effect, controls: Shape["controls"]) =>
  controls === "enrollment" ? e.enrollments > 0 : e.outbound > 0 || e.enrollments > 0 || e.status !== "prospect" || e.dispo !== null;

type Row = { burst: number; phase: string; switch: string; scenario: string; propertyId: string; inboundId: string; conversationId: string; effect: Effect; acted: boolean; outcome: string };
const rows: Row[] = [];

async function sendText(burst: number, phase: string, sw: string, shape: Shape): Promise<Row> {
  const s = loadCorpus().find((x) => x.id === shape.scenario)!;
  const wording = s.wordings[leadN % s.wordings.length];
  nextStub = stubProbabilities(s.expected_answers, { noise: 0, rnd });
  const lead = await seedLead(supabase, orgId, RUN_ID, ++leadN);
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: s.our_last_text, created_at: new Date(Date.now() - 3600_000).toISOString() });
  const { data: inbound, error } = await supabase
    .from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: wording })
    .select("id, conversation_id")
    .single();
  expect(error).toBeNull();
  const out = await dispatchAiResponse(
    supabase,
    { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound!.conversation_id as string, inboundMessageId: inbound!.id, inboundBody: wording, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
    { anthropic: NO_ANTHROPIC },
  );
  const effect = await effectOf(lead.propertyId);
  // The seeded "our last text" is one outbound row; only rows beyond it are Sandra's.
  effect.outbound -= 1;
  const row: Row = { burst, phase, switch: sw, scenario: s.id, propertyId: lead.propertyId, inboundId: inbound!.id, conversationId: inbound!.conversation_id as string, effect, acted: acted(effect, shape.controls), outcome: `${(out as { outcome: string }).outcome}:${(out as { reason?: string }).reason ?? ""}` };
  rows.push(row);
  return row;
}

async function thresholdAutomation(outcome: string, enabled: boolean) {
  const { rows: t } = await pg.query("select version from public.jev_outcome_thresholds where org_id = $1 and outcome = $2", [orgId, outcome]);
  await asUser(pg, ownerId, () =>
    pg.query("select public.fn_set_jev_outcome_threshold($1, $2, 0.9, $3, gen_random_uuid(), $4)", [orgId, outcome, t[0].version, enabled]),
  );
}
const ruleSwitch = (name: string, value: string) => asUser(pg, ownerId, () => pg.query("select public.fn_set_ai_rule_switch($1, $2, $3)", [configId, name, value]));
const autoDrip = (enabled: boolean) =>
  asUser(pg, ownerId, () => pg.query("select public.fn_set_nurture_auto_drip($1, $2, $3, $3, $3, $3)", [configId, enabled, seqIds[0]]));
async function outboundMode(mode: "send" | "hold") {
  const res = await asUser(pg, ownerId, () => pg.query("update public.ai_responder_configs set outbound_mode = $2 where id = $1", [configId, mode]));
  expect(res.rowCount, "owner's RLS update of outbound_mode must touch exactly the config row").toBe(1);
}

SWITCHES.push(
  { name: "new_lead (Open to selling / Talked price)", shape: { scenario: "open_plain", controls: "any" }, off: () => thresholdAutomation("new_lead", false), on: () => thresholdAutomation("new_lead", true) },
  { name: "nurture (Maybe later reply)", shape: { scenario: "maybe_later_plain", controls: "any" }, off: () => thresholdAutomation("nurture", false), on: () => thresholdAutomation("nurture", true) },
  { name: "not_interested", shape: { scenario: "not_interested_plain", controls: "any" }, off: () => thresholdAutomation("not_interested", false), on: () => thresholdAutomation("not_interested", true) },
  { name: "wrong_number (Wrong person)", shape: { scenario: "wrong_person_plain", controls: "any" }, off: () => thresholdAutomation("wrong_number", false), on: () => thresholdAutomation("wrong_number", true) },
  { name: "nine_identity_reply (Asked who)", shape: { scenario: "asked_who_plain", controls: "any" }, off: () => ruleSwitch("nine_identity_reply", "false").then(() => undefined), on: () => ruleSwitch("nine_identity_reply", "true").then(() => undefined) },
  { name: "nine_confirmed_owner_drip (Confirmed owner)", shape: { scenario: "confirmed_owner_long", controls: "enrollment" }, off: () => ruleSwitch("nine_confirmed_owner_drip", "false").then(() => undefined), on: () => ruleSwitch("nine_confirmed_owner_drip", "true").then(() => undefined) },
  { name: "nurture_auto_drip (Maybe later drip)", shape: { scenario: "maybe_later_plain", controls: "enrollment" }, off: () => autoDrip(false).then(() => undefined), on: () => autoDrip(true).then(() => undefined) },
);
const REPLY_SHAPES: Shape[] = ["maybe_later_plain", "not_interested_plain", "wrong_person_plain", "asked_who_plain"].map((scenario) => ({ scenario, controls: "any" as const }));

let before: Snapshot;

describe("Messages v2 Stage 5 Run 6 + Run 7 (D lane, disposable stack, mock provider, stub Jev)", () => {
  beforeAll(async () => {
    assertStressDbEnv(process.env);
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await pg.connect();
    process.env.MESSAGING_PROVIDER = "mock";
    process.env.TYPESAFE_API_KEY = "stub-key";
    resetMockState();
    installStubJev(realFetch, () => nextStub, jev);
    orgId = await ensureCanaryOrg(supabase);
    // Run 7 baseline BEFORE anything tagged is seeded (after the untagged bystanders cleanup must leave alone).
    await seedBystanders(pg, RUN_ID);
    before = await snapshot(pg, orgId, RUN_ID);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
    ownerId = await seedOwner(pg, orgId);
    ({ configId, seqIds } = await seedResponderConfig(pg, supabase, orgId));
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.end();
  });

  it("flips every switch and outbound_mode mid-burst: holds instead of actions, zero sends on hold, no double-sends, replay is inert", async () => {
    const failures: string[] = [];
    for (let burst = 1; burst <= BURSTS; burst++) {
      for (const sw of SWITCHES) {
        for (let i = 0; i < 2; i++) {
          const r = await sendText(burst, "before", sw.name, sw.shape);
          if (!r.acted) failures.push(`burst ${burst} ${sw.name}: switch ON but no action (${r.outcome}); the flip below would prove nothing`);
        }
        await sw.off();
        for (let i = 0; i < 3; i++) {
          const r = await sendText(burst, "off", sw.name, sw.shape);
          if (r.acted) failures.push(`burst ${burst} ${sw.name}: action taken AFTER the flip (text ${i + 1}, ${r.outcome})`);
        }
        await sw.on();
        for (let i = 0; i < 2; i++) {
          const r = await sendText(burst, "restored", sw.name, sw.shape);
          if (!r.acted) failures.push(`burst ${burst} ${sw.name}: no action after restore (${r.outcome})`);
        }
      }

      // outbound_mode = hold: zero sends while on hold.
      const providerBefore = getMockMessageLog().length;
      await outboundMode("hold");
      const held: Row[] = [];
      for (let i = 0; i < 8; i++) held.push(await sendText(burst, "outbound_hold", "outbound_mode", REPLY_SHAPES[i % REPLY_SHAPES.length]));
      const providerDuring = getMockMessageLog().length - providerBefore;
      const heldSends = held.filter((r) => r.effect.outbound > 0);
      if (providerDuring !== 0 || heldSends.length) failures.push(`burst ${burst} outbound_mode=hold: ${providerDuring} provider sends, ${heldSends.length} outbound rows`);
      await outboundMode("send");
      // After restore: the next 20 texts are handled, and nothing held goes out late or twice.
      for (let i = 0; i < 20; i++) {
        const r = await sendText(burst, "after_hold", "outbound_mode", REPLY_SHAPES[i % REPLY_SHAPES.length]);
        if (!r.acted) failures.push(`burst ${burst} after outbound_mode restore: text ${i + 1} not handled (${r.outcome})`);
      }
      for (const h of held) {
        const now = await effectOf(h.propertyId);
        if (now.outbound - 1 !== 0) failures.push(`burst ${burst}: held text on ${h.propertyId} was sent after restore (${now.outbound - 1} outbound)`);
      }

      // Retry / replay: re-dispatch already handled inbounds (one per shape) with the same inbound id.
      const replayable = rows.filter((r) => r.burst === burst && (r.phase === "before" || r.phase === "after_hold")).filter((_, i) => i % 4 === 0);
      for (const r of replayable) {
        const pre = await effectOf(r.propertyId);
        const providerPre = getMockMessageLog().length;
        const s = loadCorpus().find((x) => x.id === r.scenario)!;
        nextStub = stubProbabilities(s.expected_answers, { noise: 0, rnd });
        const { data: msg } = await supabase.from("messages").select("body, contact_id, from_address").eq("id", r.inboundId).single();
        await dispatchAiResponse(
          supabase,
          { propertyId: r.propertyId, contactId: msg!.contact_id as string, conversationId: r.conversationId, inboundMessageId: r.inboundId, inboundBody: msg!.body as string, inboundFromPhone: msg!.from_address as string, inboundToPhone: MOCK_SENDER_PRIMARY },
          { anthropic: NO_ANTHROPIC },
        ).catch((e) => failures.push(`burst ${burst} replay ${r.inboundId} threw: ${e instanceof Error ? e.message : String(e)}`));
        const post = await effectOf(r.propertyId);
        const extra = getMockMessageLog().length - providerPre;
        if (post.outbound !== pre.outbound || extra !== 0 || post.alerts !== pre.alerts || post.enrollments !== pre.enrollments) {
          failures.push(`burst ${burst} replay ${r.scenario}: second effect (outbound ${pre.outbound}->${post.outbound}, provider +${extra}, alerts ${pre.alerts}->${post.alerts}, enrollments ${pre.enrollments}->${post.enrollments})`);
        }
        rows.push({ ...r, phase: "replay", effect: { ...post, outbound: post.outbound - 1 }, acted: post.outbound !== pre.outbound });
      }
    }

    const offRows = rows.filter((r) => r.phase === "off");
    const holdAfterFlip = offRows.filter((r) => r.effect.hold).length;
    const report = {
      lane: "D",
      runId: RUN_ID,
      bursts: BURSTS,
      texts: rows.filter((r) => r.phase !== "replay").length,
      flips: BURSTS * (SWITCHES.length + 1),
      offTexts: offRows.length,
      actionsAfterFlip: offRows.filter((r) => r.acted).length,
      holdsAfterFlip: holdAfterFlip,
      perSwitchHold: Object.fromEntries(SWITCHES.map((s) => [s.name, `${offRows.filter((r) => r.switch === s.name && r.effect.hold).length}/${offRows.filter((r) => r.switch === s.name).length}`])),
      outboundHoldTexts: rows.filter((r) => r.phase === "outbound_hold").length,
      outboundHoldSends: rows.filter((r) => r.phase === "outbound_hold" && r.effect.outbound > 0).length,
      afterHoldHandled: `${rows.filter((r) => r.phase === "after_hold" && r.acted).length}/${rows.filter((r) => r.phase === "after_hold").length}`,
      replays: rows.filter((r) => r.phase === "replay").length,
      jevStubCalls: jev.calls,
      providerSendsTotal: getMockMessageLog().length,
      failures,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "kill-switch-report.json"), JSON.stringify({ report, rows }, null, 1));
    console.log(JSON.stringify(report, null, 2));
    expect(failures).toEqual([]);
  }, 3_600_000);

  it("Run 7: tag-only cleanup leaves every untagged count unchanged and no tagged row behind", async () => {
    const mid = await snapshot(pg, orgId, RUN_ID);
    const del = await deleteTagged(pg, orgId, RUN_ID);
    const after = await snapshot(pg, orgId, RUN_ID);
    const verdict = compareSnapshots(before, after);
    writeFileSync(path.join(OUT, "kill-switch-cleanup.json"), JSON.stringify({ before, mid, deleted: del, after, verdict }, null, 1));
    console.log(JSON.stringify({ before: before.sha256, after: after.sha256, deleted: del, verdict }, null, 2));
    expect(Object.values(mid.tables).some((t) => t.tagged > 0)).toBe(true);
    // The bystanders are real untagged rows (so 0 -> 0 cannot pass vacuously) and survive.
    expect(before.tables.properties.untagged).toBeGreaterThanOrEqual(3);
    expect(verdict).toEqual({ ok: true, changedUntagged: [], taggedLeft: [] });
  }, 600_000);
});
