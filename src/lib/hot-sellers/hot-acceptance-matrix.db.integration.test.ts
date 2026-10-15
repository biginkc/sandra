import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { attachHotAlertTimes } from "@/app/(dashboard)/messages-v2/hot-alert-times";
import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { deriveTape } from "@/app/(dashboard)/messages-v2/tape";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "@/app/(dashboard)/messages-v2/types";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { createHoldAlertDeps } from "@/lib/hold-alerts";
import { runHoldAlertsForOrg } from "@/lib/hold-alerts/core";
import type { HoldAlertDeps } from "@/lib/hold-alerts/types";
import { finishRunFromOutcome } from "@/lib/pipeline-runs/outcome";
import { startRun } from "@/lib/pipeline-runs/record";
import { resetMockState } from "@/lib/messaging/providers/mock";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { assignHotLeadToOwner, HOT_FAILED_SOURCE_TYPE, HOT_HANDOFF_SOURCE_TYPE } from "./assign";

/**
 * Hot-seller acceptance matrix (Messages v2 PR 2, "Alert and hand-off model") on a DISPOSABLE database that has
 * every migration. Local only; runs in CI in the "Search RPC, oracle and composition suites (disposable DB)" job.
 *
 * One table, one fresh temporary organization per row. Each row drives the REAL dispatch
 * (dispatchAiResponse, Jev automatic, new_lead switch on, fake Jev over a stubbed fetch) and the REAL alert pass
 * (runHoldAlertsForOrg with createHoldAlertDeps), recording only the two senders. Each row pins the exact count of
 * Slack messages, SMS messages and hot-seller `assigned` ledger events, and (where one applies) the tape line.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const admin = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const created = { orgs: [] as string[], users: [] as string[] };
const realFetch = globalThis.fetch;
let jevOutcome: "new_lead" | "nurture" = "new_lead";
// Set explicitly for EVERY dispatch (no hot default): a "non-hot" follow-up must say so.
let jevEscalation = "not_applicable";
let jevTimeframe: string | null = null;

function installFakeJev() {
  vi.stubEnv("TYPESAFE_API_KEY", "fake-test-key");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      return new Response(
        JSON.stringify({
          model: "jev-fake",
          answers: {
            outcome: { choice: jevOutcome, confidence: 0.95, probabilities: { [jevOutcome]: 0.95 } },
            escalation_reason: { choice: jevEscalation, probabilities: { [jevEscalation]: 0.9 } },
            ...(jevTimeframe ? { ready_timeframe: { choice: jevTimeframe, probabilities: { [jevTimeframe]: 0.9 } } } : {}),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP in test: ${url}`);
    return realFetch(input, init);
  });
}

const forbiddenAnthropic: AnthropicLike = {
  messages: {
    create: async () => {
      throw new Error("legacy Anthropic classifier must not run for a Jev automatic org");
    },
  } as unknown as AnthropicLike["messages"],
};

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
  for (const table of ["hold_alert_deliveries", "hold_alert_settings"]) {
    const { rows } = await pg.query("select to_regclass($1) as t", [`public.${table}`]);
    expect(rows[0].t, `${table} must exist (migration missing)`).toBeTruthy();
  }
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  try {
    for (const orgId of created.orgs) {
      try {
        await pg.query("begin");
        await pg.query("set local session_replication_role = replica");
        const { rows } = await pg.query<{ table_name: string; column_name: string }>(`
          select c.table_name, c.column_name
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
            and c.column_name in ('property_id', 'contact_id', 'conversation_id', 'org_id')
        `);
        const by = (col: string) => rows.filter((r) => r.column_name === col).map((r) => r.table_name);
        const skip = new Set(["properties", "contacts", "conversations", "organizations"]);
        const reopen = async () => {
          await pg.query("rollback");
          await pg.query("begin");
          await pg.query("set local session_replication_role = replica");
        };
        for (const [col, scope] of [
          ["property_id", "select id from public.properties where org_id = $1"],
          ["contact_id", "select id from public.contacts where org_id = $1"],
          ["conversation_id", "select id from public.conversations where org_id = $1"],
        ] as const) {
          for (const table of by(col)) {
            if (skip.has(table)) continue;
            await pg.query(`delete from public."${table}" where "${col}" in (${scope})`, [orgId]).catch(reopen);
          }
        }
        for (const table of by("org_id")) {
          if (table === "organizations") continue;
          await pg.query(`delete from public."${table}" where org_id = $1`, [orgId]).catch(reopen);
        }
        await pg.query("delete from public.organizations where id = $1", [orgId]);
        await pg.query("commit");
      } catch {
        await pg.query("rollback").catch(() => undefined);
      }
    }
    if (created.users.length) {
      await pg.query("delete from auth.users where id = any($1::uuid[])", [created.users]).catch(() => undefined);
    }
  } finally {
    await pg.end();
  }
}, 120_000);

async function createMember(orgId: string, role: "owner" | "member"): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `hot-matrix-${randomUUID()}@test.local`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user create failed: ${error?.message}`);
  created.users.push(data.user.id);
  const { error: membershipError } = await admin.from("memberships").insert({ user_id: data.user.id, org_id: orgId, role });
  if (membershipError) throw new Error(`membership insert failed: ${membershipError.message}`);
  return data.user.id;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pg.query(sql, params);
  return Number(rows[0].n);
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function makeHarness(opts: { assigned?: "owner" | "rep" } = {}) {
  resetMockState();
  jevOutcome = "new_lead";
  jevEscalation = "not_applicable";
  jevTimeframe = null;
  installFakeJev();

  const orgId = randomUUID();
  const { error: orgError } = await admin.from("organizations").insert({ id: orgId, name: `hot-matrix ${orgId}` });
  if (orgError) throw new Error(`org insert failed: ${orgError.message}`);
  created.orgs.push(orgId);

  const owner = await createMember(orgId, "owner");
  const rep = await createMember(orgId, "member");

  await pg.query("insert into public.acquisition_org_settings (org_id, my_leads_enabled) values ($1, true)", [orgId]);
  await pg.query("begin");
  try {
    await pg.query("select set_config('my_leads.designation_update', $1, true)", [`:${orgId}:${owner}`]);
    await pg.query("update public.memberships set acquisitions_enabled = true where org_id = $1 and user_id = $2", [orgId, owner]);
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  }

  const { error: configError } = await admin.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "hot matrix test prompt",
    business_hours_only: false,
    classifier_provider: "jev",
    classifier_mode: "automatic",
    active: true,
  });
  if (configError) throw new Error(`ai_responder_configs insert failed: ${configError.message}`);
  await pg.query(
    "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'new_lead', 0.9, true)",
    [orgId],
  );

  const phone = `+1816${String(Math.floor(5_000_000 + Math.random() * 4_000_000))}`;
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({ org_id: orgId, first_name: "Hannah", last_name: "Seller", phone_1: phone, phone_1_type: "mobile" })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(`contact insert failed: ${contactError?.message}`);
  const { error: consentError } = await admin.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "hot-matrix-test",
  });
  if (consentError) throw new Error(`consent insert failed: ${consentError.message}`);

  const { data: property, error: propertyError } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      address: "12 Matrix Ln",
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
      ...(opts.assigned === "owner" ? { assigned_user_id: owner } : opts.assigned === "rep" ? { assigned_user_id: rep } : {}),
    })
    .select("id")
    .single();
  if (propertyError || !property) throw new Error(`property insert failed: ${propertyError?.message}`);
  const propertyId = property.id;

  // Alerts were enabled before the test started.
  const { error: seedError } = await admin
    .from("hold_alert_settings" as never)
    .insert({ org_id: orgId, alerts_since: new Date(Date.now() - 60 * 60 * 1000).toISOString() } as never);
  if (seedError) throw new Error(`hold_alert_settings seed failed: ${seedError.message}`);

  const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
  const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
  const baseDeps: HoldAlertDeps = {
    ...real,
    async sendSlack(userId, text) {
      sent.push({ channel: "slack", userId, text });
      return { status: "sent" };
    },
    async sendSms(userId, text) {
      sent.push({ channel: "sms", userId, text });
      return { status: "sent" };
    },
  };

  const newInbound = async (body = "yes I might sell, what could you pay for it?", createdAt?: string): Promise<string> => {
    const { data, error } = await admin
      .from("messages")
      .insert({
        org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: propertyId,
        contact_id: contact.id, from_address: phone, to_address: "+18165550100", body,
        ...(createdAt ? { created_at: createdAt } : {}),
      })
      .select("id, conversation_id")
      .single();
    if (error || !data) throw new Error(`inbound insert failed: ${error?.message}`);
    conversationId ??= data.conversation_id;
    bodies.set(data.id, body);
    return data.id;
  };
  let conversationId: string | null = null;
  const bodies = new Map<string, string>();

  /** Both Jev answers are explicit on every call: outcome and escalation reason (HOT_ESC or NON_HOT_ESC). */
  const dispatch = async (
    inboundMessageId: string,
    jev: "new_lead" | "nurture",
    escalation: string,
    opts: { timeframe?: string } = {},
  ) => {
    jevOutcome = jev;
    jevEscalation = escalation;
    jevTimeframe = opts.timeframe ?? null;
    const body = bodies.get(inboundMessageId) ?? "yes I might sell";
    const runContext = await startRun(admin, {
      orgId, inboundMessageId, propertyId, contactId: contact.id, conversationId, mode: "automatic", inboundPreview: "matrix",
    });
    const outcome = await dispatchAiResponse(
      admin,
      { propertyId, contactId: contact.id, conversationId: conversationId!, inboundMessageId, inboundFromPhone: phone, inboundBody: body },
      { anthropic: forbiddenAnthropic, runContext },
    );
    // Stamp the run's real final outcome/reason, as the production caller does.
    if (outcome.outcome !== "retry") await finishRunFromOutcome(admin, runContext, outcome);
    return outcome;
  };

  /** What the pipeline run for one inbound finally recorded (the classification the row claims). */
  const runOf = async (inboundMessageId: string): Promise<{ final_outcome: string | null; reason: string | null }> => {
    const { data } = await admin.from("pipeline_runs").select("final_outcome, reason").eq("inbound_message_id", inboundMessageId).maybeSingle();
    return { final_outcome: (data?.final_outcome as string | null) ?? null, reason: (data?.reason as string | null) ?? null };
  };

  /** Exactly one Slack and one SMS exist in total: in the senders AND as delivery rows (no seeded cap rows are counted). */
  const expectOneAlertTotal = async () => {
    expect(h_slack()).toBe(1);
    expect(h_sms()).toBe(1);
    const { rows } = await pg.query(
      "select channel, count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and hold_key not like 'seed-%' and status = 'sent' group by channel order by channel",
      [orgId],
    );
    expect(rows.map((r) => [r.channel, r.n])).toEqual([["slack", 1], ["sms", 1]]);
  };
  const h_slack = () => sent.filter((x) => x.channel === "slack").length;
  const h_sms = () => sent.filter((x) => x.channel === "sms").length;

  const alertPass = (over: Partial<HoldAlertDeps> = {}) => runHoldAlertsForOrg({ ...baseDeps, ...over }, orgId);

  const handoffEvents = () =>
    count(
      "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned' and source_type = $2",
      [propertyId, HOT_HANDOFF_SOURCE_TYPE],
    );

  const assignee = async () => (await admin.from("properties").select("assigned_user_id").eq("id", propertyId).single()).data?.assigned_user_id ?? null;

  /** The tape card for one inbound's run, as text (sentence + "what she did" line). */
  const tape = async (inboundMessageId: string): Promise<string> => {
    const { data: run } = await admin.from("pipeline_runs").select("*").eq("inbound_message_id", inboundMessageId).maybeSingle();
    if (!run) return "NO RUN";
    const { data: steps } = await admin.from("pipeline_run_steps").select("*").eq("run_id", run.id).order("seq", { ascending: true });
    const withSteps: RunWithSteps = { ...(run as unknown as PipelineRun), steps: (steps ?? []) as unknown as PipelineRunStep[] };
    const [attached] = await attachHotAlertTimes(admin as unknown as LooseSupabase, orgId, [withSteps]);
    const view = deriveTape(attached!, "Hannah", null);
    return view.kind === "decided" ? `${view.sentence} | ${view.did ?? ""}` : view.kind === "quiet" ? view.text : view.kind === "error" ? view.sentence : "reading";
  };

  /** Block any change to the assignment column of this property. */
  const blockAssignment = async () => {
    const fn = `hot_mx_block_${propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin
      if new.assigned_user_id is distinct from old.assigned_user_id then raise exception 'blocked for test'; end if; return new; end $$`);
    await pg.query(`create trigger ${fn} before update on public.properties for each row when (new.id = '${propertyId}') execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.properties`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  };

  /** A rep wins the race: the trigger gives the lead to the rep and skips Sandra's guarded write. */
  const repWinsRace = async () => {
    const fn = `hot_mx_race_${propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin
      if old.assigned_user_id is null and new.assigned_user_id is not null and new.assigned_user_id <> '${rep}' then
        update public.properties set assigned_user_id = '${rep}' where id = '${propertyId}';
        return null;
      end if;
      return new; end $$`);
    await pg.query(`create trigger ${fn} before update on public.properties for each row when (new.id = '${propertyId}') execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.properties`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  };

  /** Block every lead_events insert of one source_type for this property (the hand-off/failure ledger write fails). */
  const blockLeadEvents = async (sourceType: string) => {
    const fn = `hot_mx_ledger_${propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin
      raise exception 'ledger blocked for test'; end $$`);
    await pg.query(`create trigger ${fn} before insert on public.lead_events for each row when (new.property_id = '${propertyId}' and new.source_type = '${sourceType}') execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.lead_events`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  };

  /** The property's flag write silently does nothing (an UPDATE that would set needs_human_attention is skipped). */
  const noopFlagWrites = async () => {
    const fn = `hot_mx_noflag_${propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin
      if new.needs_human_attention is true and old.needs_human_attention is distinct from true then return null; end if; return new; end $$`);
    await pg.query(`create trigger ${fn} before update on public.properties for each row when (new.id = '${propertyId}') execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.properties`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  };

  /** The hand-off event payload for one inbound (covered_by_hold etc.). */
  const handoffPayload = async (inboundMessageId: string): Promise<{ covered_by_hold?: boolean } | null> => {
    const { rows } = await pg.query("select payload from public.lead_events where property_id = $1 and source_type = $2 and source_id = $3", [propertyId, HOT_HANDOFF_SOURCE_TYPE, inboundMessageId]);
    return rows[0]?.payload ?? null;
  };

  /** Seed this hour's DM and SMS caps as already used (20 Slack DMs, 10 SMS). */
  const useUpCaps = async () => {
    for (const [channel, n, label] of [["slack", 20, "dm"], ["sms", 10, "sms"]] as const) {
      for (let i = 0; i < n; i++) {
        await pg.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
           values ($1, null, $2, $3, $4, 'first', 'sent', 1, now())`,
          [orgId, `seed-${label}-${i}`, owner, channel],
        );
      }
    }
  };

  /** The alert key of the property's CURRENT open flag: hot_flag:<property>:<flagAt>. */
  const flagKey = async (): Promise<string> => {
    const { data } = await admin.from("properties").select("last_ai_escalation_at").eq("id", propertyId).single();
    return `hot_flag:${propertyId}:${data?.last_ai_escalation_at}`;
  };

  const deliveryRows = async (holdKey: string) =>
    (await pg.query("select channel, status from public.hold_alert_deliveries where org_id = $1 and hold_key = $2 order by channel", [orgId, holdKey])).rows.map((r) => [r.channel as string, r.status as string]);

  const flag = (reason: string, at: string | null) =>
    admin
      .from("properties")
      .update({ needs_human_attention: true, needs_human_attention_since: at ?? new Date().toISOString(), last_ai_escalation_reason: reason, last_ai_escalation_at: at } as never)
      .eq("id", propertyId)
      .then(({ error }) => {
        if (error) throw new Error(`flag failed: ${error.message}`);
      });

  /**
   * An ordinary NON-hot hold from before the cutoff that does NOT set the property flag (a flagged property
   * is never dispatched at all): a pending disposition review created on 2026-10-14.
   */
  const preCutoffReviewHold = async () => {
    const earlier = await newInbound("not interested");
    await pg.query(
      `insert into public.ai_disposition_reviews (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, created_at)
       values ($1, $2, $3, $4, 'not_interested', 'matrix', 'pending', '2026-10-14T12:00:00.000Z')`,
      [orgId, propertyId, conversationId, earlier],
    );
  };

  return {
    orgId, owner, rep, propertyId, sent, baseDeps, newInbound, dispatch, alertPass, handoffEvents, assignee, tape, runOf, expectOneAlertTotal,
    blockAssignment, repWinsRace, flag, preCutoffReviewHold, blockLeadEvents, noopFlagWrites, flagKey, handoffPayload, useUpCaps, deliveryRows,
    slack: () => sent.filter((s) => s.channel === "slack").length,
    sms: () => sent.filter((s) => s.channel === "sms").length,
    deliveryKeys: async () =>
      (await pg.query("select distinct hold_key from public.hold_alert_deliveries where org_id = $1 order by hold_key", [orgId])).rows.map((r) => r.hold_key as string),
  };
}

const HANDED = "Handed to Jarrad · now on My Leads";
const HOT_TEXT_LINE = "Already on My Leads under Jarrad";
const RACE_LINE = "Already a lead, left for the person who owns it";
/** Jev escalation answers: HOT_ESC is a hot reason; NON_HOT_ESC means "no human follow-up", never hot. */
const HOT_ESC = "price_or_offer";
const NON_HOT_ESC = "not_applicable";

type Row = {
  id: string;
  name: string;
  /** Final totals across the whole row (Slack messages, SMS messages, hot-seller `assigned` events). */
  expect: { slack: number; sms: number; assigned: number };
  setup?: { assigned?: "owner" | "rep" };
  run: (h: Harness) => Promise<void>;
};

const ROWS: Row[] = [
  {
    id: "1",
    name: "first hot text on an unassigned lead: handed to Jarrad, one Slack, one SMS, one assigned event, tape says so",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.assignee()).toBe(h.owner);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`]);
      expect(await h.tape(a)).toContain(HANDED);
      expect(h.sent.every((x) => x.userId === h.owner && x.text.startsWith("Hot seller:"))).toBe(true);
    },
  },
  {
    id: "2",
    name: "retry of row 1's inbound (dispatch, direct hand-off, alert pass): nothing more",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      await h.alertPass();
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).not.toMatchObject({ outcome: "sent" });
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: a })).toEqual({ status: "already_assigned", assigneeUserId: h.owner });
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "3",
    name: "second hot text on the same lead: one more Slack + SMS 'Hot text on your lead', no new assigned event",
    expect: { slack: 2, sms: 2, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      await h.alertPass();
      const b = await h.newInbound("please call me, I want to sell this week");
      await h.dispatch(b, "new_lead", HOT_ESC);
      expect((await h.alertPass()).sent).toBe(2);
      expect(h.sent.slice(2).every((x) => x.text.startsWith("Hot text on your lead: Hannah, 12 Matrix Ln."))).toBe(true);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`, `hot_text:${b}`].sort());
      expect(await h.tape(b)).toContain(HOT_TEXT_LINE);
    },
  },
  {
    id: "4",
    name: "hot text leaves an OPEN failed-hand-off hold: one alert (hot_flag:<property>:<flagAt>); a non-hot text and a later hand-off on a new text (covered by that alerted hold) add nothing",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead_assign_failed" });
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      // A NON-hot text while the hold is open.
      const b = await h.newInbound("who is this?");
      // The flagged lead is not dispatched again: the run records a skip, not a new classification.
      expect(await h.dispatch(b, "nurture", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.runOf(b)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      // Hold still open: Sandra later hands the lead off on another text. The event is covered by the hold: no new ping.
      const c = await h.newInbound("ok seriously, what is your best number?");
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: c })).toEqual({ status: "assigned", assigneeUserId: h.owner });
      const { rows } = await pg.query(
        "select payload from public.lead_events where property_id = $1 and source_type = $2",
        [h.propertyId, HOT_HANDOFF_SOURCE_TYPE],
      );
      expect((rows[0].payload as { covered_by_hold?: boolean }).covered_by_hold).toBe(true);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "5",
    name: "hot hold flagged before the 2026-10-15 cutoff + a post-cutoff non-hot text: silent",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("hot_lead", "2026-10-14T12:00:00.000Z");
      const b = await h.newInbound("who is this?");
      await h.dispatch(b, "nurture", NON_HOT_ESC);
      const pass = await h.alertPass();
      expect(pass.holds).toBe(1);
      expect(pass.sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "5b",
    name: "pre-cutoff hot hold + a post-cutoff hot text that hands off: one Slack + SMS (hand-off key), one assigned event",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      // A flagged property is never dispatched, so the hot text is handed off directly (as dispatch does).
      await h.flag("hot_lead", "2026-10-14T12:00:00.000Z");
      const a = await h.newInbound();
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: a })).toEqual({ status: "assigned", assigneeUserId: h.owner });
      const { rows } = await pg.query("select payload from public.lead_events where property_id = $1 and source_type = $2", [h.propertyId, HOT_HANDOFF_SOURCE_TYPE]);
      expect((rows[0].payload as { covered_by_hold?: boolean }).covered_by_hold).toBe(false);
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.assignee()).toBe(h.owner);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`]);
    },
  },
  {
    id: "6",
    name: "hot text, the guarded update fails: hot_lead_assign_failed hold, exactly one Slack + one SMS, no assigned event",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      expect(await h.assignee()).toBeNull();
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.tape(a)).toContain("Couldn't hand this to Jarrad");
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead_assign_failed" });
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "7",
    name: "hot text, a rep wins the race: left for the rep, nothing sent, nothing assigned",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound();
      const unrace = await h.repWinsRace();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      } finally {
        await unrace();
      }
      expect(await h.assignee()).toBe(h.rep);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.tape(a)).toContain(RACE_LINE);
    },
  },
  {
    id: "8",
    name: "row 6, then a person gives Jarrad the lead and the same inbound is retried: no assigned event, still one Slack + one SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        await h.dispatch(a, "new_lead", HOT_ESC);
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      const { error } = await admin.from("properties").update({ assigned_user_id: h.owner }).eq("id", h.propertyId);
      expect(error).toBeNull();
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: a })).toEqual({ status: "already_owned", assigneeUserId: h.owner });
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead_assign_failed" });
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "9",
    name: "a lead Jarrad created himself (assigned at insert, only lead_created): hot text pings once as 'Hot text on your lead', no assigned event",
    expect: { slack: 1, sms: 1, assigned: 0 },
    setup: { assigned: "owner" },
    run: async (h) => {
      const types = (await pg.query("select event_type from public.lead_events where property_id = $1", [h.propertyId])).rows.map((r) => r.event_type);
      expect(types).not.toContain("assigned");
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      expect((await h.alertPass()).sent).toBe(2);
      expect(h.sent.every((x) => x.text.startsWith("Hot text on your lead: Hannah, 12 Matrix Ln."))).toBe(true);
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
      expect(await h.tape(a)).toContain(HOT_TEXT_LINE);
    },
  },
  {
    id: "10",
    name: "housekeeping reassigned the lead to Jarrad (direct column update, no events): hot text pings once, no assigned event",
    expect: { slack: 1, sms: 1, assigned: 0 },
    setup: { assigned: "rep" },
    run: async (h) => {
      const { error } = await admin.from("properties").update({ assigned_user_id: h.owner }).eq("id", h.propertyId);
      expect(error).toBeNull();
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      expect((await h.alertPass()).sent).toBe(2);
      expect(h.sent.every((x) => x.text.startsWith("Hot text on your lead"))).toBe(true);
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
    },
  },
  {
    id: "11",
    name: "hand-off, then unassigned, then a new hot text: handed off again (second assigned event, second Slack + SMS)",
    expect: { slack: 2, sms: 2, assigned: 2 },
    run: async (h) => {
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      expect((await h.alertPass()).sent).toBe(2);
      const { error } = await admin.from("properties").update({ assigned_user_id: null }).eq("id", h.propertyId);
      expect(error).toBeNull();
      const b = await h.newInbound("ok, call me back please");
      await h.dispatch(b, "new_lead", HOT_ESC);
      expect(await h.assignee()).toBe(h.owner);
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`, `hot_handoff:${b}`].sort());
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  ...(["model:call_request", "model:price_or_offer"] as const).map(
    (reason, i): Row => ({
      id: `12${i === 0 ? "a" : "b"}`,
      name: `a rep-owned lead with a ${reason} hot hold: nobody is pinged`,
      expect: { slack: 0, sms: 0, assigned: 0 },
      setup: { assigned: "rep" },
      run: async (h) => {
        await h.flag(reason, new Date().toISOString());
        const pass = await h.alertPass();
        expect(pass.sent).toBe(0);
        const { rows } = await pg.query("select status, last_error from public.hold_alert_deliveries where org_id = $1", [h.orgId]);
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.status === "skipped" && r.last_error === "owned_by_someone_else")).toBe(true);
        expect((await h.alertPass()).sent).toBe(0);
      },
    }),
  ),
  {
    id: "13",
    name: "hot text, Jarrad is unassigned before the alert pass: the hand-off alert is dropped (also when the unassign lands after the loader)",
    expect: { slack: 0, sms: 0, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      expect(await h.assignee()).toBe(h.owner);
      // Unassigned before the pass: the loader drops the hand-off.
      let { error } = await admin.from("properties").update({ assigned_user_id: null }).eq("id", h.propertyId);
      expect(error).toBeNull();
      expect((await h.alertPass()).sent).toBe(0);
      // Race version: the promotion is loaded while still assigned, then he is unassigned before the send.
      ({ error } = await admin.from("properties").update({ assigned_user_id: h.owner }).eq("id", h.propertyId));
      expect(error).toBeNull();
      const real = h.baseDeps.loadHotPromotions;
      const out = await h.alertPass({
        loadHotPromotions: async (org, since) => {
          const loaded = await real(org, since);
          expect(loaded.promotions.map((p) => p.key)).toEqual([`hot_handoff:${a}`]);
          const res = await admin.from("properties").update({ assigned_user_id: null }).eq("id", h.propertyId);
          expect(res.error).toBeNull();
          return loaded;
        },
      });
      expect(out.sent).toBe(0);
      const { rows } = await pg.query("select status, last_error from public.hold_alert_deliveries where org_id = $1", [h.orgId]);
      expect(rows.map((r) => [r.status, r.last_error])).toEqual([["skipped", "not_assigned"], ["skipped", "not_assigned"]]);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "14",
    name: "caps: with 20 DMs and 10 SMS already sent this hour a new hot event waits, goes out once next hour, never twice",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      for (let i = 0; i < 20; i++) {
        await pg.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
           values ($1, null, $2, $3, 'slack', 'first', 'sent', 1, now())`,
          [h.orgId, `seed-dm-${i}`, h.owner],
        );
      }
      for (let i = 0; i < 10; i++) {
        await pg.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
           values ($1, null, $2, $3, 'sms', 'first', 'sent', 1, now())`,
          [h.orgId, `seed-sms-${i}`, h.owner],
        );
      }
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      // This hour: held back, nothing sent, the rows wait as pending.
      expect((await h.alertPass()).sent).toBe(0);
      expect(h.sent).toEqual([]);
      const { rows } = await pg.query("select channel, status from public.hold_alert_deliveries where org_id = $1 and hold_key = $2 order by channel", [h.orgId, `hot_handoff:${a}`]);
      expect(rows.map((r) => [r.channel, r.status])).toEqual([["slack", "pending"], ["sms", "pending"]]);
      // Next hour: sent once.
      const later = { now: () => new Date(Date.now() + 61 * 60 * 1000) };
      expect((await h.alertPass(later)).sent).toBe(2);
      expect((await h.alertPass(later)).sent).toBe(0);
      expect((await h.alertPass(later)).sent).toBe(0);
    },
  },
  {
    id: "15",
    name: "'Who is this? I can sell within 30 days' with nurture auto-drip on: no identity text, no seller send, one hot hold alert, no hand-off",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const seq = (await pg.query("insert into public.sequences (org_id, name, active) values ($1, 'Nurture', true) returning id", [h.orgId])).rows[0].id;
      await pg.query(
        `update public.ai_responder_configs set nurture_auto_drip = true, nurture_drip_maybe_later_sequence_id = $2, nurture_drip_check_in_60_sequence_id = $2,
           nurture_drip_listed_not_selling_sequence_id = $2, nurture_drip_hot_book_appointment_sequence_id = $2 where org_id = $1`,
        [h.orgId, seq],
      );
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'nurture', 0.9, true)",
        [h.orgId],
      );
      const a = await h.newInbound("Who is this? I can sell within 30 days");
      // Jev says nurture with NO human follow-up (non-hot escalation); the 30-day timeframe is what makes it hot.
      expect(await h.dispatch(a, "nurture", NON_HOT_ESC, { timeframe: "within_30_days" })).toEqual({ outcome: "escalated", reason: "hot_lead" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead" });
      const pass = await h.alertPass();
      expect(pass.holds).toBe(1);
      expect(pass.sent).toBe(2);
      expect(h.sent.every((x) => x.userId === h.owner)).toBe(true);
      expect(await h.assignee()).toBeNull();
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "16",
    name: "existing NON-hot hold (pre-cutoff pending review), then a hot text whose hand-off fails: exactly one Slack + SMS (hot_flag key)",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.preCutoffReviewHold();
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead_assign_failed" });
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "17",
    name: "pre-cutoff hot hold with no flag time + a post-cutoff non-hot inbound: silent",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("hot_lead", null);
      const b = await h.newInbound("who is this?");
      // The flagged (pre-cutoff hot) lead is not dispatched again; the non-hot text is just skipped.
      expect(await h.dispatch(b, "nurture", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.runOf(b)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "18",
    name: "an open pre-cutoff NON-hot review hold does not hide a later hot call_request text: handed off, one Slack + SMS (hot_handoff key); a following non-hot text adds nothing",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      await h.preCutoffReviewHold();
      const a = await h.newInbound("sure, call me at 3pm tomorrow");
      expect(await h.dispatch(a, "new_lead", "call_request")).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "auto_closed", reason: "model:new_lead_promoted" });
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`]);
      // A non-hot text after the hand-off: Jev's non-hot answer lands as a held send (no provider), a non-hot run.
      const b = await h.newInbound("who is this?");
      expect(await h.dispatch(b, "nurture", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "send_blocked:blocked_provider_off" });
      expect(await h.runOf(b)).toEqual({ final_outcome: "escalated", reason: "send_blocked:blocked_provider_off" });
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "19",
    name: "a failed hand-off's alert is held back by the caps (both channels pending), then a later hot text is NOT covered by it and alerts once the cap allows",
    expect: { slack: 2, sms: 2, assigned: 1 },
    run: async (h) => {
      await h.useUpCaps();
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryRows(`${fk}`)).toEqual([["slack", "pending"], ["sms", "pending"]]);
      // A later hot text: the hold never pinged anyone, so it covers nothing.
      const b = await h.newInbound("call me, I want to sell");
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: b })).toEqual({ status: "assigned", assigneeUserId: h.owner });
      expect(await h.handoffPayload(b)).toMatchObject({ covered_by_hold: false });
      expect((await h.alertPass()).sent).toBe(0);
      // The cap allows next hour: the later event alerts (and the held-back failure goes out, once each).
      const later = { now: () => new Date(Date.now() + 61 * 60 * 1000) };
      expect((await h.alertPass(later)).sent).toBe(4);
      expect(await h.deliveryKeys()).toEqual([`${fk}`, `hot_handoff:${b}`, ...Array.from({ length: 20 }, (_, i) => `seed-dm-${i}`), ...Array.from({ length: 10 }, (_, i) => `seed-sms-${i}`)].sort());
      expect((await h.alertPass(later)).sent).toBe(0);
    },
  },
  {
    id: "20",
    name: "a failed hand-off's alert fails at the provider (both channels), then a later hot text is NOT covered by it and alerts",
    expect: { slack: 2, sms: 2, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
      }
      const fk = await h.flagKey();
      const providerDown: Partial<HoldAlertDeps> = {
        sendSlack: async () => ({ status: "failed", error: "provider down" }),
        sendSms: async () => ({ status: "failed", error: "provider down" }),
      };
      expect((await h.alertPass(providerDown)).sent).toBe(0);
      expect((await h.deliveryRows(`${fk}`)).every(([, status]) => status !== "sent")).toBe(true);
      const b = await h.newInbound("call me, I want to sell");
      expect(await assignHotLeadToOwner(admin, h.propertyId, { inboundMessageId: b })).toEqual({ status: "assigned", assigneeUserId: h.owner });
      expect(await h.handoffPayload(b)).toMatchObject({ covered_by_hold: false });
      expect((await h.alertPass()).sent).toBe(4);
      expect(await h.deliveryRows(`hot_handoff:${b}`)).toEqual([["slack", "sent"], ["sms", "sent"]]);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "21",
    name: "a hot inbound that arrived BEFORE the 2026-10-15 cutoff, processed (retried) after it: handed off, but nobody is pinged",
    expect: { slack: 0, sms: 0, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound("yes I might sell, what could you pay for it?", "2026-10-14T23:00:00.000Z");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      expect(await h.assignee()).toBe(h.owner);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "22",
    name: "hand-off fails AND the hot_seller_failed event cannot be written: the hold alone alerts, exactly one Slack + one SMS (hot_flag:<property>:<flagAt>), no assigned event",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound();
      const unblock = await h.blockAssignment();
      const unblockLedger = await h.blockLeadEvents(HOT_FAILED_SOURCE_TYPE);
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      } finally {
        await unblock();
        await unblockLedger();
      }
      const fk = await h.flagKey();
      const { rows } = await pg.query("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [h.propertyId, HOT_FAILED_SOURCE_TYPE]);
      expect(rows[0].n).toBe(0);
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "hot_lead_assign_failed" });
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`${fk}`]);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "23",
    name: "run-only-hot hold: Jev escalates call_request below the new_lead threshold and the flag write does nothing: the hold is hot by its run alone, exactly one Slack + SMS (hot_text:<inbound>), no hand-off",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("sure, call me at 3pm tomorrow");
      // 0.95 (the fake Jev's confidence) is below 0.99: the new_lead decision is not automated, it is escalated with Jev's reason.
      await pg.query("update public.jev_outcome_thresholds set min_confidence = 0.99 where org_id = $1 and outcome = 'new_lead'", [h.orgId]);
      const undo = await h.noopFlagWrites();
      try {
        expect(await h.dispatch(a, "new_lead", "call_request")).toEqual({ outcome: "escalated", reason: "model:call_request" });
      } finally {
        await undo();
      }
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "model:call_request" });
      // The flag never landed: the hold exists (and is hot) only because of its run.
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop?.needs_human_attention).toBe(false);
      expect(await h.assignee()).toBeNull();
      const pass = await h.alertPass();
      expect(pass.holds).toBe(1);
      expect(pass.sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
];

describe("hot seller acceptance matrix (real database, real dispatch + alert pass, recording senders)", () => {
  it.each(ROWS)("row $id: $name", async (row) => {
    const h = await makeHarness(row.setup);
    await row.run(h);
    expect({ slack: h.slack(), sms: h.sms(), assigned: await h.handoffEvents() }).toEqual(row.expect);
    // Nothing is ever texted to the seller, and nobody but the owner is ever pinged.
    expect(await count("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [h.propertyId])).toBe(0);
    expect(h.sent.every((x) => x.userId === h.owner)).toBe(true);
  }, 180_000);
});
