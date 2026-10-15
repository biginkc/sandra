import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { createHoldAlertDeps } from "@/lib/hold-alerts";
import { runHoldAlertsForOrg } from "@/lib/hold-alerts/core";
import type { HoldAlertDeps } from "@/lib/hold-alerts/types";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { assignHotLeadToOwner, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "./assign";

/**
 * Full hot-seller path with the new_lead switch ON, on a DISPOSABLE database
 * that has every migration (Messages v2 redesign, PR 2). Local only; runs in CI
 * in the "Search RPC, oracle and composition suites (disposable DB)" job.
 *
 * Chain under test, nothing in it mocked except the two outside services:
 *   inbound message -> dispatchAiResponse (Jev classifier, automatic mode,
 *   new_lead threshold on) -> fn_auto_apply_jev_lead_decision -> hot hand-off
 *   to the org's one active owner -> runHoldAlertsForOrg -> one Slack + one SMS.
 *
 * Fake outside services: Jev (global fetch to api.typesafe.ai) and the Slack /
 * SMS senders (recording). Any other outbound HTTP call fails the test.
 * Everything runs in one temporary organization this file creates and removes.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const admin = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const created = { orgs: [] as string[], users: [] as string[] };
const realFetch = globalThis.fetch;
const jevCalls: string[] = [];

/** Fake Jev: a new lead, 0.95 confident, asking for a price. Nothing else may leave the process. */
function installFakeJev() {
  vi.stubEnv("TYPESAFE_API_KEY", "fake-test-key");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      jevCalls.push(url);
      return new Response(
        JSON.stringify({
          model: "jev-fake",
          answers: {
            outcome: { choice: "new_lead", confidence: 0.95, probabilities: { new_lead: 0.95 } },
            escalation_reason: { choice: "price_or_offer", probabilities: { price_or_offer: 0.9 } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Only the local Supabase stack (loopback) is reachable.
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP in test: ${url}`);
    return realFetch(input, init);
  });
}

// The legacy classifier must never run in automatic mode; if it does, fail loudly.
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
        // Temp-org rows only; triggers (final-owner guard, ledger guards) are bypassed for this transaction.
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
        for (const [col, scope] of [
          ["property_id", "select id from public.properties where org_id = $1"],
          ["contact_id", "select id from public.contacts where org_id = $1"],
          ["conversation_id", "select id from public.conversations where org_id = $1"],
        ] as const) {
          for (const table of by(col)) {
            if (skip.has(table)) continue;
            await pg.query(`delete from public."${table}" where "${col}" in (${scope})`, [orgId]).catch(async () => {
              await pg.query("rollback");
              await pg.query("begin");
              await pg.query("set local session_replication_role = replica");
            });
          }
        }
        for (const table of by("org_id")) {
          if (table === "organizations") continue;
          await pg.query(`delete from public."${table}" where org_id = $1`, [orgId]).catch(async () => {
            await pg.query("rollback");
            await pg.query("begin");
            await pg.query("set local session_replication_role = replica");
          });
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
    email: `hot-switch-${randomUUID()}@test.local`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user create failed: ${error?.message}`);
  created.users.push(data.user.id);
  const { error: membershipError } = await admin.from("memberships").insert({ user_id: data.user.id, org_id: orgId, role });
  if (membershipError) throw new Error(`membership insert failed: ${membershipError.message}`);
  return data.user.id;
}

async function seedScenario(opts: { watermark?: boolean; personAssigned?: boolean; repAssigned?: boolean } = {}) {
  const orgId = randomUUID();
  const { error: orgError } = await admin.from("organizations").insert({ id: orgId, name: `hot-switch-on ${orgId}` });
  if (orgError) throw new Error(`org insert failed: ${orgError.message}`);
  created.orgs.push(orgId);

  const owner = await createMember(orgId, "owner");
  const member = await createMember(orgId, "member"); // a non-owner must never be pinged or assigned

  // My Leads on, owner designated (the designation guard wants its transaction-local marker).
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

  // Jev is the classifier and runs automatic; the new_lead switch is ON at 0.9.
  const { error: configError } = await admin.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "hot switch-on test prompt",
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
    source: "hot-switch-on-test",
  });
  if (consentError) throw new Error(`consent insert failed: ${consentError.message}`);

  const { data: property, error: propertyError } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      address: "12 Switch On Ln",
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
      ...(opts.personAssigned ? { assigned_user_id: owner } : opts.repAssigned ? { assigned_user_id: member } : {}),
    })
    .select("id, status, assigned_user_id")
    .single();
  if (propertyError || !property) throw new Error(`property insert failed: ${propertyError?.message}`);
  expect(property.status).toBe("prospect");
  expect(property.assigned_user_id).toBe(opts.personAssigned ? owner : opts.repAssigned ? member : null);
  if (opts.personAssigned) {
    // A person (not Sandra) gave him this lead: the ledger has an 'assigned' event naming him.
    const { error: assignedError } = await admin.from("lead_events").insert({
      org_id: orgId,
      property_id: property.id,
      actor_type: "user",
      actor_id: owner,
      event_type: "assigned",
      payload: { from: null, to: owner },
    } as never);
    if (assignedError) throw new Error(`assigned event seed failed: ${assignedError.message}`);
  }

  const body = "yes I might sell, what could you pay for it?";
  const { data: inbound, error: inboundError } = await admin
    .from("messages")
    .insert({
      org_id: orgId,
      channel: "sms",
      direction: "inbound",
      status: "received",
      property_id: property.id,
      contact_id: contact.id,
      from_address: phone,
      to_address: "+18165550100",
      body,
    })
    .select("id, conversation_id")
    .single();
  if (inboundError || !inbound?.conversation_id) throw new Error(`inbound insert failed: ${inboundError?.message}`);

  // By default alerts were enabled before the promotion. `watermark: false` leaves the org brand new:
  // no hold_alert_settings row, so the first alert pass itself initialises it.
  if (opts.watermark !== false) {
    const { error: seedError } = await admin
      .from("hold_alert_settings" as never)
      .insert({ org_id: orgId, alerts_since: new Date(Date.now() - 60 * 60 * 1000).toISOString() } as never);
    if (seedError) throw new Error(`hold_alert_settings seed failed: ${seedError.message}`);
  }

  return {
    orgId,
    owner,
    member,
    propertyId: property.id,
    contactId: contact.id,
    conversationId: inbound.conversation_id,
    inboundMessageId: inbound.id,
    phone,
    body,
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pg.query(sql, params);
  return Number(rows[0].n);
}

describe("hot seller: full dispatch with the new_lead switch on (real database, fake Jev, recording senders)", () => {
  it("promotes to the owner on My Leads, alerts the owner once on Slack and SMS, texts the seller nothing, and a full replay changes nothing", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario();

    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
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

    const dispatchOnce = () =>
      dispatchAiResponse(
        admin,
        {
          propertyId: s.propertyId,
          contactId: s.contactId,
          conversationId: s.conversationId,
          inboundMessageId: s.inboundMessageId,
          inboundFromPhone: s.phone,
          inboundBody: s.body,
        },
        { anthropic: forbiddenAnthropic },
      );

    const snapshot = async () => ({
      status: (await admin.from("properties").select("status, assigned_user_id").eq("id", s.propertyId).single()).data,
      episodes: await count("select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1", [s.propertyId]),
      openEpisodes: await count(
        "select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1 and ended_at is null and assignee_user_id = $2",
        [s.propertyId, s.owner],
      ),
      assignedEvents: await count(
        "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned' and source_type = $2",
        [s.propertyId, HOT_HANDOFF_SOURCE_TYPE],
      ),
      deliveries: await count("select count(*)::int as n from public.hold_alert_deliveries where org_id = $1", [s.orgId]),
      outboundToSeller: await count(
        "select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'",
        [s.propertyId],
      ),
      senderCalls: sent.length,
      mockProviderLog: getMockMessageLog().length,
    });

    // ---- first pass ---------------------------------------------------------
    const outcome = await dispatchOnce();
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
    expect(jevCalls.length).toBeGreaterThanOrEqual(1);

    const alerts = await runHoldAlertsForOrg(deps, s.orgId);
    expect(alerts.sent).toBe(2);

    const first = await snapshot();
    // The lead is promoted and handed to the owner, never the other member.
    expect(first.status).toEqual({ status: "new_lead", assigned_user_id: s.owner });
    expect(first.status?.assigned_user_id).not.toBe(s.member);
    // The assignment trigger opened exactly one My Leads episode, on the owner.
    expect(first.episodes).toBe(1);
    expect(first.openEpisodes).toBe(1);
    // Exactly one hand-off event, naming the owner.
    expect(first.assignedEvents).toBe(1);
    const { rows: events } = await pg.query(
      "select payload from public.lead_events where property_id = $1 and event_type = 'assigned' and source_type = $2",
      [s.propertyId, HOT_HANDOFF_SOURCE_TYPE],
    );
    expect((events[0].payload as { to?: string }).to).toBe(s.owner);

    // Exactly one Slack and one SMS delivery, both sent, both to the owner.
    const { rows: deliveries } = await pg.query(
      "select channel, status, recipient_user_id, hold_key from public.hold_alert_deliveries where org_id = $1 order by channel",
      [s.orgId],
    );
    expect(deliveries.map((d) => d.channel)).toEqual(["slack", "sms"]);
    for (const d of deliveries) {
      expect(d.status).toBe("sent");
      expect(d.recipient_user_id).toBe(s.owner);
      expect(d.hold_key).toBe(`hot_handoff:${s.inboundMessageId}`);
    }
    expect(sent.map((x) => x.channel).sort()).toEqual(["slack", "sms"]);
    expect(sent.every((x) => x.userId === s.owner)).toBe(true);
    // The alerts carry no seller text.
    expect(sent.every((x) => !x.text.includes("what could you pay"))).toBe(true);

    // The seller is texted nothing: no outbound row, nothing at the provider.
    expect(first.outboundToSeller).toBe(0);
    expect(first.mockProviderLog).toBe(0);

    // ---- full replay: same inbound dispatched again, alert pass run again ----
    const replay = await dispatchOnce();
    expect(replay.outcome).not.toBe("sent");
    const replayAlerts = await runHoldAlertsForOrg(deps, s.orgId);
    expect(replayAlerts.sent).toBe(0);

    const second = await snapshot();
    expect(second).toEqual(first);
    expect(sent).toHaveLength(2);
  }, 120_000);
  it("first alert pass for a brand-new org (no hold_alert_settings row before dispatch) still sends one Slack and one SMS, and a second pass sends nothing", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario({ watermark: false });
    expect(await count("select count(*)::int as n from public.hold_alert_settings where org_id = $1", [s.orgId])).toBe(0);

    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
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

    const outcome = await dispatchAiResponse(
      admin,
      {
        propertyId: s.propertyId,
        contactId: s.contactId,
        conversationId: s.conversationId,
        inboundMessageId: s.inboundMessageId,
        inboundFromPhone: s.phone,
        inboundBody: s.body,
      },
      { anthropic: forbiddenAnthropic },
    );
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
    // Dispatch itself does not create the watermark: this really is the org's first alert pass.
    expect(await count("select count(*)::int as n from public.hold_alert_settings where org_id = $1", [s.orgId])).toBe(0);

    const first = await runHoldAlertsForOrg(deps, s.orgId);
    expect(first.sent).toBe(2);
    expect(sent.map((x) => x.channel).sort()).toEqual(["slack", "sms"]);
    expect(sent.every((x) => x.userId === s.owner)).toBe(true);
    // The pass created the watermark (no later than the 2026-10-15 cutoff).
    const { rows: marks } = await pg.query("select alerts_since from public.hold_alert_settings where org_id = $1", [s.orgId]);
    expect(marks).toHaveLength(1);
    // A new org initialises at the 2026-10-15 cutoff (or now, if the clock is before it): no 24h clamp.
    const markMs = new Date(marks[0].alerts_since).getTime();
    expect(markMs).toBe(Math.min(Date.parse("2026-10-15T00:00:00.000Z"), Date.now()));
    const { rows: deliveries } = await pg.query(
      "select channel, status, hold_key from public.hold_alert_deliveries where org_id = $1 order by channel",
      [s.orgId],
    );
    expect(deliveries.map((d) => [d.channel, d.status, d.hold_key])).toEqual([
      ["slack", "sent", `hot_handoff:${s.inboundMessageId}`],
      ["sms", "sent", `hot_handoff:${s.inboundMessageId}`],
    ]);

    sent.length = 0;
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(0);
    expect(sent).toHaveLength(0);
  }, 120_000);
  it("a second hot inbound after a completed hand-off: exactly one more Slack + one more SMS 'Hot text on your lead: <name>, <address>', no reassignment", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario();
    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
      ...real,
      async sendSlack(userId, text) { sent.push({ channel: "slack", userId, text }); return { status: "sent" }; },
      async sendSms(userId, text) { sent.push({ channel: "sms", userId, text }); return { status: "sent" }; },
    };
    const dispatchFor = (inboundMessageId: string, body: string) =>
      dispatchAiResponse(
        admin,
        { propertyId: s.propertyId, contactId: s.contactId, conversationId: s.conversationId, inboundMessageId, inboundFromPhone: s.phone, inboundBody: body },
        { anthropic: forbiddenAnthropic },
      );
    expect(await dispatchFor(s.inboundMessageId, s.body)).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(2);
    expect(sent.every((x) => x.text.startsWith("Hot seller:"))).toBe(true);

    const body2 = "actually please call me, I want to sell this week";
    const { data: second, error } = await admin
      .from("messages")
      .insert({
        org_id: s.orgId, channel: "sms", direction: "inbound", status: "received", property_id: s.propertyId,
        contact_id: s.contactId, from_address: s.phone, to_address: "+18165550100", body: body2,
      })
      .select("id")
      .single();
    if (error || !second) throw new Error(`second inbound insert failed: ${error?.message}`);

    await dispatchFor(second.id, body2);
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(2);
    const texts = sent.slice(2);
    expect(texts.map((x) => x.channel).sort()).toEqual(["slack", "sms"]);
    expect(texts.every((x) => x.userId === s.owner && x.text.startsWith("Hot text on your lead: Hannah, 12 Switch On Ln."))).toBe(true);
    expect(texts.every((x) => !x.text.includes("call me"))).toBe(true);

    // No reassignment: still one hand-off event, one episode, one owner.
    expect(await count("select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned'", [s.propertyId])).toBe(1);
    expect(await count("select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1", [s.propertyId])).toBe(1);
    expect(await count("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [s.propertyId, HOT_TEXT_SOURCE_TYPE])).toBe(1);
    expect(await count("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [s.propertyId])).toBe(0);

    // Replays add nothing.
    await dispatchFor(second.id, body2);
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(0);
    expect(sent).toHaveLength(4);
  }, 120_000);

  it("a lead a person already assigned to the owner: one Slack + one SMS 'Hot text on your lead', no reassignment, no new 'assigned' event; same inbound again sends nothing more", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario({ personAssigned: true });

    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
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
    const dispatchOnce = () =>
      dispatchAiResponse(
        admin,
        {
          propertyId: s.propertyId,
          contactId: s.contactId,
          conversationId: s.conversationId,
          inboundMessageId: s.inboundMessageId,
          inboundFromPhone: s.phone,
          inboundBody: s.body,
        },
        { anthropic: forbiddenAnthropic },
      );
    const assignedEvents = () =>
      count("select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned'", [s.propertyId]);
    const hotTextEvents = () =>
      count("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [s.propertyId, HOT_TEXT_SOURCE_TYPE]);

    expect(await assignedEvents()).toBe(1); // the person's own event
    const episodesBefore = await count("select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1", [s.propertyId]);

    const outcome = await dispatchOnce();
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });

    // No reassignment, no new 'assigned' event, no hand-off event; one hot_seller_text event keyed to this inbound.
    expect((await admin.from("properties").select("assigned_user_id").eq("id", s.propertyId).single()).data?.assigned_user_id).toBe(s.owner);
    expect(await assignedEvents()).toBe(1);
    expect(
      await count("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [s.propertyId, HOT_HANDOFF_SOURCE_TYPE]),
    ).toBe(0);
    expect(await hotTextEvents()).toBe(1);
    const { rows: textEvents } = await pg.query(
      "select event_type, source_id from public.lead_events where property_id = $1 and source_type = $2",
      [s.propertyId, HOT_TEXT_SOURCE_TYPE],
    );
    expect(textEvents[0]).toMatchObject({ event_type: "ai_escalated", source_id: s.inboundMessageId });
    expect(await count("select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1", [s.propertyId])).toBe(episodesBefore);

    const alerts = await runHoldAlertsForOrg(deps, s.orgId);
    expect(alerts.sent).toBe(2);
    expect(sent.map((x) => x.channel).sort()).toEqual(["slack", "sms"]);
    expect(sent.every((x) => x.userId === s.owner)).toBe(true);
    expect(sent.every((x) => x.text.startsWith("Hot text on your lead: Hannah, 12 Switch On Ln."))).toBe(true);
    expect(sent.every((x) => !x.text.includes("what could you pay"))).toBe(true);
    const { rows: deliveries } = await pg.query(
      "select channel, status, hold_key from public.hold_alert_deliveries where org_id = $1 order by channel",
      [s.orgId],
    );
    expect(deliveries.map((d) => [d.channel, d.status, d.hold_key])).toEqual([
      ["slack", "sent", `hot_text:${s.inboundMessageId}`],
      ["sms", "sent", `hot_text:${s.inboundMessageId}`],
    ]);

    // Same inbound again: dispatch and the alert pass add nothing.
    await dispatchOnce();
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(0);
    expect(sent).toHaveLength(2);
    expect(await assignedEvents()).toBe(1);
    expect(await hotTextEvents()).toBe(1);
    expect(await count("select count(*)::int as n from public.hold_alert_deliveries where org_id = $1", [s.orgId])).toBe(2);
  }, 120_000);
  function recorders() {
    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
      ...real,
      async sendSlack(userId, text) { sent.push({ channel: "slack", userId, text }); return { status: "sent" }; },
      async sendSms(userId, text) { sent.push({ channel: "sms", userId, text }); return { status: "sent" }; },
    };
    return { sent, deps };
  }
  async function insertInboundFor(s: Awaited<ReturnType<typeof seedScenario>>, body: string): Promise<string> {
    const { data, error } = await admin
      .from("messages")
      .insert({
        org_id: s.orgId, channel: "sms", direction: "inbound", status: "received", property_id: s.propertyId,
        contact_id: s.contactId, from_address: s.phone, to_address: "+18165550100", body,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`inbound insert failed: ${error?.message}`);
    return data.id;
  }
  const dispatchWith = (s: Awaited<ReturnType<typeof seedScenario>>, inboundMessageId: string, body: string) =>
    dispatchAiResponse(
      admin,
      { propertyId: s.propertyId, contactId: s.contactId, conversationId: s.conversationId, inboundMessageId, inboundFromPhone: s.phone, inboundBody: body },
      { anthropic: forbiddenAnthropic },
    );

  it("the assignment update fails: dispatch holds hot_lead_assign_failed, ONE alert pass sends exactly one Slack + one SMS (via the hold); a later hand-off on a NEW text while the hold is open is covered (no second ping)", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario();
    const { sent, deps } = recorders();

    // Block assignment writes to this one property.
    const fn = `hot_sw_block_${s.propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin
      if new.assigned_user_id is distinct from old.assigned_user_id then raise exception 'blocked for test'; end if; return new; end $$`);
    await pg.query(`create trigger ${fn} before update on public.properties for each row when (new.id = '${s.propertyId}') execute function public.${fn}()`);
    let blocked = true;
    const unblock = async () => {
      if (!blocked) return;
      blocked = false;
      await pg.query(`drop trigger if exists ${fn} on public.properties`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
    try {
      const first = await dispatchWith(s, s.inboundMessageId, s.body);
      expect(first).toEqual({ outcome: "escalated", reason: "hot_lead_assign_failed" });
      expect(await count("select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned' and source_type = $2", [s.propertyId, HOT_HANDOFF_SOURCE_TYPE])).toBe(0);
      expect((await admin.from("properties").select("assigned_user_id").eq("id", s.propertyId).single()).data?.assigned_user_id).toBeNull();

      expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(2);
      expect(sent.map((x) => x.channel).sort()).toEqual(["slack", "sms"]);
      expect(sent.every((x) => x.userId === s.owner)).toBe(true);
      const { rows: d1 } = await pg.query("select channel, status, hold_key from public.hold_alert_deliveries where org_id = $1 order by channel", [s.orgId]);
      // The hold is keyed by its own flag time (hot_flag:<property>:<flagAt>), property id null.
      expect(d1.map((d) => [d.channel, d.status])).toEqual([["slack", "sent"], ["sms", "sent"]]);
      expect(d1.every((d) => new RegExp(`^hot_flag:${s.propertyId}:`).test(d.hold_key))).toBe(true);
      // Same text, further passes: nothing.
      expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(0);
    } finally {
      await unblock();
    }

    // A NEW hot text, block gone: the hand-off succeeds, but the hold is still open so it is covered (no second ping).
    const body2 = "ok seriously, what is your best number?";
    const second = await insertInboundFor(s, body2);
    expect(await assignHotLeadToOwner(admin, s.propertyId, { inboundMessageId: second })).toEqual({ status: "assigned", assigneeUserId: s.owner });
    expect((await admin.from("properties").select("assigned_user_id").eq("id", s.propertyId).single()).data?.assigned_user_id).toBe(s.owner);
    expect((await runHoldAlertsForOrg(deps, s.orgId)).sent).toBe(0);
    expect(sent).toHaveLength(2);
    expect(await count("select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'assigned' and source_type = $2", [s.propertyId, HOT_HANDOFF_SOURCE_TYPE])).toBe(1);
    expect(await count("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [s.propertyId])).toBe(0);
  }, 120_000);

  it("a lead a rep owns: a hot text (model:hot_lead hold) pings nobody and texts the seller nothing", async () => {
    resetMockState();
    installFakeJev();
    const s = await seedScenario({ repAssigned: true });
    const { sent, deps } = recorders();

    await dispatchWith(s, s.inboundMessageId, s.body);
    expect((await admin.from("properties").select("assigned_user_id").eq("id", s.propertyId).single()).data?.assigned_user_id).toBe(s.member);
    const alerts = await runHoldAlertsForOrg(deps, s.orgId);
    expect(alerts.sent).toBe(0);
    expect(sent).toEqual([]);
    expect(await count("select count(*)::int as n from public.messages where property_id = $1 and direction = 'outbound'", [s.propertyId])).toBe(0);
    expect(await count("select count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and status = 'sent'", [s.orgId])).toBe(0);
  }, 120_000);
});
