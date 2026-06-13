import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  getMockMessageLog,
  resetMockState,
} from "@/lib/messaging/providers/mock";

import { dispatchAiResponse } from "./dispatch";
import type { AnthropicLike } from "./generate";
import type { AiStructuredOutput } from "./types";

// Force quiet-hours "open" for the whole file so the happy-path test is
// deterministic regardless of wall-clock. None of the other tests in this
// file exercise `business_hours_only: true`, so a blanket mock is safe.
vi.mock("@/lib/messaging/quiet-hours", () => ({
  checkQuietHours: () => ({
    ok: true,
    localTime: "12:00",
    zone: "America/Chicago",
  }),
}));

const supabase = createTestClient();

// ----------- Anthropic stub -------------------------------------------------

/** Returns a stub Anthropic client whose `messages.create` returns a
 *  single-tool-use response with the given structured output. */
function stubAnthropic(out: AiStructuredOutput): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "submit_reply",
            input: out,
          },
        ],
        role: "assistant",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    } as unknown as AnthropicLike["messages"],
  };
}

/** Returns a stub whose create throws — simulates a provider outage. */
function throwingAnthropic(err: Error): AnthropicLike {
  return {
    messages: {
      create: async () => {
        throw err;
      },
    } as unknown as AnthropicLike["messages"],
  };
}

// ----------- fixtures -------------------------------------------------------

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  return data!.id;
}

async function seedConfig(overrides: Partial<{
  active: boolean;
  business_hours_only: boolean;
  max_turns: number;
  min_confidence: number;
}> = {}) {
  const orgId = await getOrgId();
  // Delete any existing active config — unique partial index prevents two.
  await supabase
    .from("ai_responder_configs")
    .delete()
    .eq("org_id", orgId)
    .eq("active", true);
  const { data } = await supabase
    .from("ai_responder_configs")
    .insert({
      org_id: orgId,
      system_prompt: "test system prompt",
      // Default `business_hours_only: false` so tests pass at any
      // time of day. Tests that specifically exercise the
      // business-hours gate override this back to true.
      business_hours_only: false,
      ...overrides,
    })
    .select("id")
    .single();
  return data!.id;
}

async function seedLead(opts: {
  phone: string;
  optIn?: boolean;
  disabled?: boolean;
  state?: string;
}): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: "AI",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (opts.optIn !== false) {
    await supabase.from("consent_events").insert({
      contact_id: contact!.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "ai-responder-test",
    });
  }
  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: "1 AI Ln",
      state: opts.state ?? "MO",
      status: "new_lead",
      homeowner_contact_id: contact!.id,
      ai_responder_disabled: opts.disabled ?? false,
    })
    .select("id")
    .single();
  return { propertyId: property!.id, contactId: contact!.id };
}

const HAPPY_OUT: AiStructuredOutput = {
  action: "send_reply",
  body: "Thanks for the reply — someone will reach out shortly.",
  confidence: 0.9,
  sentiment: "positive",
};

describe("dispatchAiResponse (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
  });

  // --------------------------------------------------------------------------
  // Happy path — relies on the file-level `vi.mock` of quiet-hours above.
  // --------------------------------------------------------------------------
  it("happy path: Claude approves → sends via sendSmsToContact and stamps AI metadata", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554001",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "yeah I'm interested, tell me more",
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome.outcome).toBe("sent");

    // Mock provider log has one send with the AI body
    const log = getMockMessageLog();
    expect(log).toHaveLength(1);
    expect(log[0].body).toContain("someone will reach out");

    // DB: messages row has AI metadata
    const { data: msgs } = await supabase
      .from("messages")
      .select("direction, metadata, body")
      .eq("property_id", propertyId)
      .eq("direction", "outbound");
    expect(msgs).toHaveLength(1);
    const meta = msgs![0].metadata as {
      generated_by: string;
      confidence: number;
      sentiment: string;
      turn: number;
    };
    expect(meta.generated_by).toBe("ai_responder_v1");
    expect(meta.confidence).toBe(0.9);
    expect(meta.sentiment).toBe("positive");
    expect(meta.turn).toBe(1);
  });

  it("skips when an AI reply already exists for the same inbound message", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554011",
    });
    const inboundMessageId = "33333333-3333-4333-8333-333333333333";

    await supabase.from("messages").insert({
      id: "44444444-4444-4444-8444-444444444444",
      channel: "sms",
      direction: "outbound",
      status: "sent",
      property_id: propertyId,
      contact_id: contactId,
      body: "already sent",
      metadata: {
        generated_by: "ai_responder_v1",
        inbound_message_id: inboundMessageId,
      },
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "following up",
        inboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_replied",
    });
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("preserves inbound_message_id after send so a replay does not send a second AI reply", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554012",
    });
    const inboundMessageId = "55555555-5555-4555-8555-555555555555";

    const firstOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "sounds good",
        inboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(firstOutcome.outcome).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(1);

    const replayOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "sounds good",
        inboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(replayOutcome).toEqual({
      outcome: "skipped",
      reason: "already_replied",
    });
    expect(getMockMessageLog()).toHaveLength(1);

    const { data: outbound } = await supabase
      .from("messages")
      .select("metadata")
      .eq("property_id", propertyId)
      .eq("direction", "outbound")
      .single();
    expect(outbound?.metadata).toMatchObject({
      generated_by: "ai_responder_v1",
      inbound_message_id: inboundMessageId,
    });
  });

  it("scopes AI turn count and conversation history to the actual thread, not the whole property", async () => {
    await seedConfig({ max_turns: 1 });
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554013",
    });
    const siblingConversationId = "66666666-6666-4666-8666-666666666666";
    const activeConversationId = "77777777-7777-4777-8777-777777777777";

    const { data: siblingContact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Sibling",
        last_name: "Thread",
        phone_1: "+18167554913",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    await supabase.from("consent_events").insert({
      contact_id: siblingContact!.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "ai-responder-test",
    });

    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        property_id: propertyId,
        contact_id: siblingContact!.id,
        conversation_id: siblingConversationId,
        body: "sibling conversation inbound",
      },
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        property_id: propertyId,
        contact_id: siblingContact!.id,
        conversation_id: siblingConversationId,
        body: "sibling conversation outbound",
        metadata: {
          generated_by: "ai_responder_v1",
          model: "claude-haiku-4-5-20251001",
          confidence: 0.9,
          sentiment: "positive",
          turn: 1,
        },
      },
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        property_id: propertyId,
        contact_id: contactId,
        conversation_id: activeConversationId,
        body: "my earlier thread message",
      },
    ]);

    let capturedMessages: Array<{ role: string; content: string }> = [];
    const trackingAnthropic: AnthropicLike = {
      messages: {
        create: (async (args: { messages: Array<{ role: string; content: string }> }) => {
          if (capturedMessages.length === 0) {
            capturedMessages = args.messages;
          }
          return stubAnthropic(HAPPY_OUT).messages.create(args as never);
        }) as unknown as AnthropicLike["messages"]["create"],
      } as unknown as AnthropicLike["messages"],
    };

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId: activeConversationId,
        inboundBody: "active thread latest inbound",
      },
      { anthropic: trackingAnthropic },
    );

    expect(outcome.outcome).toBe("sent");
    expect(capturedMessages.map((message) => message.content)).toEqual([
      "my earlier thread message",
      "active thread latest inbound",
    ]);
    expect(capturedMessages.map((message) => message.content)).not.toContain(
      "sibling conversation inbound",
    );
    expect(getMockMessageLog()).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Keyword escalation tiers — no Claude call, property flagged
  // --------------------------------------------------------------------------
  it("tier-B keyword ($150k) → escalates without calling Claude", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554002",
    });
    let claudeCalls = 0;
    const trackingAnthropic: AnthropicLike = {
      messages: {
        create: (async () => {
          claudeCalls++;
          return stubAnthropic(HAPPY_OUT).messages.create({} as never);
        }) as unknown as AnthropicLike["messages"]["create"],
      } as unknown as AnthropicLike["messages"],
    };

    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "what about $150k?" },
      { anthropic: trackingAnthropic },
    );
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome === "escalated") {
      expect(outcome.reason).toContain("keyword:price_offer");
    }
    expect(claudeCalls).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: property } = await supabase
      .from("properties")
      .select("needs_human_attention")
      .eq("id", propertyId)
      .single();
    expect(property!.needs_human_attention).toBe(true);
  });

  it("tier-C keyword (lawyer) → escalates", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554003",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "my lawyer said no" },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome.outcome).toBe("escalated");
  });

  // --------------------------------------------------------------------------
  // Skip paths
  // --------------------------------------------------------------------------
  it("property.ai_responder_disabled=true → skipped", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554004",
      disabled: true,
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "disabled_per_property",
    });
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("contact opted out → skipped with reason no_consent", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554005",
      optIn: false,
    });
    await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_out",
      source: "test",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome).toEqual({ outcome: "skipped", reason: "no_consent" });
  });

  // No org-wide daily cap — provider/API credits are the only cap
  // (Jarrad's standing rule; daily_send_cap removed 2026-06-12).

  // --------------------------------------------------------------------------
  // Model-driven escalations
  // --------------------------------------------------------------------------
  it("Claude returns action=escalate → escalated with reason from model", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554007",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "complex situation" },
      {
        anthropic: stubAnthropic({
          action: "escalate",
          confidence: 0.8,
          sentiment: "neutral",
          escalation_reason: "complex situation, needs human",
        }),
      },
    );
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome === "escalated") {
      expect(outcome.reason).toContain("complex situation");
    }
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("confidence below threshold (0.65 < 0.70) → auto-escalate", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554008",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "idk" },
      {
        anthropic: stubAnthropic({
          ...HAPPY_OUT,
          confidence: 0.65,
        }),
      },
    );
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome === "escalated") {
      expect(outcome.reason).toContain("low_confidence");
    }
  });

  it("sentiment=frustrated → auto-escalate regardless of keywords", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554009",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "you people are useless" },
      {
        anthropic: stubAnthropic({
          ...HAPPY_OUT,
          sentiment: "frustrated",
        }),
      },
    );
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome === "escalated") {
      expect(outcome.reason).toContain("sentiment:frustrated");
    }
  });

  // --------------------------------------------------------------------------
  // Safety validator
  // --------------------------------------------------------------------------
  it("model returns a body with a dollar amount → safety validator escalates", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554010",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "what next" },
      {
        anthropic: stubAnthropic({
          ...HAPPY_OUT,
          body: "We can offer $120k for your place",
        }),
      },
    );
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome === "escalated") {
      expect(outcome.reason).toContain("safety");
    }
    expect(getMockMessageLog()).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Turn limit — count AI turns already in thread
  // --------------------------------------------------------------------------
  it("max_turns already reached in thread → skip with max_turns_reached", async () => {
    await seedConfig({ max_turns: 2 });
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554011",
    });
    // Pre-populate 2 AI-generated outbound messages in this thread.
    for (let i = 0; i < 2; i++) {
      await supabase.from("messages").insert({
        channel: "sms",
        direction: "outbound",
        status: "sent",
        property_id: propertyId,
        contact_id: contactId,
        body: `prior AI turn ${i}`,
        metadata: {
          generated_by: "ai_responder_v1",
          model: "x",
          confidence: 0.9,
          sentiment: "positive",
          turn: i + 1,
        },
      });
    }

    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "ok" },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome).toEqual({ outcome: "skipped", reason: "max_turns_reached" });
  });

  // --------------------------------------------------------------------------
  // Provider error → escalate
  // --------------------------------------------------------------------------
  it("Claude call throws → escalate with reason generate_error", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554012",
    });
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: throwingAnthropic(new Error("provider down")) },
    );
    expect(outcome).toEqual({ outcome: "escalated", reason: "generate_error" });
  });

  it("credit-balance failure → provider_billing reason + one admin notification", async () => {
    // The live 2026-06-12 incident shape: Anthropic 400 with the
    // credit-balance message. Must escalate with the DISTINCT reason and
    // notify admins (throttled), not blend into generate_error.
    await seedConfig();
    // Seed a real admin: listAdminUserIds filters auth users against
    // ADMIN_EMAILS (read at call time).
    const adminEmail = `ai-billing-admin-${Date.now()}@test.example.com`;
    const prevAdminEmails = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = adminEmail;
    const { data: adminUser, error: adminErr } =
      await supabase.auth.admin.createUser({
        email: adminEmail,
        password: `test-pw-${Math.random().toString(36).slice(2)}`,
        email_confirm: true,
      });
    if (adminErr || !adminUser.user) {
      throw new Error(`admin seed failed: ${adminErr?.message}`);
    }
    const adminUserId = adminUser.user.id;
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554013",
    });
    const billingError = Object.assign(
      new Error(
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
      { status: 400 },
    );
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: throwingAnthropic(billingError) },
    );
    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "provider_billing",
    });

    const { data: prop } = await supabase
      .from("properties")
      .select("needs_human_attention, last_ai_escalation_reason")
      .eq("id", propertyId)
      .single();
    expect(prop!.needs_human_attention).toBe(true);
    expect(prop!.last_ai_escalation_reason).toBe("provider_billing");

    const { data: notifs } = await supabase
      .from("notifications")
      .select("id, title")
      .eq("event_type", "ai_responder_provider_failure");
    expect(notifs!.length).toBeGreaterThan(0);
    expect(notifs![0].title).toMatch(/credits/i);
    const firstCount = notifs!.length;

    // Second failure inside the 24h window: escalates again but does
    // NOT add another notification (throttle).
    const { propertyId: p2, contactId: c2 } = await seedLead({
      phone: "+18167554014",
    });
    await dispatchAiResponse(
      supabase,
      { propertyId: p2, contactId: c2, inboundBody: "hey" },
      { anthropic: throwingAnthropic(billingError) },
    );
    const { data: notifs2 } = await supabase
      .from("notifications")
      .select("id")
      .eq("event_type", "ai_responder_provider_failure");
    expect(notifs2!.length).toBe(firstCount);

    // Cleanup: shared test project — don't leak the auth user or env.
    process.env.ADMIN_EMAILS = prevAdminEmails;
    await supabase.auth.admin.deleteUser(adminUserId);
  });

  it("dedupe index: same admin/kind/day blocked within an org, allowed across orgs", async () => {
    // Codex re-review P1: an admin allowlisted in two orgs must get one
    // outage alert PER ORG. The 076 partial unique index is keyed
    // (org_id, user_id, title, utc-day) — verify both sides at the DB.
    const adminEmail = `dedupe-admin-${Date.now()}@test.example.com`;
    const { data: adminUser } = await supabase.auth.admin.createUser({
      email: adminEmail,
      password: `test-pw-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    const adminUserId = adminUser!.user!.id;
    const { data: orgA } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .single();
    const { data: orgB, error: orgBErr } = await supabase
      .from("organizations")
      .insert({ name: `dedupe-test-org-${Date.now()}` })
      .select("id")
      .single();
    if (orgBErr || !orgB) throw new Error(`org seed failed: ${orgBErr?.message}`);

    const row = (orgId: string) => ({
      org_id: orgId,
      user_id: adminUserId,
      event_type: "ai_responder_provider_failure",
      entity_type: "property",
      entity_id: "00000000-0000-0000-0000-000000000001",
      title: "AI responder is DOWN — Anthropic credits exhausted",
      body: "test",
    });

    const first = await supabase.from("notifications").insert(row(orgA!.id));
    expect(first.error).toBeNull();
    // Same org, same kind, same day → conflict.
    const dup = await supabase.from("notifications").insert(row(orgA!.id));
    expect(dup.error?.message ?? "").toMatch(/duplicate key/i);
    // Different org, same admin/kind/day → allowed.
    const crossOrg = await supabase.from("notifications").insert(row(orgB.id));
    expect(crossOrg.error).toBeNull();

    // Cleanup (shared test project).
    await supabase
      .from("notifications")
      .delete()
      .eq("event_type", "ai_responder_provider_failure");
    await supabase.from("organizations").delete().eq("id", orgB.id);
    await supabase.auth.admin.deleteUser(adminUserId);
  });

  it("401 auth failure → provider_auth reason", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554015",
    });
    const authError = Object.assign(
      new Error("authentication_error: invalid x-api-key"),
      { status: 401 },
    );
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: throwingAnthropic(authError) },
    );
    expect(outcome).toEqual({ outcome: "escalated", reason: "provider_auth" });
  });
});
