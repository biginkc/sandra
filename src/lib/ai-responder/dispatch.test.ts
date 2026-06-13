import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";

import { classifyAiSkip } from "./classify";
import { dispatchAiResponse } from "./dispatch";
import { generateAiReply } from "./generate";
import { humanizeReply } from "./humanize";
import { validateAiReplyBody } from "./safety";
import type { AiStructuredOutput } from "./types";

vi.mock("@/lib/messaging/consent", () => ({
  getConsentState: vi.fn(),
}));

vi.mock("@/lib/messaging/quiet-hours", () => ({
  checkQuietHours: vi.fn(() => ({ ok: true })),
}));

vi.mock("@/lib/messaging/send", () => ({
  sendSmsToContact: vi.fn(),
}));

vi.mock("./classify", () => ({
  classifyAiSkip: vi.fn(),
}));

vi.mock("./generate", () => ({
  classifyProviderFailure: vi.fn(() => null),
  generateAiReply: vi.fn(),
}));

vi.mock("./humanize", () => ({
  humanizeReply: vi.fn(),
}));

vi.mock("./safety", () => ({
  validateAiReplyBody: vi.fn(),
}));

type MessageRow = {
  id: string;
  body: string | null;
  channel: string;
  contact_id: string;
  conversation_id: string | null;
  created_at: string;
  direction: "inbound" | "outbound";
  metadata: Record<string, unknown> | null;
  property_id: string;
  sent_at: string | null;
  status: string;
};

type MockState = {
  config: {
    active: boolean;
    business_hours_only: boolean;
    escalation_keywords: string[];
    id: string;
    max_turns: number;
    min_confidence: number;
    model: string;
    system_prompt: string;
  };
  messages: MessageRow[];
  nextMessageId: number;
  property: {
    ai_responder_disabled: boolean;
    id: string;
    org_id: string;
    state: string;
  };
  threadConversationId: string;
};

const PROPERTY_ID = "property-1";
const CONTACT_ID = "contact-1";
const CONVERSATION_ID = "conversation-1";

const HAPPY_REPLY: AiStructuredOutput = {
  action: "send_reply",
  body: "Hi there",
  confidence: 0.91,
  sentiment: "neutral",
};

function createMockState(): MockState {
  return {
    config: {
      active: true,
      business_hours_only: false,
      escalation_keywords: [],
      id: "config-1",
      max_turns: 10,
      min_confidence: 0.7,
      model: "claude-test",
      system_prompt: "Reply briefly.",
    },
    messages: [],
    nextMessageId: 1,
    property: {
      ai_responder_disabled: false,
      id: PROPERTY_ID,
      org_id: "org-1",
      state: "MO",
    },
    threadConversationId: CONVERSATION_ID,
  };
}

function createMockSupabase(state: MockState) {
  function matchesMessage(
    row: MessageRow,
    filters: {
      contains: Map<string, Record<string, unknown>>;
      eq: Map<string, unknown>;
      in: Map<string, unknown[]>;
    },
  ): boolean {
    for (const [field, value] of filters.eq) {
      if (row[field as keyof MessageRow] !== value) {
        return false;
      }
    }

    for (const [field, values] of filters.in) {
      const cell = row[field as keyof MessageRow];
      if (!values.includes(cell)) {
        return false;
      }
    }

    for (const [field, value] of filters.contains) {
      const cell = row[field as keyof MessageRow];
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
        return false;
      }
      const record = cell as Record<string, unknown>;
      if (Object.entries(value).some(([key, expected]) => record[key] !== expected)) {
        return false;
      }
    }

    return true;
  }

  function buildMessagesQuery() {
    const filters = {
      contains: new Map<string, Record<string, unknown>>(),
      eq: new Map<string, unknown>(),
      in: new Map<string, unknown[]>(),
    };
    let limitCount: number | null = null;
    let orderBy: { ascending: boolean; field: keyof MessageRow } | null = null;
    let selectOptions: { count?: string; head?: boolean } | undefined;
    let updateData: Partial<MessageRow> | null = null;

    const execute = () => {
      if (updateData) {
        for (const row of state.messages) {
          if (matchesMessage(row, filters)) {
            Object.assign(row, updateData);
          }
        }
        return { data: null, error: null };
      }

      let rows = state.messages.filter((row) => matchesMessage(row, filters));
      if (orderBy) {
        const { ascending, field } = orderBy;
        rows = rows
          .slice()
          .sort((left, right) => {
            const leftValue = String(left[field] ?? "");
            const rightValue = String(right[field] ?? "");
            return ascending
              ? leftValue < rightValue
                ? -1
                : leftValue > rightValue
                  ? 1
                  : 0
              : leftValue > rightValue
                ? -1
                : leftValue < rightValue
                  ? 1
                  : 0;
          });
      }
      if (typeof limitCount === "number") {
        rows = rows.slice(0, limitCount);
      }

      if (selectOptions?.head && selectOptions.count === "exact") {
        return { count: rows.length, data: null, error: null };
      }

      return { data: rows, error: null };
    };

    const query = {
      contains(field: string, value: Record<string, unknown>) {
        filters.contains.set(field, value);
        return query;
      },
      eq(field: string, value: unknown) {
        filters.eq.set(field, value);
        return query;
      },
      in(field: string, values: unknown[]) {
        filters.in.set(field, values);
        return query;
      },
      limit(value: number) {
        limitCount = value;
        return query;
      },
      maybeSingle() {
        const result = execute();
        return Promise.resolve({
          data: Array.isArray(result.data) ? (result.data[0] ?? null) : null,
          error: result.error,
        });
      },
      order(field: keyof MessageRow, options?: { ascending?: boolean }) {
        orderBy = { ascending: options?.ascending ?? true, field };
        return query;
      },
      select(_fields: string, options?: { count?: string; head?: boolean }) {
        selectOptions = options;
        return query;
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: { count?: number | null; data: MessageRow[] | null; error: null }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
      update(value: Partial<MessageRow>) {
        updateData = value;
        return query;
      },
    };

    return query;
  }

  function buildPropertiesQuery() {
    let updateData: Partial<MockState["property"]> | null = null;
    const query = {
      eq() {
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: state.property,
          error: null,
        });
      },
      update(value: Partial<MockState["property"]>) {
        updateData = value;
        return query;
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: { data: MockState["property"] | null; error: null }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        if (updateData) {
          Object.assign(state.property, updateData);
        }
        return Promise.resolve({ data: state.property, error: null }).then(
          onfulfilled,
          onrejected,
        );
      },
      select() {
        return query;
      },
    };

    return query;
  }

  function buildConfigQuery() {
    const query = {
      eq() {
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: state.config,
          error: null,
        });
      },
      select() {
        return query;
      },
    };

    return query;
  }

  return {
    from(table: string) {
      if (table === "messages") {
        return buildMessagesQuery();
      }
      if (table === "properties") {
        return buildPropertiesQuery();
      }
      if (table === "ai_responder_configs") {
        return buildConfigQuery();
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function installSendMock(state: MockState) {
  vi.mocked(sendSmsToContact).mockImplementation(async (_supabase, input) => {
    const messageId = `sent-${state.nextMessageId++}`;
    const timestamp = new Date().toISOString();
    state.messages.push({
      id: messageId,
      body: input.body,
      channel: "sms",
      contact_id: input.contactId,
      conversation_id: state.threadConversationId,
      created_at: timestamp,
      direction: "outbound",
      metadata:
        input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : null,
      property_id: input.propertyId,
      sent_at: timestamp,
      status: "sent",
    });
    return {
      externalId: `ext-${messageId}`,
      messageId,
      status: "sent",
    } as const;
  });
}

describe("dispatchAiResponse debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));

    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sends once, then skips a second inbound in the same conversation within 45 seconds", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const first = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-1",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    const second = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-2",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(first.outcome).toBe("sent");
    expect(second).toEqual({
      outcome: "skipped",
      reason: "duplicate_throttled",
    });
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
  });

  it("allows a second inbound after the 45-second window expires", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const first = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Checking in",
        inboundMessageId: "inbound-1",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    vi.advanceTimersByTime(46_000);

    const second = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Checking in",
        inboundMessageId: "inbound-2",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(first.outcome).toBe("sent");
    expect(second.outcome).toBe("sent");
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(2);
  });
});
