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
  daily_send_cap: number;
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

  it("daily cap exceeded → skipped", async () => {
    // Cap=2; seed 2 prior AI-generated outbound messages on OTHER
    // properties in the same org so the counter is already at the cap.
    await seedConfig({ daily_send_cap: 2 });
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554006",
    });
    // Pre-populate 2 AI-origin outbound messages on the same org (any
    // property — count is org-wide).
    const { data: otherContact } = await supabase
      .from("contacts")
      .insert({ phone_1: "+18167554106" })
      .select("id")
      .single();
    const { data: otherProp } = await supabase
      .from("properties")
      .insert({
        address: "99 Cap Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: otherContact!.id,
      })
      .select("id")
      .single();
    for (let i = 0; i < 2; i++) {
      await supabase.from("messages").insert({
        channel: "sms",
        direction: "outbound",
        status: "sent",
        property_id: otherProp!.id,
        contact_id: otherContact!.id,
        body: `prior AI ${i}`,
        metadata: {
          generated_by: "ai_responder_v1",
          model: "claude-haiku-4-5-20251001",
          confidence: 0.9,
          sentiment: "positive",
          turn: 1,
        },
      });
    }

    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId, contactId, inboundBody: "hey" },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(outcome).toEqual({ outcome: "skipped", reason: "daily_cap" });
  });

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
});
