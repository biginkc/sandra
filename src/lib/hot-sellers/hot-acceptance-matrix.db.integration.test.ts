import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { attachHotAlertTimes } from "@/app/(dashboard)/messages-v2/hot-alert-times";
import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { deriveTape } from "@/app/(dashboard)/messages-v2/tape";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "@/app/(dashboard)/messages-v2/types";
import { applyKeywordEscalation, checkHotTextAfterKeywordHold, dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { createHoldAlertDeps } from "@/lib/hold-alerts";
import { MAX_DMS_PER_RECIPIENT_PER_HOUR, MAX_SMS_PER_HOUR, runHoldAlertsForOrg } from "@/lib/hold-alerts/core";
import type { HoldAlertDeps } from "@/lib/hold-alerts/types";
import { finishRunFromOutcome } from "@/lib/pipeline-runs/outcome";
import { startRun } from "@/lib/pipeline-runs/record";
import { resetMockState } from "@/lib/messaging/providers/mock";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { assignHotLeadToOwner, HOT_FAILED_SOURCE_TYPE, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "./assign";

/** Seed this hour's caps as fully used: one insert per channel via generate_series. */
async function seedCapRows(pg: Client, orgId: string, owner: string): Promise<void> {
  for (const [channel, n, label] of [["slack", MAX_DMS_PER_RECIPIENT_PER_HOUR, "dm"], ["sms", MAX_SMS_PER_HOUR, "sms"]] as const) {
    await pg.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
       select $1, null, 'seed-' || $2 || '-' || (g - 1), $3, $4, 'first', 'sent', 1, now() from generate_series(1, $5::int) g`,
      [orgId, label, owner, channel, n],
    );
  }
}

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
let jevOutcome: "new_lead" | "nurture" | "unclear" | "bad_number" | "wrong_number" | "opted_out" | "dnc" = "new_lead";
// Set explicitly for EVERY dispatch (no hot default): a "non-hot" follow-up must say so.
let jevEscalation = "not_applicable";
let jevTimeframe: string | null = null;
let jevCalls = 0;

function installFakeJev() {
  vi.stubEnv("TYPESAFE_API_KEY", "fake-test-key");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      jevCalls += 1;
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
  jevCalls = 0;
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
    jev: "new_lead" | "nurture" | "unclear" | "bad_number" | "wrong_number" | "opted_out" | "dnc",
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

  /** The hot_seller_text event payload for one inbound (held_lead, covered_by_hold, to ...). */
  const hotTextPayload = async (inboundMessageId: string): Promise<{ held_lead?: boolean; covered_by_hold?: boolean; to?: string } | null> => {
    const { rows } = await pg.query("select payload from public.lead_events where property_id = $1 and source_type = $2 and source_id = $3", [propertyId, HOT_TEXT_SOURCE_TYPE, inboundMessageId]);
    return rows[0]?.payload ?? null;
  };
  const hotTextEvents = () =>
    count("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [propertyId, HOT_TEXT_SOURCE_TYPE]);

  /** Mark a hold's alert as already sent on both channels (rows only; nothing goes through the recording senders). */
  const seedSentHoldAlert = async (holdKey: string) => {
    for (const channel of ["slack", "sms"] as const) {
      await pg.query(
        `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
         values ($1, $2, $3, $4, $5, 'first', 'sent', 1, now())`,
        [orgId, propertyId, holdKey, owner, channel],
      );
    }
  };

  /** Seed this hour's DM and SMS caps as already used (MAX_DMS_PER_RECIPIENT_PER_HOUR Slack DMs, MAX_SMS_PER_HOUR SMS). */
  const useUpCaps = async () => {
    await seedCapRows(pg, orgId, owner);
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

  /** Rows that change the hot owner set the new recipient here (the final "only the owner is pinged" check uses it). */
  const extra = { recipient: null as string | null };

  return {
    extra, orgId, owner, rep, propertyId, sent, baseDeps, newInbound, dispatch, alertPass, handoffEvents, assignee, tape, runOf, expectOneAlertTotal,
    blockAssignment, repWinsRace, flag, preCutoffReviewHold, blockLeadEvents, noopFlagWrites, flagKey, handoffPayload, useUpCaps, deliveryRows, hotTextPayload, hotTextEvents, seedSentHoldAlert,
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
    name: "hot text leaves an OPEN failed-hand-off hold: one alert (hot_flag:<property>:<flagAt>); a non-hot text and a later hot text through real dispatch (covered by that alerted hold) add nothing",
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
      expect(await h.hotTextEvents()).toBe(0);
      // Hold still open: a later HOT text goes through real dispatch. The flagged lead is classified once and a
      // held-lead hot_text is recorded, covered by the alerted hold: no new ping, no hand-off.
      const c = await h.newInbound("ok seriously, what is your best number?");
      expect(await h.dispatch(c, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.runOf(c)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(c)).toMatchObject({ held_lead: true, covered_by_hold: true, to: h.owner });
      expect(await h.assignee()).toBeNull();
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
    name: "pre-cutoff hot hold + a post-cutoff hot text through real dispatch: classified once, held-lead hot_text (not covered), one Slack + SMS (hot_text key), no hand-off",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("hot_lead", "2026-10-14T12:00:00.000Z");
      const a = await h.newInbound();
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: false, to: h.owner });
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.assignee()).toBeNull();
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
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
    name: "hot text, a rep wins the race: left for the rep, nothing assigned, Jarrad still alerted once",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound();
      const unrace = await h.repWinsRace();
      try {
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      } finally {
        await unrace();
      }
      expect(await h.assignee()).toBe(h.rep);
      expect((await h.alertPass()).sent).toBe(2);
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
      name: `a rep-owned lead with a ${reason} hot hold: Jarrad is pinged once, the rep keeps the lead`,
      expect: { slack: 1, sms: 1, assigned: 0 },
      setup: { assigned: "rep" },
      run: async (h) => {
        await h.flag(reason, new Date().toISOString());
        const pass = await h.alertPass();
        expect(pass.sent).toBe(2);
        const { rows } = await pg.query("select status, recipient_user_id from public.hold_alert_deliveries where org_id = $1", [h.orgId]);
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.status === "sent" && r.recipient_user_id === h.owner)).toBe(true);
        expect((await h.alertPass()).sent).toBe(0);
        expect(await h.assignee()).toBe(h.rep);
      },
    }),
  ),
  {
    id: "13",
    name: "hot text, Jarrad is unassigned before the alert pass: he is still alerted once (assignment never gates a hot alert)",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      const a = await h.newInbound();
      await h.dispatch(a, "new_lead", HOT_ESC);
      expect(await h.assignee()).toBe(h.owner);
      const { error } = await admin.from("properties").update({ assigned_user_id: null }).eq("id", h.propertyId);
      expect(error).toBeNull();
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`]);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "14",
    name: "caps: with the DM and SMS caps (MAX_DMS_PER_RECIPIENT_PER_HOUR / MAX_SMS_PER_HOUR) already used this hour a new hot event waits, goes out once next hour, never twice",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      await seedCapRows(pg, h.orgId, h.owner);
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
      expect(h.sent.every((x) => x.userId === (h.extra.recipient ?? h.owner))).toBe(true);
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
    name: "a failed hand-off's alert is held back by the caps (both channels pending), then a later hot text (real dispatch) is NOT covered by it and alerts once the cap allows",
    expect: { slack: 2, sms: 2, assigned: 0 },
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
      expect(await h.dispatch(b, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(b)).toMatchObject({ held_lead: true, covered_by_hold: false });
      expect((await h.alertPass()).sent).toBe(0);
      // The cap allows next hour: the later event alerts (and the held-back failure goes out, once each).
      const later = { now: () => new Date(Date.now() + 61 * 60 * 1000) };
      expect((await h.alertPass(later)).sent).toBe(4);
      expect(await h.deliveryKeys()).toEqual([`${fk}`, `hot_text:${b}`, ...Array.from({ length: MAX_DMS_PER_RECIPIENT_PER_HOUR }, (_, i) => `seed-dm-${i}`), ...Array.from({ length: MAX_SMS_PER_HOUR }, (_, i) => `seed-sms-${i}`)].sort());
      expect((await h.alertPass(later)).sent).toBe(0);
    },
  },
  {
    id: "20",
    name: "a failed hand-off's alert fails at the provider (both channels), then a later hot text (real dispatch) is NOT covered by it and alerts",
    expect: { slack: 2, sms: 2, assigned: 0 },
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
      expect(await h.dispatch(b, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(b)).toMatchObject({ held_lead: true, covered_by_hold: false });
      expect((await h.alertPass()).sent).toBe(4);
      expect(await h.deliveryRows(`hot_text:${b}`)).toEqual([["slack", "sent"], ["sms", "sent"]]);
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
  {
    id: "24",
    name: "flagged pre-cutoff NON-hot hold + a new hot text through real dispatch: classified once, one held-lead hot_text, exactly one Slack + SMS (hot_text key), no hand-off, no seller send",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("send_blocked:blocked_provider_off", "2026-10-14T12:00:00.000Z");
      const a = await h.newInbound("yes, what would you pay?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.runOf(a)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextEvents()).toBe(1);
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: false, to: h.owner });
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
      expect(await h.assignee()).toBeNull();
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "25",
    name: "flagged hot hold whose alert was already SENT + a new hot text through real dispatch: covered, nothing more (0 Slack, 0 SMS from this row's senders)",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("model:price_or_offer", new Date().toISOString());
      await h.seedSentHoldAlert(await h.flagKey());
      const a = await h.newInbound("ok so what is your best number?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: true });
      expect((await h.alertPass()).sent).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.assignee()).toBeNull();
    },
  },
  {
    id: "26",
    name: "flagged property + a non-hot text through real dispatch: classified once, no event, skipped already_terminal, nobody pinged, nothing sent to the seller",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("send_blocked:blocked_provider_off", "2026-10-14T12:00:00.000Z");
      const a = await h.newInbound("who is this?");
      expect(await h.dispatch(a, "nurture", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.runOf(a)).toEqual({ final_outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "27",
    name: "nurture + price_or_offer through real dispatch: hot wins - held for Jarrad (model:price_or_offer), one hot hold alert, no hand-off, no nurture disposition, no seller send",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'nurture', 0.9, true)",
        [h.orgId],
      );
      const a = await h.newInbound("Not right now, maybe check back in a few months");
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "escalated", reason: "model:price_or_offer" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "model:price_or_offer" });
      const { data: prop } = await admin.from("properties").select("outreach_dispo, needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ outreach_dispo: null, needs_human_attention: true, last_ai_escalation_reason: "model:price_or_offer" });
      const fk = await h.flagKey();
      const pass = await h.alertPass();
      expect(pass.holds).toBe(1);
      expect(pass.sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([fk]);
      expect(await h.assignee()).toBeNull();
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "28",
    name: "below-threshold nurture + price_or_offer through real dispatch: hot wins (needs_decision carries the escalation) - held model:price_or_offer, one hot hold alert, no hand-off, no seller send",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'nurture', 0.99, true)",
        [h.orgId],
      );
      const a = await h.newInbound("Not right now, maybe check back in a few months");
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "escalated", reason: "model:price_or_offer" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "model:price_or_offer" });
      expect(await hotWinsKind(a)).toBe("jev_needs_decision");
      await expectHotHeld(h, a);
    },
  },
  {
    id: "29",
    name: "identity question + below-threshold nurture + call_request through real dispatch: NO identity reply, held model:call_request, one hot hold alert, no hand-off",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'nurture', 0.99, true)",
        [h.orgId],
      );
      const a = await h.newInbound("Who is this? I might sell.");
      expect(await h.dispatch(a, "nurture", "call_request")).toEqual({ outcome: "escalated", reason: "model:call_request" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "model:call_request" });
      expect(await hotWinsKind(a)).toBe("jev_needs_decision");
      await expectHotHeld(h, a);
    },
  },
  {
    id: "30",
    name: "no-action outcome (unclear) + price_or_offer through real dispatch: hot wins (no_action carries the escalation) - held model:price_or_offer, one hot hold alert, no hand-off, no seller send",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("hmm what number are you thinking");
      expect(await h.dispatch(a, "unclear", HOT_ESC)).toEqual({ outcome: "escalated", reason: "model:price_or_offer" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "model:price_or_offer" });
      expect(await hotWinsKind(a)).toBe("jev_no_action");
      await expectHotHeld(h, a);
    },
  },
  {
    id: "34",
    name: "bad_number + price_or_offer through real dispatch: NOT hot (sits with wrong-number) - held jev_unclear_no_action, no hot_wins, no hot alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("wrong person but what would you pay");
      expect(await h.dispatch(a, "bad_number", HOT_ESC)).toEqual({ outcome: "escalated", reason: "jev_unclear_no_action" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "31",
    name: "opted_out + price_or_offer through real dispatch: stop beats hot - the human review row is created as today, NOT held as hot, no hot alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("please take me off your list, though I would like to know what you would pay");
      const result = await h.dispatch(a, "opted_out", HOT_ESC);
      expect(await hotWinsCount(a)).toBe(0);
      expect(await reviewRows(h)).toBeGreaterThanOrEqual(1);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "32",
    name: "dnc + call_request through real dispatch: DNC beats hot - the human review row is created as today, NOT held as hot, no hot alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("this number is on the do not call registry, please remove it and call my other number");
      const result = await h.dispatch(a, "dnc", "call_request");
      expect(await hotWinsCount(a)).toBe(0);
      expect(await reviewRows(h)).toBeGreaterThanOrEqual(1);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "33",
    name: "hot-wins dispatch, then the SAME inbound dispatched again: classifier called once in total, no extra event, still exactly one Slack + SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'nurture', 0.9, true)",
        [h.orgId],
      );
      const a = await h.newInbound("Not right now, maybe check back in a few months");
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "escalated", reason: "model:price_or_offer" });
      expect(jevCalls).toBe(1);
      const again = await h.dispatch(a, "nurture", HOT_ESC);
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "35",
    name: "held lead whose contact opted out (sms_opted_out flag, then a consent opt_out) + hot text through real dispatch: classify-only is silent - classifier never called, no hot_seller_text event, no alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      await pg.query("update public.contacts set sms_opted_out = true where id = (select homeowner_contact_id from public.properties where id = $1)", [h.propertyId]);
      const a = await h.newInbound("yes I would sell, what could you pay");
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(0);
      await pg.query("update public.contacts set sms_opted_out = false where id = (select homeowner_contact_id from public.properties where id = $1)", [h.propertyId]);
      await pg.query(
        "insert into public.consent_events (contact_id, channel, event_type, source) select homeowner_contact_id, 'sms', 'opt_out', 'hot-matrix-test' from public.properties where id = $1",
        [h.propertyId],
      );
      const b = await h.newInbound("actually yes make me an offer");
      expect(await h.dispatch(b, "nurture", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(0);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "36",
    name: "held lead under human takeover (ai_responder_disabled) + hot text through real dispatch: classify-only is silent - classifier never called, no hot_seller_text event, no alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      await pg.query("update public.properties set ai_responder_disabled = true where id = $1", [h.propertyId]);
      const a = await h.newInbound("what number are you thinking, I will sell");
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(0);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "37",
    name: "replay of a held-lead inbound that already has an ai_response_claims row but no classification run: not classified again - classifier never called, no hot_seller_text event, no alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("sure I will sell, what can you pay");
      await pg.query(
        "insert into public.ai_response_claims (org_id, inbound_message_id, property_id, status) values ($1, $2, $3, 'completed')",
        [h.orgId, a, h.propertyId],
      );
      expect(await count("select count(*)::int as n from public.sms_classification_runs where source_inbound_message_id = $1", [a])).toBe(0);
      expect(await h.dispatch(a, "nurture", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(0);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "38",
    name: "identity question + below-threshold new_lead + escalation not_applicable through real dispatch: NO identity reply, held hot (escalate route), exactly one Slack + SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await pg.query("update public.jev_outcome_thresholds set min_confidence = 0.99 where org_id = $1 and outcome = 'new_lead'", [h.orgId]);
      const a = await h.newInbound("Who is this? I might sell.");
      const result = await h.dispatch(a, "new_lead", "not_applicable");
      expect(result.outcome).toBe("escalated");
      expect(jevCalls).toBeGreaterThanOrEqual(1);
      const { data: prop } = await admin.from("properties").select("outreach_dispo, needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ outreach_dispo: null, needs_human_attention: true });
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  ...(["opted_out", "dnc"] as const).map((outcome, i): Row => ({
    id: `39${"ab"[i]}`,
    name: `held lead + new text classified ${outcome} with a hot escalation through real dispatch: stop/DNC wins - no hot_seller_text event, no alert`,
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("stop texting me, but what would you pay");
      await h.dispatch(a, outcome, HOT_ESC);
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  })),
  {
    id: "40",
    name: "hot hold alerted owner A (sent), then A loses the owner role and B becomes the single owner, then a new hot text through real dispatch: B has no rows yet and the hold will alert B itself, so the text is covered - exactly one Slack + SMS, to B",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("model:price_or_offer", new Date().toISOString());
      await h.seedSentHoldAlert(await h.flagKey()); // sent to A (the original owner)
      const b = await createMember(h.orgId, "owner");
      await pg.query("update public.memberships set role = 'member' where org_id = $1 and user_id = $2", [h.orgId, h.owner]);
      h.extra.recipient = b;
      const a = await h.newInbound("ok so what is your best number?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: true, to: b });
      expect((await h.alertPass()).sent).toBe(2);
      expect(h.sent.every((x) => x.userId === b)).toBe(true);
      expect(h.slack()).toBe(1);
      expect(h.sms()).toBe(1);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.assignee()).toBeNull();
    },
  },
  {
    id: "41",
    name: "held lead with outreach_dispo='nurture' + a hot text through real dispatch: classified, one held-lead hot_text, exactly one Slack + SMS, nothing sent to the seller",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("send_blocked:blocked_provider_off", "2026-10-14T12:00:00.000Z");
      await pg.query("update public.properties set outreach_dispo = 'nurture' where id = $1", [h.propertyId]);
      const a = await h.newInbound("yes, what would you pay?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(1);
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, to: h.owner });
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.assignee()).toBeNull();
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "42",
    name: "held lead with outreach_dispo='callback_requested' owned by a rep + a hot text through real dispatch: classified, one hot_text alert to Jarrad, the rep keeps the lead",
    setup: { assigned: "rep" },
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("send_blocked:blocked_provider_off", "2026-10-14T12:00:00.000Z");
      await pg.query("update public.properties set outreach_dispo = 'callback_requested' where id = $1", [h.propertyId]);
      const a = await h.newInbound("yes, what would you pay?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      expect(await h.deliveryKeys()).toEqual([`hot_text:${a}`]);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.assignee()).toBe(h.rep);
    },
  },
  ...(["nurture", "callback_requested", "booked_appointment"] as const).map(
    (dispo): Row => ({
      id: `42-${dispo}`,
      name: `NOT flagged, outreach_dispo='${dispo}', owned by a rep + a hot text: classify-only look, one hot_text alert to Jarrad, nothing sent to the seller, dispo and assignee unchanged`,
      setup: { assigned: "rep" },
      expect: { slack: 1, sms: 1, assigned: 0 },
      run: async (h) => {
        await pg.query("update public.properties set outreach_dispo = $2, needs_human_attention = false where id = $1", [h.propertyId, dispo]);
        const a = await h.newInbound("yes, what would you pay?");
        expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
        expect(jevCalls).toBe(1);
        expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, to: h.owner });
        expect((await h.alertPass()).sent).toBe(2);
        expect((await h.alertPass()).sent).toBe(0);
        expect(await h.assignee()).toBe(h.rep);
        const { rows } = await pg.query("select outreach_dispo from public.properties where id = $1", [h.propertyId]);
        expect(rows[0].outreach_dispo).toBe(dispo);
        const out = await pg.query("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [h.propertyId]);
        expect(out.rows[0].n).toBe(0);
      },
    }),
  ),
  ...(["wrong_number", "bad_number", "dnc", "opted_out"] as const).map(
    (dispo): Row => ({
      id: `42-${dispo}`,
      name: `NOT flagged, outreach_dispo='${dispo}' + a hot text: true suppression wins, never classified, no alert`,
      expect: { slack: 0, sms: 0, assigned: 0 },
      run: async (h) => {
        await pg.query("update public.properties set outreach_dispo = $2, needs_human_attention = false where id = $1", [h.propertyId, dispo]);
        const a = await h.newInbound("yes, what would you pay?");
        await h.dispatch(a, "new_lead", HOT_ESC);
        expect(jevCalls).toBe(0);
        expect(await h.hotTextEvents()).toBe(0);
        expect((await h.alertPass()).sent).toBe(0);
      },
    }),
  ),
  {
    id: "43",
    name: "hot hold already alerted (sent), then a NON-hot number-source answer arrives through real dispatch: the hold is refreshed but its flag time and reason are unchanged, so no second alert",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const FLAG_AT = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await h.flag("model:price_or_offer", FLAG_AT);
      await h.seedSentHoldAlert(await h.flagKey());
      const keyBefore = await h.flagKey();
      // Our earlier "how did you get my number?" reply is the latest outbound message.
      const question = await h.newInbound("how did you get my number?");
      const { data: q } = await admin.from("messages").select("org_id, property_id, contact_id, conversation_id, from_address, to_address").eq("id", question).single();
      const { data: out, error: outError } = await admin
        .from("messages")
        .insert({
          org_id: q!.org_id, channel: "sms", direction: "outbound", status: "sent", property_id: q!.property_id, contact_id: q!.contact_id,
          conversation_id: q!.conversation_id, from_address: q!.to_address, to_address: q!.from_address, body: "Want me to take you off the list?",
          metadata: { reply_key: "number_source", inbound_message_id: question },
        } as never)
        .select("id")
        .single();
      if (outError || !out) throw new Error(`outbound seed failed: ${outError?.message}`);
      const a = await h.newInbound("yes take me off");
      expect(await h.dispatch(a, "nurture", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "number_source_answer_received" });
      const { data: prop } = await admin.from("properties").select("last_ai_escalation_reason, last_ai_escalation_at, needs_human_attention").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "model:price_or_offer" });
      expect(new Date(prop!.last_ai_escalation_at as string).toISOString()).toBe(FLAG_AT);
      expect(await h.flagKey()).toBe(keyBefore);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([keyBefore]);
      // The seeded question reply is test scaffolding, not something Sandra sent: remove it before the "nothing texted" check.
      await pg.query("delete from public.messages where id = $1", [out.id]);
    },
  },
  {
    id: "44",
    name: "post-cutoff hand-off whose inbound is days old and was never alerted: the next pass alerts it once (the look-back is 7 days, not 48 hours)",
    expect: { slack: 1, sms: 1, assigned: 1 },
    run: async (h) => {
      // As old as the cutoff allows, up to 3 days: the cutoff (2026-10-15) bounds how far back a real inbound can be.
      const cutoffMs = Date.parse("2026-10-15T00:00:00.000Z");
      const inboundAt = new Date(Math.max(cutoffMs + 60_000, Date.now() - 3 * 24 * 60 * 60 * 1000)).toISOString();
      await pg.query("update public.hold_alert_settings set alerts_since = $2 where org_id = $1", [h.orgId, new Date(cutoffMs).toISOString()]);
      const a = await h.newInbound("yes I would sell, what can you pay", inboundAt);
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      expect(h.sent).toHaveLength(0); // never alerted yet
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([`hot_handoff:${a}`]);
      expect(await h.assignee()).toBe(h.owner);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "45",
    name: "hot hold: sent to owner A, owner changes to B and B's delivery row FAILED, then a new hot text through real dispatch: not covered - exactly one Slack + SMS to B, from the hot text",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("model:price_or_offer", new Date().toISOString());
      const key = await h.flagKey();
      await h.seedSentHoldAlert(key); // sent to A
      const b = await createMember(h.orgId, "owner");
      await pg.query("update public.memberships set role = 'member' where org_id = $1 and user_id = $2", [h.orgId, h.owner]);
      h.extra.recipient = b;
      for (const channel of ["slack", "sms"] as const) {
        await pg.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts)
           values ($1, $2, $3, $4, $5, 'first', 'failed', 3)`,
          [h.orgId, h.propertyId, key, b, channel],
        );
      }
      const a = await h.newInbound("ok so what is your best number?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: false, to: b });
      expect((await h.alertPass()).sent).toBe(2);
      expect(h.sent.every((x) => x.userId === b)).toBe(true);
      expect(h.slack()).toBe(1);
      expect(h.sms()).toBe(1);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "46",
    name: "hot hold flagged BEFORE the org's alerts_since + a new hot text through real dispatch: not covered. The fresh seller text restarts the hold (alert_since = the text), so the hold alerts once AND the hot text alerts once - two Slack + two SMS, all to the owner (a double ping, never silence)",
    expect: { slack: 2, sms: 2, assigned: 0 },
    run: async (h) => {
      // Harness alerts_since is 1 hour ago; the flag is 3 hours ago (still after the cutoff and inside 7 days).
      // Same guard as row 44: nothing earlier than the fixed cutoff (2026-10-15), whatever time of day this runs.
      const cutoffMs = Date.parse("2026-10-15T00:00:00.000Z");
      const sinceMs = Math.max(cutoffMs + 120_000, Date.now() - 60 * 60 * 1000);
      await pg.query("update public.hold_alert_settings set alerts_since = $2 where org_id = $1", [h.orgId, new Date(sinceMs).toISOString()]);
      await h.flag("model:price_or_offer", new Date(Math.max(cutoffMs + 60_000, sinceMs - 2 * 60 * 60 * 1000)).toISOString());
      const a = await h.newInbound("ok so what is your best number?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, covered_by_hold: false, to: h.owner });
      expect((await h.alertPass()).sent).toBe(4);
      expect(h.sent.every((x) => x.userId === h.owner)).toBe(true);
      expect(await h.deliveryKeys()).toEqual([await h.flagKey(), `hot_text:${a}`].sort());
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "47",
    name: "held lead + \"What's your price?\" and Jev says unclear with NO escalation, through real dispatch: the price keyword alone is hot - one hot_text event, one Slack + one SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("What's your price?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "48",
    name: "held lead + \"STOP, what's your price\" and Jev says opted_out, through real dispatch: stop wins over the price keyword - no hot_text event, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("STOP, what's your price");
      await h.dispatch(a, "opted_out", NON_HOT_ESC);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "49",
    name: "two CONCURRENT dispatches of the same held hot inbound (Promise.all): exactly one Jev call, one hot_text event, one Slack + one SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("What's your price?");
      await Promise.all([h.dispatch(a, "unclear", NON_HOT_ESC), h.dispatch(a, "unclear", NON_HOT_ESC)]);
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "50",
    name: "UNFLAGGED lead + \"STOP, what's your price\" and Jev says opted_out, through real dispatch (normal path): the price keyword is deferred and stop wins - no hot flag, no hot_wins hold, the opt-out review row is created as today, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("STOP, what's your price");
      const result = await h.dispatch(a, "opted_out", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect(await reviewRows(h)).toBeGreaterThanOrEqual(1);
      const { data: prop } = await admin.from("properties").select("last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop?.last_ai_escalation_reason).not.toBe("keyword:price_offer");
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "51",
    name: "UNFLAGGED lead + a price keyword and Jev says dnc, through real dispatch (normal path): DNC wins - not hot, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("put me on the do not call list, what's your price anyway");
      const result = await h.dispatch(a, "dnc", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "52",
    name: "UNFLAGGED lead + a price keyword and Jev says wrong_number, through real dispatch (normal path): wrong number wins - not hot, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("wrong number, what's your price though");
      const result = await h.dispatch(a, "wrong_number", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "53",
    name: "UNFLAGGED lead + \"What's your price?\" and Jev says unclear with NO escalation, through real dispatch (normal path): the price keyword alone is hot - held keyword:price_offer, one hot hold alert (1 Slack + 1 SMS), no reply, no hand-off",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("What's your price?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "keyword:price_offer" });
      expect(jevCalls).toBe(1);
      expect(await hotWinsCount(a)).toBe(1);
      await expectHotHeld(h, a);
    },
  },
  {
    id: "54",
    name: "round 15: held lead, org allow-list WITHOUT price, \"What's your price?\" and Jev says unclear, through real dispatch: the org's phrases decide - not keyword-hot, no hot_text event, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["how much"]);
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("What's your price?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
    },
  },
  {
    id: "55",
    name: "round 15: held lead, org allow-list with \"how much\", \"how much?\" and Jev says unclear: keyword-hot - one hot_text event, one Slack + one SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["how much"]);
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("how much?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "56",
    name: "round 15: UNFLAGGED lead, org allow-list WITHOUT price, \"What's your price?\" and Jev says unclear (normal path): not keyword-hot - no keyword hold, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["how much"]);
      const a = await h.newInbound("What's your price?");
      const result = await h.dispatch(a, "unclear", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "57",
    name: "round 15: UNFLAGGED lead, org allow-list with \"how much\", \"how much?\" and Jev says unclear (normal path): keyword-hot - held keyword:price_offer, 1 Slack + 1 SMS",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["how much"]);
      const a = await h.newInbound("how much?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      await expectHotHeld(h, a);
    },
  },
  {
    id: "58",
    name: "round 15: identity question + price keyword, Jev says wrong_number (normal path): no identity reply to the seller, not hot, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("Who is this? What's your price?");
      const result = await h.dispatch(a, "wrong_number", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "59",
    name: "round 15: identity question + price keyword, Jev says dnc (normal path): no identity reply to the seller, not hot, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("Who is this? What's your price?");
      const result = await h.dispatch(a, "dnc", NON_HOT_ESC);
      expect(result).not.toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "60",
    name: "round 15: identity question + price keyword, Jev says unclear (normal path): held keyword:price_offer, no identity reply, one hot hold alert (1 Slack + 1 SMS)",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("Who is this? What's your price?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
      expect(await hotWinsCount(a)).toBe(1);
      await expectHotHeld(h, a);
    },
  },
  {
    id: "61",
    name: "round 15/20: \"He died, what's your price\" and Jev says wrong_number (normal path): held under the NON-price reason keyword:distressed_seller, classify-only runs once, wrong number wins - 0 Slack, 0 SMS, no hot_text event",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      const a = await h.newInbound("He died, what's your price");
      expect(await h.dispatch(a, "wrong_number", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:distressed_seller" });
      expect(jevCalls).toBe(1);
      expect(await hotWinsCount(a)).toBe(0);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "62",
    name: "round 15 (pins current behaviour): property with ai_responder_disabled + a hot price text (normal path): skipped, no Sandra hold, no flag, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await pg.query("update public.properties set ai_responder_disabled = true where id = $1", [h.propertyId]);
      const a = await h.newInbound("What's your price?");
      const result = await h.dispatch(a, "unclear", NON_HOT_ESC);
      expect(result).toMatchObject({ outcome: "skipped" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop?.needs_human_attention).toBe(false);
      expect(prop?.last_ai_escalation_reason).toBeNull();
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "63",
    name: "round 16: held lead + hot text, the hot_seller_text ledger write fails ONCE (real dispatch): no alert and the claim is released as error; a replay classifies again (2 Jev calls), writes the event, alerts exactly once (1 Slack + 1 SMS); a further replay does nothing",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("What's your price?");
      const unblock = await h.blockLeadEvents(HOT_TEXT_SOURCE_TYPE);
      try {
        expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      } finally {
        await unblock();
      }
      expect(jevCalls).toBe(1);
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      const claims = await pg.query("select status, outcome, error_message, lease_expires_at <= now() as released from public.ai_response_claims where inbound_message_id = $1", [a]);
      expect(claims.rows).toHaveLength(1);
      expect(claims.rows[0]).toMatchObject({ status: "error", error_message: "hot_text_event_not_recorded", released: true });
      // Replay: classified again, the event is written, the alert goes out once.
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(jevCalls).toBe(2);
      expect(await h.hotTextEvents()).toBe(1);
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, to: h.owner });
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      const done = await pg.query("select status from public.ai_response_claims where inbound_message_id = $1", [a]);
      expect(done.rows.map((r) => r.status)).toEqual(["completed"]);
      // A further replay: nothing more (completed claim).
      await h.dispatch(a, "unclear", NON_HOT_ESC);
      expect(jevCalls).toBe(2);
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "64",
    name: "round 17: UNFLAGGED lead, org allow-list WITHOUT price phrases, \"$150k\" and Jev non-hot (normal path): held keyword:numeric_amount (a person sees it), NOT hot - 0 Slack, 0 SMS, no hot_wins",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["lawyer", "callback"]);
      const a = await h.newInbound("I'd take $150k");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:numeric_amount" });
      expect(await h.runOf(a)).toEqual({ final_outcome: "escalated", reason: "keyword:numeric_amount" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason, assigned_user_id").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:numeric_amount", assigned_user_id: null });
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "65",
    name: "round 17: HELD lead, org allow-list WITHOUT price phrases, \"$150k\" and Jev non-hot, through real dispatch: not price-hot - no hot_text event, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["lawyer", "callback"]);
      await h.flag("draft_held", new Date().toISOString());
      const a = await h.newInbound("I'd take $150k");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "66",
    name: "round 17: TWO CONCURRENT failed hand-offs (two hot inbounds, one unassigned property, assignment blocked) with the caps full: only the call that set the flag shares the hold's hot_flag key; the other failure event has no flag_at (own event, deemed covered because the hold is guaranteed to alert); after the cap clears the hold alert goes out exactly once (1 Slack + 1 SMS) and nothing is re-sent",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.useUpCaps();
      const a = await h.newInbound("yes I might sell, what could you pay for it?");
      const b = await h.newInbound("call me, I want to sell");
      const unblock = await h.blockAssignment();
      let results;
      try {
        results = await Promise.all([h.dispatch(a, "new_lead", HOT_ESC), h.dispatch(b, "new_lead", HOT_ESC)]);
      } finally {
        await unblock();
      }
      expect(results.every((r) => r.outcome === "escalated")).toBe(true);
      const fk = await h.flagKey();
      const { rows: failures } = await pg.query(
        "select source_id, payload from public.lead_events where property_id = $1 and source_type = 'hot_seller_failed'",
        [h.propertyId],
      );
      // Both failures are recorded; exactly one (the call that set the flag) carries the flag time.
      expect(failures.map((f) => f.source_id).sort()).toEqual([a, b].sort());
      const withFlag = failures.filter((f) => f.payload.flag_at !== null);
      expect(withFlag).toHaveLength(1);
      expect(`hot_flag:${h.propertyId}:${withFlag[0].payload.flag_at}`).toBe(fk);
      // Caps full: nothing goes out yet.
      expect((await h.alertPass()).sent).toBe(0);
      const later = { now: () => new Date(Date.now() + 61 * 60 * 1000) };
      expect((await h.alertPass(later)).sent).toBe(2);
      expect(await h.deliveryRows(fk)).toEqual([["slack", "sent"], ["sms", "sent"]]);
      expect((await h.alertPass(later)).sent).toBe(0);
    },
  },
  {
    id: "67",
    name: "round 18: property with ai_responder_disabled + \"How much? My lawyer is involved\" (real dispatch): the responder-off gate runs before the keyword hold - skipped, no hold, no flag, no hot_wins, 0 Slack, 0 SMS, nothing sent",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      await pg.query("update public.properties set ai_responder_disabled = true where id = $1", [h.propertyId]);
      const a = await h.newInbound("How much? My lawyer is involved");
      const result = await h.dispatch(a, "unclear", NON_HOT_ESC);
      expect(result).toMatchObject({ outcome: "skipped" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop?.needs_human_attention).toBe(false);
      expect(prop?.last_ai_escalation_reason).toBeNull();
      expect(await hotWinsCount(a)).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "68",
    name: "round 18/20: ENABLED property + \"How much? My lawyer is involved\" with Jev unclear (real dispatch): held under the NON-price reason keyword:legal_contract, then the held-lead hot check alerts once (exactly one Slack + one SMS), no hot_wins step, nothing sent to the seller",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      const a = await h.newInbound("How much? My lawyer is involved");
      const result = await h.dispatch(a, "unclear", NON_HOT_ESC);
      expect(result).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect(await hotWinsCount(a)).toBe(0);
      expect(await h.hotTextEvents()).toBe(1);
      const pass = await h.alertPass();
      expect(pass).toMatchObject({ sent: 2 });
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "69",
    name: "round 19: opted-out contact + \"my lawyer is involved\" (real dispatch): the keyword hold is written as on main (keyword:legal_contract), non-hot so 0 Slack, 0 SMS, nothing sent",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      await pg.query("update public.contacts set sms_opted_out = true where id = (select homeowner_contact_id from public.properties where id = $1)", [h.propertyId]);
      const a = await h.newInbound("my lawyer is involved");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "70",
    name: "round 19: responder-off property + \"my lawyer is involved\" (real dispatch): no hold, no flag, 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      await pg.query("update public.properties set ai_responder_disabled = true where id = $1", [h.propertyId]);
      const a = await h.newInbound("my lawyer is involved");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toMatchObject({ outcome: "skipped" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop?.needs_human_attention).toBe(false);
      expect(prop?.last_ai_escalation_reason).toBeNull();
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "71",
    name: "round 19: \"My lawyer is involved. What's your price?\" + Jev unclear (real dispatch): the up-front hold is keyword:legal_contract (unchanged reason) AND the price signal is hot - exactly one Slack + one SMS, one hot_text event",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      const a = await h.newInbound("My lawyer is involved. What's your price?");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
  {
    id: "72",
    name: "round 19: same mixed text + Jev wrong_number (real dispatch): legal_contract hold stays, wrong number wins over hot - 0 Slack, 0 SMS, no hot_text event",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      const a = await h.newInbound("My lawyer is involved. What's your price?");
      expect(await h.dispatch(a, "wrong_number", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "73",
    name: "round 20: an UNASSIGNED hot_failed hand-off event, owner A's rows end skipped (A is replaced at send time), then B becomes the single owner: B gets exactly one Slack + one SMS, a further pass nothing",
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
      expect(await hotFailedEvents(h)).toBe(1);
      await ownerSkippedThenReplaced(h, fk);
    },
  },
  {
    id: "73b",
    name: "round 20: a held-lead hot_text event, owner A's rows end skipped, then B becomes the single owner: B gets exactly one Slack + one SMS, a further pass nothing",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      await h.flag("send_blocked:blocked_provider_off", "2026-10-14T12:00:00.000Z");
      await pg.query("update public.properties set outreach_dispo = 'nurture' where id = $1", [h.propertyId]);
      const a = await h.newInbound("yes, what would you pay?");
      expect(await h.dispatch(a, "new_lead", HOT_ESC)).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(await h.hotTextPayload(a)).toMatchObject({ held_lead: true, to: h.owner });
      await ownerSkippedThenReplaced(h, `hot_text:${a}`);
    },
  },
  {
    id: "74",
    name: "round 20: \"Stop asking how much. My lawyer is involved.\" (allow-list incl. price, how much, lawyer; Jev opted_out), real dispatch: held keyword:legal_contract, stop wins over hot - 0 Slack, 0 SMS, no hot_text event, nothing sent",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      const a = await h.newInbound("Stop asking how much. My lawyer is involved.");
      expect(await h.dispatch(a, "opted_out", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "75",
    name: "round 20: opted-out contact + \"How much? My lawyer is involved\" (real dispatch): held keyword:legal_contract, the opt-out gate keeps the hot check silent - 0 Slack, 0 SMS",
    expect: { slack: 0, sms: 0, assigned: 0 },
    run: async (h) => {
      await setKeywords(h, ["price", "how much", "lawyer"]);
      await pg.query("update public.contacts set sms_opted_out = true where id = (select homeowner_contact_id from public.properties where id = $1)", [h.propertyId]);
      const a = await h.newInbound("How much? My lawyer is involved");
      expect(await h.dispatch(a, "unclear", NON_HOT_ESC)).toEqual({ outcome: "escalated", reason: "keyword:legal_contract" });
      const { data: prop } = await admin.from("properties").select("needs_human_attention, last_ai_escalation_reason").eq("id", h.propertyId).single();
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect(await h.hotTextEvents()).toBe(0);
      expect((await h.alertPass()).sent).toBe(0);
      expect(await h.deliveryKeys()).toEqual([]);
    },
  },
  {
    id: "76",
    name: "round 20 (delayed-reply path: the same two calls inbound.ts makes with Jev automatic): \"How much? My lawyer is involved\" + Jev unclear -> held keyword:legal_contract, then one hot_text alert - exactly 1 Slack + 1 SMS; a replay of the check adds nothing",
    expect: { slack: 1, sms: 1, assigned: 0 },
    run: async (h) => {
      const kws = ["price", "how much", "lawyer"];
      await setKeywords(h, kws);
      const body = "How much? My lawyer is involved";
      const a = await h.newInbound(body);
      jevOutcome = "unclear";
      jevEscalation = NON_HOT_ESC;
      const input = { propertyId: h.propertyId, contactId: (await admin.from("properties").select("homeowner_contact_id").eq("id", h.propertyId).single()).data!.homeowner_contact_id!, conversationId: (await admin.from("messages").select("conversation_id").eq("id", a).single()).data!.conversation_id!, inboundMessageId: a, inboundBody: body };
      const kw = await applyKeywordEscalation(admin, { propertyId: h.propertyId, inboundBody: body, escalationKeywords: kws, jevAutomatic: true });
      expect(kw).toEqual({ escalated: true, reason: "keyword:legal_contract" });
      await checkHotTextAfterKeywordHold(admin, input as never, kw.escalated ? kw.reason : "", kws, null);
      await checkHotTextAfterKeywordHold(admin, input as never, "keyword:legal_contract", kws, null);
      expect(await h.hotTextEvents()).toBe(1);
      expect((await h.alertPass()).sent).toBe(2);
      expect((await h.alertPass()).sent).toBe(0);
      await h.expectOneAlertTotal();
    },
  },
];

async function hotFailedEvents(h: Harness): Promise<number> {
  const { rows } = await pg.query("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [h.propertyId, HOT_FAILED_SOURCE_TYPE]);
  return rows[0].n;
}

/**
 * Shared tail of rows 73/73b. Pass 1: A is the owner when the pass selects the alert, but the send-time re-check
 * sees a different owner, so both of A's rows end "skipped" and nothing is sent. Then A loses the owner role and B
 * becomes the single active owner: the finished-check must look at B's rows only, so B is alerted exactly once.
 */
async function ownerSkippedThenReplaced(h: Harness, key: string): Promise<void> {
  const real = h.baseDeps.loadHotOwner;
  let calls = 0;
  const first = await h.alertPass({
    loadHotOwner: async (org) => {
      calls += 1;
      return calls === 1 ? real(org) : "00000000-0000-0000-0000-00000000dead";
    },
  });
  expect(first.sent).toBe(0);
  expect(h.sent).toEqual([]);
  expect(await h.deliveryRows(key)).toEqual([["slack", "skipped"], ["sms", "skipped"]]);
  const { rows: before } = await pg.query("select recipient_user_id from public.hold_alert_deliveries where org_id = $1 and hold_key = $2", [h.orgId, key]);
  expect(before.every((r) => r.recipient_user_id === h.owner)).toBe(true);

  const b = await createMember(h.orgId, "owner");
  await pg.query("update public.memberships set role = 'member' where org_id = $1 and user_id = $2", [h.orgId, h.owner]);
  h.extra.recipient = b;
  expect((await h.alertPass()).sent).toBe(2);
  expect(h.slack()).toBe(1);
  expect(h.sms()).toBe(1);
  expect(h.sent.every((x) => x.userId === b)).toBe(true);
  const { rows: forB } = await pg.query(
    "select channel, status from public.hold_alert_deliveries where org_id = $1 and hold_key = $2 and recipient_user_id = $3 order by channel",
    [h.orgId, key, b],
  );
  expect(forB.map((r) => [r.channel, r.status])).toEqual([["slack", "sent"], ["sms", "sent"]]);
  expect((await h.alertPass()).sent).toBe(0);
  expect(h.sent).toHaveLength(2);
}

/** Set the org's escalation allow-list (ai_responder_configs.escalation_keywords) for this harness org. */
async function setKeywords(h: Harness, phrases: string[]): Promise<void> {
  await pg.query("update public.ai_responder_configs set escalation_keywords = $2::text[] where org_id = $1", [h.orgId, phrases]);
}

/** The classification kind the hot-wins step recorded for this inbound's run. */
async function hotWinsKind(inboundMessageId: string): Promise<string | null> {
  const { rows } = await pg.query(
    "select s.detail->>'kind' as kind from public.pipeline_run_steps s join public.pipeline_runs r on r.id = s.run_id where r.inbound_message_id = $1 and s.name = 'hot_wins'",
    [inboundMessageId],
  );
  expect(rows.length).toBe(1);
  return rows[0].kind;
}

async function hotWinsCount(inboundMessageId: string): Promise<number> {
  const { rows } = await pg.query(
    "select count(*)::int as n from public.pipeline_run_steps s join public.pipeline_runs r on r.id = s.run_id where r.inbound_message_id = $1 and s.name = 'hot_wins'",
    [inboundMessageId],
  );
  return rows[0].n;
}

/** Human review rows (AI disposition reviews + lead decisions) for the harness property. */
async function reviewRows(h: Harness): Promise<number> {
  let n = 0;
  for (const t of ["ai_disposition_reviews", "jev_lead_decisions"]) {
    const { rows } = await pg.query(`select count(*)::int as n from public.${t} where property_id = $1`, [h.propertyId]).catch(() => ({ rows: [{ n: 0 }] }));
    n += rows[0].n;
  }
  return n;
}

/** Held hot (flag set, no disposition), exactly one Slack + SMS, no hand-off. */
async function expectHotHeld(h: Harness, inboundMessageId: string): Promise<void> {
  const { data: prop } = await admin.from("properties").select("outreach_dispo, needs_human_attention").eq("id", h.propertyId).single();
  expect(prop).toMatchObject({ outreach_dispo: null, needs_human_attention: true });
  const fk = await h.flagKey();
  const pass = await h.alertPass();
  expect(pass.holds).toBe(1);
  expect(pass.sent).toBe(2);
  expect(await h.deliveryKeys()).toEqual([fk]);
  expect(await h.assignee()).toBeNull();
  expect((await h.alertPass()).sent).toBe(0);
  await h.expectOneAlertTotal();
  void inboundMessageId;
}

describe("hot seller acceptance matrix (real database, real dispatch + alert pass, recording senders)", () => {
  it.each(ROWS)("row $id: $name", async (row) => {
    const h = await makeHarness(row.setup);
    await row.run(h);
    expect({ slack: h.slack(), sms: h.sms(), assigned: await h.handoffEvents() }).toEqual(row.expect);
    // Nothing is ever texted to the seller, and nobody but the owner is ever pinged.
    expect(await count("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [h.propertyId])).toBe(0);
    expect(h.sent.every((x) => x.userId === (h.extra.recipient ?? h.owner))).toBe(true);
  }, 180_000);
});
