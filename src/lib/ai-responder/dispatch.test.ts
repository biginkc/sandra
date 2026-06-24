import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConsentState } from "@/lib/messaging/consent";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { sendSmsToContact } from "@/lib/messaging/send";

import { classifyAiSkip } from "./classify";
import { dispatchAiResponse } from "./dispatch";
import { generateAiReply } from "./generate";
import { humanizeReply } from "./humanize";
import { IDENTITY_REPLY_BODY } from "./identity";
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

vi.mock("@/lib/messaging/opt-out-phone", () => ({
  applyPhoneLevelOptOut: vi.fn(),
}));

vi.mock("@/lib/sequences/enrollment", () => ({
  pauseContactEnrollments: vi.fn(),
  pausePropertyEnrollments: vi.fn(),
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

type AiClaimRow = {
  id: string;
  inbound_message_id: string;
  lease_expires_at: string;
  response_kind: string;
  status: string;
};

type MockState = {
  aiClaims: AiClaimRow[];
  contact: {
    first_name: string | null;
    phone_1: string | null;
    phone_1_type: string | null;
    phone_2: string | null;
    phone_2_type: string | null;
    phone_3: string | null;
    phone_3_type: string | null;
  };
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
  nextClaimId: number;
  property: {
    ai_responder_disabled: boolean;
    id: string;
    homeowner_contact_id: string;
    needs_human_attention: boolean;
    org_id: string;
    outreach_dispo: string | null;
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
    aiClaims: [],
    contact: {
      first_name: "Sam",
      phone_1: "+18165550001",
      phone_1_type: "mobile",
      phone_2: null,
      phone_2_type: null,
      phone_3: null,
      phone_3_type: null,
    },
    messages: [],
    nextClaimId: 1,
    nextMessageId: 1,
    property: {
      ai_responder_disabled: false,
      homeowner_contact_id: CONTACT_ID,
      id: PROPERTY_ID,
      needs_human_attention: false,
      org_id: "org-1",
      outreach_dispo: null,
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
    const eqFilters = new Map<string, unknown>();
    let allowedDispos: string[] | null = null;
    let allowsNullDispo = false;

    const matchesCurrentProperty = () => {
      for (const [field, value] of eqFilters) {
        if (state.property[field as keyof MockState["property"]] !== value) {
          return false;
        }
      }
      if (allowedDispos) {
        const current = state.property.outreach_dispo;
        if (current === null) return allowsNullDispo;
        return allowedDispos.includes(current);
      }
      return true;
    };

    const execute = () => {
      if (updateData) {
        if (!matchesCurrentProperty()) {
          return { data: null, error: null };
        }
        Object.assign(state.property, updateData);
        return { data: { id: state.property.id }, error: null };
      }
      return { data: state.property, error: null };
    };

    const query = {
      eq(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      maybeSingle() {
        return Promise.resolve(execute());
      },
      or(filter: string) {
        allowsNullDispo = filter.includes("outreach_dispo.is.null");
        const match = filter.match(/outreach_dispo\.in\.\(([^)]*)\)/);
        allowedDispos = match?.[1]
          ? match[1].split(",").filter(Boolean)
          : null;
        return query;
      },
      update(value: Partial<MockState["property"]>) {
        updateData = value;
        return query;
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: ReturnType<typeof execute>) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
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

  function buildContactsQuery() {
    const query = {
      eq() {
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: state.contact,
          error: null,
        });
      },
      select() {
        return query;
      },
    };

    return query;
  }

  function buildAiClaimsQuery() {
    const eqFilters = new Map<string, unknown>();
    let insertData: Partial<AiClaimRow> | null = null;
    let updateData: Partial<AiClaimRow> | null = null;

    const matches = (row: AiClaimRow) => {
      for (const [field, value] of eqFilters) {
        if (row[field as keyof AiClaimRow] !== value) return false;
      }
      return true;
    };

    const execute = () => {
      if (insertData) {
        if (
          state.aiClaims.some(
            (row) =>
              row.inbound_message_id === insertData!.inbound_message_id &&
              row.response_kind === insertData!.response_kind,
          )
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint",
            },
          };
        }
        const row: AiClaimRow = {
          id: `claim-${state.nextClaimId++}`,
          inbound_message_id: String(insertData.inbound_message_id),
          lease_expires_at: String(insertData.lease_expires_at),
          response_kind: String(insertData.response_kind),
          status: String(insertData.status),
        };
        state.aiClaims.push(row);
        return { data: row, error: null };
      }

      if (updateData) {
        const row = state.aiClaims.find(matches);
        if (!row) return { data: null, error: null };
        Object.assign(row, updateData);
        return { data: row, error: null };
      }

      return {
        data: state.aiClaims.find(matches) ?? null,
        error: null,
      };
    };

    const query = {
      eq(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      insert(value: Partial<AiClaimRow>) {
        insertData = value;
        return query;
      },
      maybeSingle() {
        return Promise.resolve(execute());
      },
      select() {
        return query;
      },
      single() {
        return Promise.resolve(execute());
      },
      update(value: Partial<AiClaimRow>) {
        updateData = value;
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
      if (table === "contacts") {
        return buildContactsQuery();
      }
      if (table === "ai_response_claims") {
        return buildAiClaimsQuery();
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
    vi.mocked(applyPhoneLevelOptOut).mockResolvedValue(undefined);
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

  it("allows only one concurrent handler to claim the same inbound before sending", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const [first, second] = await Promise.all([
      dispatchAiResponse(
        supabase as never,
        {
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          inboundBody: "Still interested?",
          inboundMessageId: "inbound-race",
          propertyId: PROPERTY_ID,
        },
        { anthropic: {} as never },
      ),
      dispatchAiResponse(
        supabase as never,
        {
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          inboundBody: "Still interested?",
          inboundMessageId: "inbound-race",
          propertyId: PROPERTY_ID,
        },
        { anthropic: {} as never },
      ),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(["sent", "skipped"]);
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
  });

  it("answers identity questions with the fixed Mel with BMH copy without calling Claude", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Who is this?",
        inboundMessageId: "inbound-identity",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "sent",
      messageId: "sent-1",
      confidence: 1,
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(humanizeReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        body: IDENTITY_REPLY_BODY,
      }),
    );
    expect(state.messages[0].metadata).toMatchObject({
      generated_by: "ai_responder_v1",
      inbound_message_id: "inbound-identity",
      confidence: 1,
      sentiment: "neutral",
      turn: 1,
    });
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

  it("skips before generation when the property is already human-claimed", async () => {
    const state = createMockState();
    state.property.needs_human_attention = true;
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-claimed",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("skips before generation when the property already has a terminal disposition", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "dnc";
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "hello?",
        inboundMessageId: "inbound-terminal",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("low-confidence terminal model actions still close without sending", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_wrong_number",
      wrong_scope: "this_property",
      confidence: 0.4,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "maybe wrong house",
        inboundMessageId: "inbound-low-confidence",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:wrong_number",
    });
    expect(state.property.outreach_dispo).toBe("wrong_number");
    expect(state.property.needs_human_attention).toBe(false);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("low-confidence opt_out still suppresses the phone and marks the property opted out", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "opt_out",
      confidence: 0.4,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "please delete my number",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-low-confidence-opt-out",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "opted_out",
      reason: "model:opt_out",
    });
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        contactId: CONTACT_ID,
        fromPhone: "+18165550001",
        source: "ai_responder",
        surface: "stop",
      }),
    );
    expect(state.property.outreach_dispo).toBe("opted_out");
    expect(state.property.needs_human_attention).toBe(false);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("close_dnc writes a suppressed DNC disposition and does not send", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_dnc",
      confidence: 0.9,
      sentiment: "hostile",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "I will find you and make you pay",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-threat",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:threat_dnc",
    });
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        contactId: CONTACT_ID,
        fromPhone: "+18165550001",
        source: "ai_responder_threat",
        surface: "dnc",
      }),
    );
    expect(state.property.outreach_dispo).toBe("dnc");
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("deescalate_close sends the fixed named template without humanizer", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "deescalate_close",
      body: "model draft should be ignored",
      confidence: 0.9,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "ugh is this a scam",
        inboundMessageId: "inbound-deescalate",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:deescalate_close",
    });
    expect(vi.mocked(humanizeReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        body: "So sorry to bug you. Sounds like you get a lot of these. Are you Sam? Just want to make sure we don't bother you again.",
      }),
    );
    expect(state.property.outreach_dispo).toBe("not_interested");
  });

  it("does not clobber a human-only disposition during the final write", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockImplementationOnce(async () => {
      state.property.outreach_dispo = "nurture";
      return {
        action: "close_not_interested",
        confidence: 0.9,
        sentiment: "neutral",
      };
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "not now",
        inboundMessageId: "inbound-human-owned",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({ outcome: "skipped", reason: "already_terminal" });
    expect(state.property.outreach_dispo).toBe("nurture");
  });
});
