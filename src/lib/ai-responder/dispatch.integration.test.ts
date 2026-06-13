import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import { sendSmsToContact } from "@/lib/messaging/send";
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

async function seedPropertyForContact(args: {
  contactId: string;
  state?: string;
  address: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address: args.address,
      state: args.state ?? "MO",
      status: "new_lead",
      homeowner_contact_id: args.contactId,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`property seed failed: ${error?.message ?? "unknown"}`);
  }
  return data.id;
}

async function seedMessageThread(args: {
  propertyId: string;
  contactId: string;
  conversationId: string;
}) {
  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .select("org_id")
    .eq("id", args.propertyId)
    .single();
  if (propertyError || !property) {
    throw new Error(
      `thread property lookup failed: ${propertyError?.message ?? "unknown"}`,
    );
  }

  const { error } = await supabase.from("message_threads").upsert(
    {
      org_id: property.org_id,
      channel: "sms",
      contact_id: args.contactId,
      property_id: args.propertyId,
      conversation_id: args.conversationId,
    },
    { onConflict: "channel,contact_id,property_id" },
  );
  if (error) {
    throw new Error(`thread seed failed: ${error.message}`);
  }
}

async function seedInboundMessage(args: {
  propertyId: string;
  contactId: string;
  conversationId: string;
  inboundMessageId: string;
  body: string;
}) {
  await seedMessageThread(args);
  await insertInboundMessageRecord(args);
}

async function insertInboundMessageRecord(args: {
  propertyId: string;
  contactId: string;
  conversationId?: string;
  inboundMessageId: string;
  body: string;
}) {
  const { error } = await supabase.from("messages").insert({
    id: args.inboundMessageId,
    channel: "sms",
    direction: "inbound",
    status: "received",
    property_id: args.propertyId,
    contact_id: args.contactId,
    conversation_id: args.conversationId ?? null,
    body: args.body,
  });
  if (error) {
    throw new Error(`inbound seed failed: ${error.message}`);
  }
}

async function seedInboundMessageWithoutConversation(args: {
  propertyId: string;
  contactId: string;
  inboundMessageId: string;
  body: string;
}) {
  await insertInboundMessageRecord(args);
}

function trackingAnthropic(
  out: AiStructuredOutput,
  opts: { delayMs?: number } = {},
): {
  anthropic: AnthropicLike;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(
    async (args: Parameters<AnthropicLike["messages"]["create"]>[0]) => {
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      return stubAnthropic(out).messages.create(args as never);
    },
  );
  return {
    anthropic: {
      messages: {
        create: createSpy as unknown as AnthropicLike["messages"]["create"],
      } as unknown as AnthropicLike["messages"],
    },
    createSpy,
  };
}

function withRpcOverride(
  client: typeof supabase,
  overrides: Record<
    string,
    (args: unknown) => Promise<{ data: unknown; error: { message: string; code?: string | null } | null }>
  >,
): typeof supabase {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "rpc") {
        return Reflect.get(target, prop, receiver);
      }
      return async (fn: string, args: unknown) => {
        const override = overrides[fn];
        if (override) return override(args);
        return target.rpc(fn as never, args as never);
      };
    },
  }) as typeof supabase;
}

function withThreadSyncFailure(
  client: typeof supabase,
  message: string,
): typeof supabase {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") {
        return Reflect.get(target, prop, receiver);
      }
      return (table: string) => {
        const builder = target.from(table as never);
        if (table !== "message_threads") {
          return builder;
        }
        return new Proxy(builder, {
          get(builderTarget, builderProp, builderReceiver) {
            if (builderProp !== "upsert") {
              return Reflect.get(builderTarget, builderProp, builderReceiver);
            }
            return async () => ({
              data: null,
              error: { message },
            });
          },
        });
      };
    },
  }) as typeof supabase;
}

async function expectSingleOutboundAiReply(
  conversationId: string,
  opts: {
    createSpy: ReturnType<typeof vi.fn>;
    expectedCreateCalls?: number;
  },
) {
  expect(opts.createSpy).toHaveBeenCalledTimes(opts.expectedCreateCalls ?? 2);
  expect(getMockMessageLog()).toHaveLength(1);

  const { data: outbound } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .eq("status", "sent");
  expect(outbound).toHaveLength(1);
}

async function expectThreadRow(args: {
  conversationId: string;
  propertyId: string;
  contactId: string;
}) {
  const { data: thread } = await supabase
    .from("message_threads")
    .select("conversation_id")
    .eq("channel", "sms")
    .eq("contact_id", args.contactId)
    .eq("property_id", args.propertyId)
    .single();
  expect(thread?.conversation_id).toBe(args.conversationId);
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

  it("throttles a second AI reply when two near-identical inbound texts land within 45 seconds in the same conversation", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554016",
    });
    const conversationId = "88888888-8888-4888-8888-888888888888";
    const firstInboundMessageId = "88888888-8888-4888-9888-888888888881";
    const secondInboundMessageId = "88888888-8888-4888-9888-888888888882";

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: firstInboundMessageId,
      body: "I do",
    });

    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);

    const firstOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "I do",
        inboundMessageId: firstInboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );
    expect(firstOutcome.outcome).toBe("sent");
    await expectThreadRow({ conversationId, propertyId, contactId });

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: secondInboundMessageId,
      body: "I do",
    });

    const secondOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "I do",
        inboundMessageId: secondInboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(secondOutcome).toEqual({
      outcome: "skipped",
      reason: "duplicate_throttled",
    });
    await expectSingleOutboundAiReply(conversationId, {
      createSpy: trackedAnthropic.createSpy,
    });
  });

  it("keeps the debounce scoped to the active conversation, not the whole contact", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554018",
    });
    const siblingPropertyId = await seedPropertyForContact({
      contactId,
      address: "2 AI Ln",
    });
    const firstConversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondConversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const firstInboundMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
    const secondInboundMessageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02";

    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId: firstConversationId,
      inboundMessageId: firstInboundMessageId,
      body: "hello",
    });
    const firstOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId: firstConversationId,
        inboundBody: "hello",
        inboundMessageId: firstInboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(firstOutcome.outcome).toBe("sent");

    await seedInboundMessage({
      propertyId: siblingPropertyId,
      contactId,
      conversationId: secondConversationId,
      inboundMessageId: secondInboundMessageId,
      body: "still interested",
    });
    const secondOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId: siblingPropertyId,
        contactId,
        conversationId: secondConversationId,
        inboundBody: "still interested",
        inboundMessageId: secondInboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(secondOutcome.outcome).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(2);
  });

  it("allows a second AI reply after the 45-second debounce window expires", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554017",
    });
    const conversationId = "99999999-9999-4999-8999-999999999999";
    const firstInboundMessageId = "99999999-9999-4999-9999-999999999991";
    const secondInboundMessageId = "99999999-9999-4999-9999-999999999992";

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: firstInboundMessageId,
      body: "?",
    });

    const firstOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "?",
        inboundMessageId: firstInboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(firstOutcome.outcome).toBe("sent");
    await expectThreadRow({ conversationId, propertyId, contactId });

    const staleCreatedAt = new Date(Date.now() - 46_000).toISOString();
    const { error: ageError } = await supabase
      .from("messages")
      .update({ created_at: staleCreatedAt, sent_at: staleCreatedAt })
      .eq("conversation_id", conversationId)
      .eq("direction", "outbound");
    if (ageError) {
      throw new Error(`failed to age outbound AI reply: ${ageError.message}`);
    }
    const { error: leaseAgeError } = await supabase
      .from("message_threads")
      .update({
        ai_responder_debounce_token: null,
        ai_responder_debounce_until: staleCreatedAt,
      })
      .eq("conversation_id", conversationId);
    if (leaseAgeError) {
      throw new Error(
        `failed to age debounce lease: ${leaseAgeError.message}`,
      );
    }

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: secondInboundMessageId,
      body: "?",
    });

    const secondOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "?",
        inboundMessageId: secondInboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(secondOutcome.outcome).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(2);

    const { data: outbound } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("direction", "outbound");
    expect(outbound).toHaveLength(2);
  });

  it("does not throttle on a recent failed AI outbound row", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554019",
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const inboundMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";

    await seedMessageThread({ propertyId, contactId, conversationId });
    await supabase.from("messages").insert({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccc02",
      channel: "sms",
      direction: "outbound",
      status: "failed",
      property_id: propertyId,
      contact_id: contactId,
      conversation_id: conversationId,
      body: "failed ai attempt",
      metadata: {
        generated_by: "ai_responder_v1",
      },
    });
    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "checking in",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "checking in",
        inboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(outcome.outcome).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(1);
  });

  it("treats a recent pending AI outbound row as an active thread debounce", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554030",
    });
    const conversationId = "30303030-3030-4303-8303-303030303030";
    const inboundMessageId = "30303030-3030-4303-8303-303030303001";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);

    await seedMessageThread({ propertyId, contactId, conversationId });
    await supabase.from("messages").insert({
      id: "30303030-3030-4303-8303-303030303002",
      channel: "sms",
      direction: "outbound",
      status: "pending",
      property_id: propertyId,
      contact_id: contactId,
      conversation_id: conversationId,
      body: "pending ai attempt",
      created_at: new Date(Date.now() - 30_000).toISOString(),
      metadata: {
        generated_by: "ai_responder_v1",
      },
    });
    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "checking in",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "checking in",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "duplicate_throttled",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("atomically throttles overlapping dispatches in the same conversation", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554020",
    });
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const firstInboundMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
    const secondInboundMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: firstInboundMessageId,
      body: "?",
    });
    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: secondInboundMessageId,
      body: "?",
    });

    const trackedAnthropic = trackingAnthropic(HAPPY_OUT, { delayMs: 100 });
    const [firstOutcome, secondOutcome] = await Promise.all([
      dispatchAiResponse(
        supabase,
        {
          propertyId,
          contactId,
          conversationId,
          inboundBody: "?",
          inboundMessageId: firstInboundMessageId,
        },
        { anthropic: trackedAnthropic.anthropic },
      ),
      dispatchAiResponse(
        supabase,
        {
          propertyId,
          contactId,
          conversationId,
          inboundBody: "?",
          inboundMessageId: secondInboundMessageId,
        },
        { anthropic: trackedAnthropic.anthropic },
      ),
    ]);

    expect([firstOutcome.outcome, secondOutcome.outcome].sort()).toEqual([
      "sent",
      "skipped",
    ]);
    expect(
      [firstOutcome, secondOutcome].some(
        (outcome) =>
          outcome.outcome === "skipped" &&
          outcome.reason === "duplicate_throttled",
      ),
    ).toBe(true);
    await expectThreadRow({ conversationId, propertyId, contactId });
    await expectSingleOutboundAiReply(conversationId, {
      createSpy: trackedAnthropic.createSpy,
      expectedCreateCalls: 2,
    });
  });

  it("does not send without a lease when the thread-debounce claim stays busy past the wait window", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554024",
    });
    const conversationId = "24242424-2424-4242-8242-242424242424";
    const inboundMessageId = "24242424-2424-4242-8242-242424242401";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const busyClaimClient = withRpcOverride(supabase, {
      claim_ai_responder_thread_debounce: async () => ({
        data: { status: "busy" },
        error: null,
      }),
    });

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      busyClaimClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      {
        anthropic: trackedAnthropic.anthropic,
        debounceBusyWaitMs: 20,
        debounceBusyPollMs: 1,
      },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_debounce_timeout",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: outbound } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("direction", "outbound");
    expect(outbound).toHaveLength(0);

    const { data: property } = await supabase
      .from("properties")
      .select("needs_human_attention")
      .eq("id", propertyId)
      .single();
    expect(property?.needs_human_attention).toBe(true);
  });

  it("falls back to the existing behavior when conversationId is missing", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554021",
    });
    const firstInboundMessageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01";
    const secondInboundMessageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);

    await seedInboundMessageWithoutConversation({
      propertyId,
      contactId,
      inboundMessageId: firstInboundMessageId,
      body: "I do",
    });
    const firstOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "I do",
        inboundMessageId: firstInboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );
    expect(firstOutcome.outcome).toBe("sent");

    await seedInboundMessageWithoutConversation({
      propertyId,
      contactId,
      inboundMessageId: secondInboundMessageId,
      body: "I do",
    });
    const secondOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        inboundBody: "I do",
        inboundMessageId: secondInboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(secondOutcome.outcome).toBe("sent");

    expect(trackedAnthropic.createSpy).toHaveBeenCalledTimes(4);
    expect(getMockMessageLog()).toHaveLength(2);
  });

  it("falls back to the existing behavior when the thread-debounce claim RPC is unavailable", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554022",
    });
    const conversationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const inboundMessageId = "ffffffff-ffff-4fff-8fff-ffffffffff01";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const claimBrokenClient = withRpcOverride(supabase, {
      claim_ai_responder_thread_debounce: async () => ({
        data: null,
        error: {
          code: "PGRST202",
          message: "claim_ai_responder_thread_debounce missing",
        },
      }),
    });

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      claimBrokenClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome.outcome).toBe("sent");
    expect(trackedAnthropic.createSpy).toHaveBeenCalledTimes(2);
    expect(getMockMessageLog()).toHaveLength(1);
  });

  it("escalates instead of sending when thread conversation repair fails", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554027",
    });
    const conversationId = "27272727-2727-4272-8272-272727272727";
    const inboundMessageId = "27272727-2727-4272-8272-272727272701";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const brokenThreadSyncClient = withThreadSyncFailure(
      supabase,
      "thread sync failed",
    );

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      brokenThreadSyncClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_conversation_sync_error",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: property } = await supabase
      .from("properties")
      .select("needs_human_attention")
      .eq("id", propertyId)
      .single();
    expect(property?.needs_human_attention).toBe(true);
  });

  it("escalates when an explicit conversationId already belongs to another thread", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554028",
    });
    const siblingPropertyId = await seedPropertyForContact({
      contactId,
      address: "28 Wrong Thread Ln",
    });
    const activeConversationId = "28282828-2828-4282-8282-282828282828";
    const wrongConversationId = "38383838-3838-4383-8383-383838383838";
    const inboundMessageId = "28282828-2828-4282-8282-282828282801";
    const wrongInboundMessageId = "38383838-3838-4383-8383-383838383801";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);

    await seedInboundMessage({
      propertyId: siblingPropertyId,
      contactId,
      conversationId: wrongConversationId,
      inboundMessageId: wrongInboundMessageId,
      body: "other thread",
    });
    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId: activeConversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId: wrongConversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_conversation_sync_error",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("escalates when an explicit conversationId has no existing owner", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554031",
    });
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const inboundMessageId = "31313131-3131-4313-8313-313131313101";

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId: "41414141-4141-4414-8414-414141414141",
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId: "51515151-5151-4515-8515-515151515151",
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_conversation_sync_error",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("escalates instead of falling back when the thread-debounce claim payload is malformed", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554029",
    });
    const conversationId = "29292929-2929-4292-8292-292929292929";
    const inboundMessageId = "29292929-2929-4292-8292-292929292901";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const malformedClaimClient = withRpcOverride(supabase, {
      claim_ai_responder_thread_debounce: async () => ({
        data: { nope: "bad-payload" },
        error: null,
      }),
    });

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      malformedClaimClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_debounce_error",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("escalates instead of sending when the thread-debounce claim RPC errors", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554026",
    });
    const conversationId = "26262626-2626-4262-8262-262626262626";
    const inboundMessageId = "26262626-2626-4262-8262-262626262601";
    const trackedAnthropic = trackingAnthropic(HAPPY_OUT);
    const brokenClaimClient = withRpcOverride(supabase, {
      claim_ai_responder_thread_debounce: async () => ({
        data: null,
        error: {
          code: "57014",
          details: "",
          hint: "",
          message: "claim rpc timed out",
          name: "PostgrestError",
        },
      }),
    });

    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "hello",
    });

    const outcome = await dispatchAiResponse(
      brokenClaimClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "hello",
        inboundMessageId,
      },
      { anthropic: trackedAnthropic.anthropic },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "thread_debounce_error",
    });
    expect(trackedAnthropic.createSpy).not.toHaveBeenCalled();
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: property } = await supabase
      .from("properties")
      .select("needs_human_attention")
      .eq("id", propertyId)
      .single();
    expect(property?.needs_human_attention).toBe(true);
  });

  it("sends the outbound on the same explicit conversation that the debounce checked", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554025",
    });
    const staleConversationId = "25252525-2525-4252-8252-252525252525";
    const activeConversationId = "35353535-3535-4353-8353-353535353535";
    const inboundMessageId = "35353535-3535-4353-8353-353535353501";

    await seedMessageThread({
      propertyId,
      contactId,
      conversationId: staleConversationId,
    });
    await supabase.from("messages").insert({
      id: "25252525-2525-4252-8252-252525252501",
      channel: "sms",
      direction: "inbound",
      status: "received",
      property_id: propertyId,
      contact_id: contactId,
      conversation_id: staleConversationId,
      body: "stale thread history",
    });
    await insertInboundMessageRecord({
      propertyId,
      contactId,
      conversationId: activeConversationId,
      inboundMessageId,
      body: "yes",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId: activeConversationId,
        inboundBody: "yes",
        inboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );

    expect(outcome.outcome).toBe("sent");
    if (outcome.outcome !== "sent") return;

    const { data: outbound } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("id", outcome.messageId)
      .single();
    expect(outbound?.conversation_id).toBe(activeConversationId);

    const followUp = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "follow up",
    });
    expect(followUp.status).toBe("sent");
    if (followUp.status !== "sent") return;

    const { data: followUpRow } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("id", followUp.messageId)
      .single();
    expect(followUpRow?.conversation_id).toBe(activeConversationId);

    const { data: allRows } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("contact_id", contactId)
      .eq("property_id", propertyId);
    expect(allRows?.every((row) => row.conversation_id === activeConversationId)).toBe(true);
  });

  it("clears the lease with a direct row update when the release RPC fails", async () => {
    await seedConfig();
    const { propertyId, contactId } = await seedLead({
      phone: "+18167554023",
    });
    const conversationId = "12121212-1212-4212-8212-121212121212";
    const firstInboundMessageId = "12121212-1212-4212-8212-121212121201";
    const secondInboundMessageId = "12121212-1212-4212-8212-121212121202";
    const releaseBrokenClient = withRpcOverride(supabase, {
      release_ai_responder_thread_debounce: async () => ({
        data: null,
        error: {
          code: "PGRST202",
          message: "release_ai_responder_thread_debounce missing",
        },
      }),
    });

    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: firstInboundMessageId,
      body: "need a person",
    });
    const firstOutcome = await dispatchAiResponse(
      releaseBrokenClient,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "need a person",
        inboundMessageId: firstInboundMessageId,
      },
      {
        anthropic: stubAnthropic({
          action: "escalate",
          confidence: 0.8,
          sentiment: "neutral",
          escalation_reason: "needs human",
        }),
      },
    );
    expect(firstOutcome.outcome).toBe("escalated");

    const { data: leaseRow } = await supabase
      .from("message_threads")
      .select("ai_responder_debounce_until, ai_responder_debounce_token")
      .eq("conversation_id", conversationId)
      .single();
    expect(leaseRow?.ai_responder_debounce_until).toBeNull();
    expect(leaseRow?.ai_responder_debounce_token).toBeNull();

    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId: secondInboundMessageId,
      body: "following up",
    });
    const secondOutcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "following up",
        inboundMessageId: secondInboundMessageId,
      },
      { anthropic: stubAnthropic(HAPPY_OUT) },
    );
    expect(secondOutcome.outcome).toBe("sent");
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
    await seedMessageThread({
      propertyId,
      contactId: siblingContact!.id,
      conversationId: siblingConversationId,
    });
    await seedMessageThread({
      propertyId,
      contactId,
      conversationId: activeConversationId,
    });

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
    const conversationId = "abababab-abab-4bab-8bab-abababababab";
    const inboundMessageId = "abababab-abab-4bab-8bab-ababababab01";
    await seedInboundMessage({
      propertyId,
      contactId,
      conversationId,
      inboundMessageId,
      body: "what next",
    });

    const outcome = await dispatchAiResponse(
      supabase,
      {
        propertyId,
        contactId,
        conversationId,
        inboundBody: "what next",
        inboundMessageId,
      },
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
