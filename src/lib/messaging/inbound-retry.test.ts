import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearThread: vi.fn(async () => undefined),
  markInserted: vi.fn(async () => undefined),
  markComplete: vi.fn(async () => undefined),
  claimIntent: vi.fn(),
  serviceClient: null as unknown,
  resolveThread: vi.fn(),
  attributedMessage: vi.fn(),
  dispatchOwner: vi.fn(async () => undefined),
  dispatchOwnerTriage: vi.fn(async () => undefined),
  listAdmins: vi.fn(async () => []),
  loadDelayConfig: vi.fn(async () => null),
  dispatchAi: vi.fn(async () => ({
    outcome: "skipped" as const,
    reason: "no_config",
  })),
  startWorkflow: vi.fn(async () => ({ runId: "run-1" })),
  readState: vi.fn(() => ({})),
  markState: vi.fn(async () => undefined),
  findTakeover: vi.fn(async () => null),
  recordTakeover: vi.fn(async () => undefined),
  persistTakeover: vi.fn(async () => undefined),
  markAttention: vi.fn(async () => undefined),
  recordThread: vi.fn(async () => undefined),
}));

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>(
    "@supabase/supabase-js",
  );
  return { ...actual, createClient: vi.fn(() => mocks.serviceClient) };
});

vi.mock("@/lib/messages/ai-responder-thread-state", () => ({
  clearAiResponderThreadState: mocks.clearThread,
  recordAiResponderOutcomeForThread: mocks.recordThread,
}));

vi.mock("@/lib/messaging/inbound-intents", () => ({
  claimInboundSmsIntent: mocks.claimIntent,
  markInboundSmsIntentMessageInserted: mocks.markInserted,
  markInboundSmsIntentSideEffectsComplete: mocks.markComplete,
}));

vi.mock("@/lib/messages/threading", () => ({
  resolveInboundThread: mocks.resolveThread,
}));

vi.mock("@/lib/messages/attribution", () => ({
  findAttributedOutboundMessageId: mocks.attributedMessage,
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchOwnerMessageAdded: mocks.dispatchOwner,
  dispatchOwnerMessageAddedNeedsTriage: mocks.dispatchOwnerTriage,
}));

vi.mock("@/lib/auth/admins", () => ({ listAdminUserIds: mocks.listAdmins }));

vi.mock("@/lib/ai-responder/delay", () => ({
  computeReplyDelaySeconds: vi.fn(() => 0),
  loadAiReplyDelayConfig: mocks.loadDelayConfig,
}));

vi.mock("@/lib/ai-responder/dispatch", () => ({
  applyKeywordEscalation: vi.fn(async () => ({ escalated: false })),
  checkAiResponderDispatchPreGates: vi.fn(async () => ({ ok: true })),
  dispatchAiResponse: mocks.dispatchAi,
  markPropertyNeedsAttention: mocks.markAttention,
}));

vi.mock("@/lib/messaging/inbound-state", () => ({
  markInboundMessageState: mocks.markState,
  readInboundMessageState: mocks.readState,
}));

vi.mock("@/lib/sequences/enrollment", () => ({
  pausePropertyEnrollments: vi.fn(async () => undefined),
  promotePropertyEnrollmentPauseReason: vi.fn(async () => undefined),
}));

vi.mock("@/lib/messaging/rep-sms-human-takeover", () => ({
  REP_SMS_HUMAN_TAKEOVER_REASON: "rep_sms_human_takeover",
  findRepSmsHumanTakeoverSource: mocks.findTakeover,
  persistRepSmsHumanTakeoverFallback: mocks.persistTakeover,
  recordRepSmsHumanTakeover: mocks.recordTakeover,
}));

vi.mock("workflow/api", () => ({ start: mocks.startWorkflow }));

import { handleInboundWebhook, insertInboundMessage } from "./inbound";

const INPUT = {
  providerId: "sendillo",
  externalId: "provider-message-1",
  from: "+18165550100",
  to: "+18165550199",
  body: "I would like to talk about the house",
  contactId: "contact-1",
  propertyId: "property-1",
  conversationId: "conversation-1",
  inboundIntentId: "intent-1",
  attributedOutboundMessageId: null,
  metadata: { source: "test" } as const,
};

const INSERTED = {
  id: "message-1",
  metadata: INPUT.metadata,
  contact_id: INPUT.contactId,
  property_id: INPUT.propertyId,
  conversation_id: INPUT.conversationId,
};

type DbResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

function query<T>(result: T) {
  const builder: Record<string, unknown> = {
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    select: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    then: (
      resolve: (value: T) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function messagesClient(
  insertResults: DbResult[],
  lookupResults: DbResult[] = [{ data: [], error: null }],
) {
  let lookupIndex = 0;
  const insert = vi.fn((_: unknown) =>
    query(insertResults.shift() ?? { data: null, error: null }),
  );
  const lookup = () =>
    query(lookupResults[lookupIndex++] ?? { data: null, error: null });
  const messages = {
    select: vi.fn(() => lookup()),
    insert,
  };
  return {
    client: { from: vi.fn((_table?: string) => messages) },
    insert,
  };
}

function handlerClient(insertResults: DbResult[]) {
  const baseMessages = messagesClient(insertResults);
  const from = vi.fn((table: string) => {
    if (table === "messages") return baseMessages.client.from("messages");
    if (table === "webhook_events") {
      return {
        insert: vi.fn(() => query({ data: { id: "event-1" }, error: null })),
        update: vi.fn(() => query({ data: [{ id: "event-1" }], error: null })),
      };
    }
    if (table === "properties") {
      return {
        select: vi.fn((columns: string) =>
          query(
            columns === "org_id"
              ? { data: { org_id: "org-1" }, error: null }
              : columns === "status"
                ? { data: { status: "new_lead" }, error: null }
                : {
                    data: {
                      assigned_user_id: null,
                      address: "test inbound",
                      city: null,
                      state: "MO",
                    },
                    error: null,
                  },
          ),
        ),
      };
    }
    return { select: vi.fn(() => query({ data: [], error: null })) };
  });
  return { client: { from }, insert: baseMessages.insert };
}

function provider() {
  return {
    providerId: "sendillo",
    verifyWebhookSignature: () => true,
    parseInboundWebhook: () => [
      {
        externalId: INPUT.externalId,
        from: INPUT.from,
        to: INPUT.to,
        body: INPUT.body,
        receivedAt: new Date("2026-10-02T14:00:00.000Z"),
        raw: { external_id: INPUT.externalId },
      },
    ],
    sendSms: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimIntent.mockResolvedValue({
    duplicate: false,
    intentId: INPUT.inboundIntentId,
    mode: "off",
  });
  mocks.resolveThread.mockResolvedValue({
    contactId: INPUT.contactId,
    propertyId: INPUT.propertyId,
    conversationId: INPUT.conversationId,
    resolution: "contact_property",
  });
  mocks.attributedMessage.mockResolvedValue(null);
});

describe("insertInboundMessage 40P01 boundary", () => {
  it("retries one deadlock with the same payload and runs downstream effects once", async () => {
    const { client, insert } = messagesClient([
      { data: null, error: { code: "40P01", message: "deadlock" } },
      { data: INSERTED, error: null },
    ]);

    const result = await insertInboundMessage(client as never, INPUT);

    expect(result).toMatchObject({ duplicate: false, messageId: INSERTED.id });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0]?.[0]).toEqual(insert.mock.calls[1]?.[0]);
    expect(mocks.clearThread).toHaveBeenCalledTimes(1);
    expect(mocks.markInserted).toHaveBeenCalledTimes(1);
  });

  it("stops after the second 40P01 and does not run downstream effects", async () => {
    const { client, insert } = messagesClient([
      { data: null, error: { code: "40P01", message: "deadlock 1" } },
      { data: null, error: { code: "40P01", message: "deadlock 2" } },
    ]);

    const result = await insertInboundMessage(client as never, INPUT);

    expect(result.error).toMatchObject({ code: "40P01" });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(mocks.clearThread).not.toHaveBeenCalled();
    expect(mocks.markInserted).not.toHaveBeenCalled();
  });

  it.each(["40001", "55P03", "57014"])(
    "does not retry non-deadlock SQLSTATE %s",
    async (code) => {
      const { client, insert } = messagesClient([
        { data: null, error: { code, message: `error ${code}` } },
      ]);

      const result = await insertInboundMessage(client as never, INPUT);

      expect(result.error).toMatchObject({ code });
      expect(insert).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps 23505 on the existing dedupe branch without retrying", async () => {
    const duplicate = { ...INSERTED, id: "existing-message" };
    const { client, insert } = messagesClient(
      [{ data: null, error: { code: "23505", message: "duplicate" } }],
      [
        { data: [], error: null },
        { data: duplicate, error: null },
      ],
    );

    const result = await insertInboundMessage(client as never, INPUT);

    expect(result).toMatchObject({
      duplicate: true,
      error: null,
      messageId: duplicate.id,
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(mocks.clearThread).not.toHaveBeenCalled();
    expect(mocks.markInserted).not.toHaveBeenCalled();
  });
});

describe("handleInboundWebhook retry boundary", () => {
  it("claims the intent and dispatches downstream work once after an insert retry", async () => {
    const handler = handlerClient([
      { data: null, error: { code: "40P01", message: "deadlock" } },
      { data: INSERTED, error: null },
    ]);
    mocks.serviceClient = handler.client;
    process.env.TEST_SUPABASE_URL = "http://example.test";
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    const response = await handleInboundWebhook(
      new Request("https://example.test/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: { host: "example.test" },
        body: "{}",
      }),
      { includeFullUrl: true, provider: provider() as never },
    );

    expect(response.status).toBe(200);
    expect(mocks.claimIntent).toHaveBeenCalledTimes(1);
    expect(handler.insert).toHaveBeenCalledTimes(2);
    expect(mocks.clearThread).toHaveBeenCalledTimes(1);
    expect(mocks.markInserted).toHaveBeenCalledTimes(1);
    expect(mocks.markComplete).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchOwner).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchAi).toHaveBeenCalledTimes(1);
  });
});

describe("handleInboundWebhook retry outcome (immediate dispatch)", () => {
  async function runWebhook() {
    const handler = handlerClient([{ data: INSERTED, error: null }]);
    mocks.serviceClient = handler.client;
    process.env.TEST_SUPABASE_URL = "http://example.test";
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    return handleInboundWebhook(
      new Request("https://example.test/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: { host: "example.test" },
        body: "{}",
      }),
      { includeFullUrl: true, provider: provider() as never },
    );
  }
  const retryOutcome = {
    outcome: "retry" as const,
    reason: "send_reserved_elsewhere" as const,
    attempt: 1,
    delaySeconds: 20,
  };

  it("re-schedules the same inbound through the delay workflow and does NOT stamp a terminal outcome", async () => {
    mocks.dispatchAi.mockResolvedValueOnce(retryOutcome as never);
    const response = await runWebhook();
    expect(response.status).toBe(200);
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    const [, [args]] = mocks.startWorkflow.mock.calls[0] as unknown as [unknown, [Record<string, unknown>]];
    expect(args).toMatchObject({
      inboundMessageId: "message-1",
      propertyId: "property-1",
      delaySeconds: 20,
      retryAttempt: 1,
    });
    // Inbound is stamped `delayed` (so a webhook redelivery does not race the
    // retry), never with the retry outcome or a terminal state.
    expect(mocks.markState).toHaveBeenCalledWith(
      expect.anything(),
      "message-1",
      { aiResponder: expect.objectContaining({ outcome: "delayed", retryAttempt: 1, retryReason: "send_reserved_elsewhere" }) },
    );
    expect(mocks.recordThread).not.toHaveBeenCalled();
    expect(mocks.markAttention).not.toHaveBeenCalled();
  });

  it("when the retry cannot be scheduled, the property is flagged reply_skipped:<reason> and a terminal escalation is stamped", async () => {
    mocks.dispatchAi.mockResolvedValueOnce(retryOutcome as never);
    mocks.startWorkflow.mockRejectedValueOnce(new Error("queue down"));
    await runWebhook();
    expect(mocks.markAttention).toHaveBeenCalledWith(
      expect.anything(),
      "property-1",
      "reply_skipped:send_reserved_elsewhere",
    );
    expect(mocks.markState).toHaveBeenCalledWith(
      expect.anything(),
      "message-1",
      { aiResponder: expect.objectContaining({ outcome: "escalated", reason: "send_reserved_elsewhere" }) },
    );
  });

  it("a webhook redelivery of an inbound already stamped delayed does not dispatch again", async () => {
    mocks.readState.mockReturnValueOnce({ aiResponder: { outcome: "delayed", delaySeconds: 20, scheduledAt: "x" } } as never);
    // First delivery's insert is a duplicate on redelivery; the stamp check is
    // what keeps the retry from being short-circuited AND from being doubled.
    await runWebhook();
    expect(mocks.dispatchAi).not.toHaveBeenCalled();
  });
});
