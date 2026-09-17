import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

const recordLeadEvent = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { AI_ESCALATED: "ai_escalated" },
  recordLeadEvent,
}));

import {
  findRepSmsHumanTakeoverSource,
  isMariaThroughMelRepSms,
  persistRepSmsHumanTakeoverFallback,
  RepSmsHumanTakeoverLookupError,
  RepSmsHumanTakeoverPersistenceError,
  recordRepSmsHumanTakeover,
  REP_SMS_HUMAN_TAKEOVER_REASON,
} from "./rep-sms-human-takeover";

const outboundId = "11111111-1111-4111-8111-111111111111";
const inboundId = "22222222-2222-4222-8222-222222222222";

const mariaThroughMel = {
  repSms: {
    workflow: "maria-through-mel",
    persona: "Mel",
    assistant: "Maria",
    actorUserId: "rep-1",
    senderAssignmentId: "sender-1",
  },
};

type QueryResponse = {
  data: unknown;
  error: { message: string } | null;
};

type MockQueryBuilder = {
  select: (...args: unknown[]) => MockQueryBuilder;
  update: (payload: unknown) => MockQueryBuilder;
  eq: (...args: unknown[]) => MockQueryBuilder;
  neq: (...args: unknown[]) => MockQueryBuilder;
  not: (...args: unknown[]) => MockQueryBuilder;
  is: (...args: unknown[]) => MockQueryBuilder;
  lte: (...args: unknown[]) => MockQueryBuilder;
  order: (...args: unknown[]) => MockQueryBuilder;
  limit: (...args: unknown[]) => MockQueryBuilder;
  maybeSingle: () => Promise<QueryResponse>;
  then: (
    resolve: (value: QueryResponse) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

function makeClient(input?: {
  messages?: unknown[];
  inboundMessages?: unknown[];
  messageError?: { message: string } | null;
  propertyUpdate?: QueryResponse;
  threadUpdate?: QueryResponse;
}) {
  const calls: Array<{
    table: string;
    operation: string;
    payload?: unknown;
    filters: unknown[][];
    limitCalls: number;
    orders: unknown[][];
  }> = [];

  const from = vi.fn((table: string) => {
    const call: {
      table: string;
      operation: string;
      payload?: unknown;
      filters: unknown[][];
      limitCalls: number;
      orders: unknown[][];
    } = {
      table,
      operation: "select",
      filters: [],
      limitCalls: 0,
      orders: [],
    };
    calls.push(call);
    const response = (): QueryResponse => {
      if (table === "messages") {
        const inbound = call.filters.some(
          ([column, value]) => column === "direction" && value === "inbound",
        );
        return {
          data: inbound ? input?.inboundMessages ?? [] : input?.messages ?? [],
          error: input?.messageError ?? null,
        };
      }
      if (table === "properties") {
        return (
          input?.propertyUpdate ?? { data: { id: "property-1" }, error: null }
        );
      }
      return input?.threadUpdate ?? { data: null, error: null };
    };
    const builder: MockQueryBuilder = {
      select: vi.fn(() => builder),
      update: vi.fn((payload: unknown) => {
        call.operation = "update";
        call.payload = payload;
        return builder;
      }),
      eq: vi.fn((...args: unknown[]) => {
        call.filters.push(args);
        return builder;
      }),
      neq: vi.fn((...args: unknown[]) => {
        call.filters.push(args);
        return builder;
      }),
      not: vi.fn((...args: unknown[]) => {
        call.filters.push(args);
        return builder;
      }),
      is: vi.fn((...args: unknown[]) => {
        call.filters.push(args);
        return builder;
      }),
      lte: vi.fn((...args: unknown[]) => {
        call.filters.push(args);
        return builder;
      }),
      order: vi.fn((...args: unknown[]) => {
        call.orders.push(args);
        return builder;
      }),
      limit: vi.fn(() => {
        call.limitCalls += 1;
        return builder;
      }),
      maybeSingle: vi.fn(() => Promise.resolve(response())),
      then: (resolve: (value: QueryResponse) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(response()).then(resolve, reject),
    };
    return builder;
  });

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    calls,
  };
}

beforeEach(() => {
  recordLeadEvent.mockReset().mockResolvedValue(undefined);
});

describe("Maria-through-Mel human SMS takeover", () => {
  it("recognizes only the server-created human rep metadata", () => {
    expect(isMariaThroughMelRepSms(mariaThroughMel)).toBe(true);
    expect(
      isMariaThroughMelRepSms({
        repSms: { ...mariaThroughMel.repSms, workflow: "other-workflow" },
      }),
    ).toBe(false);
    expect(
      isMariaThroughMelRepSms({
        repSms: { ...mariaThroughMel.repSms, actorUserId: "" },
      }),
    ).toBe(false);
    expect(isMariaThroughMelRepSms(null)).toBe(false);
  });

  it.each([null, "", "not-a-phone"])(
    "fails closed when the inbound destination number is %s",
    async (inboundToNumber) => {
      const { client, calls } = makeClient({
        messages: [
          {
            id: outboundId,
            property_id: "property-1",
            contact_id: "contact-1",
            created_at: "2026-09-17T12:00:00.000Z",
            sent_at: "2026-09-17T12:00:00.000Z",
            from_address: "+18163706846",
            status: "sent",
            metadata: mariaThroughMel,
          },
        ],
      });

      await expect(
        findRepSmsHumanTakeoverSource(client, {
          conversationId: "conversation-1",
          propertyId: "property-1",
          contactId: "contact-1",
          inboundMessageId: inboundId,
          inboundReceivedAt: "2026-09-17T12:30:00.000Z",
          inboundToNumber,
        }),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  it("selects the latest rep SMS before the inbound event and ignores later callbacks", async () => {
    const { client, calls } = makeClient({
      messages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T13:01:00.000Z",
          sent_at: "2026-09-17T13:01:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T11:00:00.000Z",
          sent_at: "not-a-date",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
    });

    const source = await findRepSmsHumanTakeoverSource(client, {
      conversationId: "conversation-1",
      propertyId: "property-1",
      contactId: "contact-1",
      inboundMessageId: inboundId,
      inboundReceivedAt: "2026-09-17T12:30:00.000Z",
      inboundToNumber: "(816) 370-6846",
    });

    expect(source).toEqual({
      outboundMessageId: outboundId,
      propertyId: "property-1",
      contactId: "contact-1",
      actorUserId: "rep-1",
      senderAssignmentId: "sender-1",
      fromNumber: "+18163706846",
      messageStatus: "sent",
      sentAt: "2026-09-17T12:00:00.000Z",
    });
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 2).map((call) => call.filters)).toEqual([
      [
        ["channel", "sms"],
        ["direction", "outbound"],
        ["conversation_id", "conversation-1"],
        ["property_id", "property-1"],
        ["contact_id", "contact-1"],
        ["sent_at", "is", null],
        ["sent_at", "2026-09-17T12:30:00.000Z"],
      ],
      [
        ["channel", "sms"],
        ["direction", "outbound"],
        ["conversation_id", "conversation-1"],
        ["property_id", "property-1"],
        ["contact_id", "contact-1"],
        ["sent_at", null],
        ["created_at", "2026-09-17T12:30:00.000Z"],
      ],
    ]);
    for (const call of calls) {
      expect(call.operation).toBe("select");
      expect(call.limitCalls).toBe(1);
    }
    expect(calls[0]?.orders).toEqual([
      ["sent_at", { ascending: false }],
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("raises lookup uncertainty instead of returning an ordinary-message result", async () => {
    const { client, calls } = makeClient({
      messageError: { message: "database unavailable" },
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: inboundId,
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).rejects.toBeInstanceOf(RepSmsHumanTakeoverLookupError);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.limitCalls === 1)).toBe(true);
  });

  it("does not reuse a rep SMS that was already followed by an inbound", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
      inboundMessages: [
        {
          id: inboundId,
          created_at: "2026-09-17T12:30:00.000Z",
          sent_at: null,
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: "55555555-5555-4555-8555-555555555555",
        inboundReceivedAt: "2026-09-17T13:00:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).resolves.toBeNull();
  });

  it("does not let an older rep SMS win after a newer ordinary outbound", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:15:00.000Z",
          sent_at: "2026-09-17T12:15:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: { generated_by: "ai_responder_v1" },
        },
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: "77777777-7777-4777-8777-777777777777",
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).resolves.toBeNull();
  });

  it("finds the older valid handoff when a newer non-dispatch row is present", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:15:00.000Z",
          sent_at: "2026-09-17T12:15:00.000Z",
          from_address: "+18163706846",
          status: "failed_not_dispatched",
          metadata: mariaThroughMel,
        },
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: inboundId,
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outboundMessageId: outboundId,
        messageStatus: "sent",
      }),
    );
  });

  it("finds a number-specific handoff when a newer outbound uses another company number", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:15:00.000Z",
          sent_at: "2026-09-17T12:15:00.000Z",
          from_address: "+18164876899",
          status: "sent",
          metadata: { generated_by: "ai_responder_v1" },
        },
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: inboundId,
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outboundMessageId: outboundId,
        fromNumber: "+18163706846",
      }),
    );
  });

  it("does not attribute a reply addressed to a different company number", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "sent",
          metadata: mariaThroughMel,
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: inboundId,
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18164876899",
      }),
    ).resolves.toBeNull();
  });

  it.each(["blocked", "blocked_no_consent", "failed_not_dispatched", "queued", "paused", "provider_failed", "delivery_failed"])(
    "excludes the locally non-dispatched %s outbound state",
    async (status) => {
      const { client } = makeClient({
        messages: [
          {
            id: outboundId,
            property_id: "property-1",
            contact_id: "contact-1",
            created_at: "2026-09-17T12:00:00.000Z",
            sent_at: "2026-09-17T12:00:00.000Z",
            from_address: "+18163706846",
            status,
            metadata: mariaThroughMel,
          },
        ],
      });

      await expect(
        findRepSmsHumanTakeoverSource(client, {
          conversationId: "conversation-1",
          propertyId: "property-1",
          contactId: "contact-1",
          inboundMessageId: inboundId,
          inboundReceivedAt: "2026-09-17T12:30:00.000Z",
          inboundToNumber: "+18163706846",
        }),
      ).resolves.toBeNull();
    },
  );

  it.each(["pending", "sending", "unknown", "provider_unknown"])(
    "retains an ambiguous %s provider outcome conservatively",
    async (status) => {
      const { client } = makeClient({
        messages: [
          {
            id: outboundId,
            property_id: "property-1",
            contact_id: "contact-1",
            created_at: "2026-09-17T12:00:00.000Z",
            sent_at: "2026-09-17T12:00:00.000Z",
            from_address: "+18163706846",
            status,
            metadata: mariaThroughMel,
          },
        ],
      });

      await expect(
        findRepSmsHumanTakeoverSource(client, {
          conversationId: "conversation-1",
          propertyId: "property-1",
          contactId: "contact-1",
          inboundMessageId: inboundId,
          inboundReceivedAt: "2026-09-17T12:30:00.000Z",
          inboundToNumber: "+18163706846",
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          outboundMessageId: outboundId,
          messageStatus: status,
        }),
      );
    },
  );

  it("retains a failed row only when its provider outcome is explicitly ambiguous", async () => {
    const { client } = makeClient({
      messages: [
        {
          id: outboundId,
          property_id: "property-1",
          contact_id: "contact-1",
          created_at: "2026-09-17T12:00:00.000Z",
          sent_at: "2026-09-17T12:00:00.000Z",
          from_address: "+18163706846",
          status: "failed",
          metadata: { ...mariaThroughMel, providerOutcome: "provider_unknown" },
        },
      ],
    });

    await expect(
      findRepSmsHumanTakeoverSource(client, {
        conversationId: "conversation-1",
        propertyId: "property-1",
        contactId: "contact-1",
        inboundMessageId: inboundId,
        inboundReceivedAt: "2026-09-17T12:30:00.000Z",
        inboundToNumber: "+18163706846",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outboundMessageId: outboundId,
        messageStatus: "failed",
      }),
    );
  });

  it("persists attention and escalated thread state with a retry-safe source identity", async () => {
    const { client, calls } = makeClient();
    await recordRepSmsHumanTakeover(client, {
      propertyId: "property-1",
      conversationId: "conversation-1",
      inboundMessageId: inboundId,
      source: {
        outboundMessageId: outboundId,
        propertyId: "property-1",
        contactId: "contact-1",
        actorUserId: "rep-1",
      senderAssignmentId: "sender-1",
      fromNumber: "+18163706846",
      messageStatus: "sent",
      sentAt: "2026-09-17T12:00:00.000Z",
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        table: "properties",
        operation: "update",
        payload: expect.objectContaining({
          needs_human_attention: true,
          last_ai_escalation_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        }),
        filters: [
          ["id", "property-1"],
          ["needs_human_attention", false],
        ],
      }),
    );
    expect(calls[1]).toEqual(
      expect.objectContaining({
        table: "message_threads",
        operation: "update",
        payload: expect.objectContaining({
          ai_responder_status: "escalated",
          ai_responder_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        }),
        filters: [
          ["conversation_id", "conversation-1"],
          ["property_id", "property-1"],
        ],
      }),
    );
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "system",
      eventType: "ai_escalated",
      sourceType: "messages.rep_sms_human_takeover",
      sourceId: inboundId,
      payload: expect.objectContaining({
        reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        sourceOutboundMessageId: outboundId,
        repActorUserId: "rep-1",
        sourceMessageStatus: "sent",
      }),
    });
  });

  it("surfaces a primary persistence failure for webhook retry", async () => {
    const { client } = makeClient({
      propertyUpdate: { data: null, error: { message: "property write failed" } },
    });

    await expect(
      recordRepSmsHumanTakeover(client, {
        propertyId: "property-1",
        conversationId: "conversation-1",
        inboundMessageId: inboundId,
        source: {
          outboundMessageId: outboundId,
          propertyId: "property-1",
          contactId: "contact-1",
          actorUserId: "rep-1",
          senderAssignmentId: "sender-1",
          fromNumber: "+18163706846",
          messageStatus: "sent",
          sentAt: "2026-09-17T12:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(RepSmsHumanTakeoverPersistenceError);
  });

  it("surfaces fallback failure instead of allowing an acknowledgement", async () => {
    const { client } = makeClient({
      propertyUpdate: { data: null, error: { message: "fallback write failed" } },
    });

    await expect(
      persistRepSmsHumanTakeoverFallback(client, "property-1"),
    ).rejects.toMatchObject({
      name: "RepSmsHumanTakeoverPersistenceError",
    });
  });

  it("confirms the strict fallback write when the property is available", async () => {
    const { client, calls } = makeClient();

    await expect(
      persistRepSmsHumanTakeoverFallback(client, "property-1"),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        table: "properties",
        operation: "update",
        payload: expect.objectContaining({
          needs_human_attention: true,
          last_ai_escalation_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        }),
      }),
    );
  });
});
