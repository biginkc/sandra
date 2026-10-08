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
  loadDelayConfig: vi.fn(async () => null as unknown),
  computeDelay: vi.fn(() => 0),
  preGates: vi.fn(async () => ({ ok: true }) as unknown),
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
  markAttention: vi.fn(async () => true),
  recordThread: vi.fn(async () => undefined),
  deadLetter: vi.fn(async () => true),
  flagAndDeadLetter: vi.fn(async () => ({ deadLettered: true, flagReason: "x" })),
  optOut: vi.fn(async () => undefined),
}));

vi.mock("@/lib/messaging/opt-out-phone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/opt-out-phone")>()),
  applyPhoneLevelOptOut: mocks.optOut,
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

vi.mock("@/lib/ai-responder/retry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-responder/retry")>()),
  writeReplyDeadLetter: mocks.deadLetter,
}));

vi.mock("@/lib/ai-responder/delay", () => ({
  computeReplyDelaySeconds: mocks.computeDelay,
  loadAiReplyDelayConfig: mocks.loadDelayConfig,
}));

vi.mock("@/lib/ai-responder/dispatch", () => ({
  applyKeywordEscalation: vi.fn(async () => ({ escalated: false })),
  checkAiResponderDispatchPreGates: mocks.preGates,
  // Mirrors the real helper: a silent exit stamps `skipped:rule_<n>`.
  inboundStampOutcomeOf: (o: { outcome: string; reason?: string }) =>
    o.outcome === "skipped" && o.reason === "already_answered" ? "skipped:rule_2" : o.outcome,
  dispatchAiResponse: mocks.dispatchAi,
  flagAndDeadLetter: mocks.flagAndDeadLetter,
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
    reply: {
      body: "Hi there, still interested?",
      confidence: 0.91,
      sentiment: "neutral" as const,
      orgId: "org-1",
      kind: "send_reply" as const,
    },
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
      // The generated reply rides in the durable workflow params so the retry
      // re-sends it verbatim (no re-classification, no re-generation).
      retryReply: expect.objectContaining({ body: "Hi there, still interested?", orgId: "org-1" }),
    });
    expect(mocks.deadLetter).not.toHaveBeenCalled();
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

  it("when the retry cannot be scheduled, the generated reply is dead-lettered, the property is flagged reply_skipped:<reason> and a terminal escalation is stamped", async () => {
    mocks.dispatchAi.mockResolvedValueOnce(retryOutcome as never);
    mocks.startWorkflow.mockRejectedValueOnce(new Error("queue down"));
    await runWebhook();
    // Q8 rule 7: ONE helper dead-letters the carried reply and flags (and
    // switches the flag to dead_letter_failed:<reason> when the write fails).
    expect(mocks.flagAndDeadLetter).toHaveBeenCalledTimes(1);
    expect((mocks.flagAndDeadLetter.mock.calls[0] as unknown[])[1]).toMatchObject({
      orgId: "org-1",
      propertyId: "property-1",
      inboundMessageId: "message-1",
      body: "Hi there, still interested?",
      reason: "send_reserved_elsewhere",
      flagReason: "reply_skipped:send_reserved_elsewhere",
    });
    expect(mocks.markState).toHaveBeenCalledWith(
      expect.anything(),
      "message-1",
      { aiResponder: expect.objectContaining({ outcome: "escalated", reason: "send_reserved_elsewhere" }) },
    );
  });

  it("an immediate silent exit stamps skipped:rule_<n> (not bare skipped), and a redelivery then skips dispatch", async () => {
    mocks.dispatchAi.mockResolvedValueOnce({ outcome: "skipped", reason: "already_answered" } as never);
    await runWebhook();
    const stampCall = mocks.markState.mock.calls.find(
      (c) => (c as unknown[])[2] && "aiResponder" in ((c as unknown[])[2] as object),
    ) as unknown[] | undefined;
    const stamp = (stampCall?.[2] as { aiResponder: { outcome: string } }).aiResponder;
    expect(stamp.outcome).toBe("skipped:rule_2");

    mocks.dispatchAi.mockClear();
    mocks.readState.mockReturnValueOnce({ aiResponder: stamp } as never);
    await runWebhook();
    expect(mocks.dispatchAi).not.toHaveBeenCalled();
  });

  it("the delayed pre-gate terminal stamp also keeps skipped:rule_<n> (never bare skipped)", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce({
      delayMinSeconds: 10,
      delayMaxSeconds: 20,
      propertyState: null,
      escalationKeywords: [],
    });
    mocks.computeDelay.mockReturnValueOnce(15);
    mocks.preGates.mockResolvedValueOnce({
      ok: false,
      outcome: { outcome: "skipped", reason: "already_answered" },
    });
    await runWebhook();
    expect(mocks.dispatchAi).not.toHaveBeenCalled();
    expect(mocks.markState).toHaveBeenCalledWith(
      expect.anything(),
      "message-1",
      { aiResponder: expect.objectContaining({ outcome: "skipped:rule_2", reason: "already_answered" }) },
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

describe("handleInboundWebhook reply delay vs. approved-template replies", () => {
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
  const delayConfig = (max: number) => ({
    delayMinSeconds: 0,
    delayMaxSeconds: max,
    propertyState: null,
    escalationKeywords: [],
  });

  it("never dispatches (and so never sends a template) inside the webhook when reply_delay_max_seconds > 0, even if the computed delay is 0", async () => {
    // computeReplyDelaySeconds legitimately returns 0 (no property state,
    // quiet-hours clamp, low random draw). The reply must still go through the
    // delay workflow, where the dispatch step runs, never from the request.
    mocks.loadDelayConfig.mockResolvedValueOnce(delayConfig(45));
    mocks.computeDelay.mockReturnValueOnce(0);
    mocks.preGates.mockResolvedValueOnce({ ok: true });
    const response = await runWebhook();
    expect(response.status).toBe(200);
    expect(mocks.dispatchAi).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    const [, [args]] = mocks.startWorkflow.mock.calls[0] as unknown as [unknown, [Record<string, unknown>]];
    expect(args).toMatchObject({ inboundMessageId: "message-1", delaySeconds: 0 });
  });

  it("a non-zero computed delay is scheduled on the workflow with that delay and no webhook dispatch", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce(delayConfig(45));
    mocks.computeDelay.mockReturnValueOnce(31);
    mocks.preGates.mockResolvedValueOnce({ ok: true });
    await runWebhook();
    expect(mocks.dispatchAi).not.toHaveBeenCalled();
    const [, [args]] = mocks.startWorkflow.mock.calls[0] as unknown as [unknown, [Record<string, unknown>]];
    expect(args).toMatchObject({ delaySeconds: 31 });
  });

  it("only an org with no reply delay (max = 0) dispatches synchronously", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce(delayConfig(0));
    mocks.computeDelay.mockReturnValueOnce(0);
    mocks.dispatchAi.mockResolvedValueOnce({ outcome: "skipped", reason: "already_answered" } as never);
    await runWebhook();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(mocks.dispatchAi).toHaveBeenCalledTimes(1);
  });

  it("when the delay workflow cannot start, the inline fallback dispatches with replyDelayBypassed so no template goes out instantly", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce(delayConfig(45));
    mocks.computeDelay.mockReturnValueOnce(20);
    mocks.preGates.mockResolvedValueOnce({ ok: true });
    mocks.startWorkflow.mockRejectedValueOnce(new Error("queue down"));
    mocks.dispatchAi.mockResolvedValueOnce({ outcome: "skipped", reason: "already_answered" } as never);
    await runWebhook();
    expect(mocks.dispatchAi).toHaveBeenCalledTimes(1);
    expect((mocks.dispatchAi.mock.calls[0] as unknown[])[1]).toMatchObject({ replyDelayBypassed: true });
  });

  it("an inline dispatch for an org with no reply delay (max = 0) is marked delay_not_configured so templates are dropped", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce(delayConfig(0));
    mocks.computeDelay.mockReturnValueOnce(0);
    mocks.dispatchAi.mockResolvedValueOnce({ outcome: "skipped", reason: "already_answered" } as never);
    await runWebhook();
    expect((mocks.dispatchAi.mock.calls[0] as unknown[])[1]).toMatchObject({
      replyDelayBypassed: true,
      replyDelayBypassReason: "delay_not_configured",
    });
  });

  it("a failed delay-config lookup (null) dispatches inline but marked bypassed, so no template goes out instantly", async () => {
    mocks.loadDelayConfig.mockResolvedValueOnce(null);
    mocks.computeDelay.mockReturnValueOnce(0);
    mocks.dispatchAi.mockResolvedValueOnce({ outcome: "skipped", reason: "already_answered" } as never);
    await runWebhook();
    expect((mocks.dispatchAi.mock.calls[0] as unknown[])[1]).toMatchObject({ replyDelayBypassed: true });
  });

  describe("hostile precedence and durable holds at the webhook", () => {
    const run = async (body: string) => {
      const original = INPUT.body;
      (INPUT as { body: string }).body = body;
      process.env.TEST_SUPABASE_URL = "http://example.test";
      process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      mocks.serviceClient = handlerClient([{ data: INSERTED, error: null }]).client;
      try {
        return await handleInboundWebhook(
          new Request("https://example.test/api/webhooks/sendillo/sms", { method: "POST", headers: { host: "example.test" }, body: "{}" }),
          { includeFullUrl: true, provider: provider() as never },
        );
      } finally {
        (INPUT as { body: string }).body = original;
      }
    };
    const reasonOf = () => (mocks.markAttention.mock.calls[0] as unknown[])[2] as string;

    it.each(["I am not the owner, you idiot", "Wrong number you idiot"])(
      "hostile + wrong-number wording %j is held as hostile_needs_confirm (no wrong_number disposition, no suppression)",
      async (body) => {
        await run(body);
        expect(reasonOf()).toBe("hostile_needs_confirm:message-1");
        expect(mocks.optOut).not.toHaveBeenCalled();
      },
    );

    it("a plain 'wrong person' (scope all) is held with the non-hostile reason", async () => {
      await run("you have the wrong person");
      expect(reasonOf()).toBe("optout_phrase_needs_confirm:message-1");
      expect(mocks.optOut).not.toHaveBeenCalled();
    });

    it("a hold that cannot be saved fails the webhook (retryable) instead of acknowledging the opt-out", async () => {
      mocks.markAttention.mockResolvedValueOnce(false as never);
      const response = await run("do not contact me");
      expect(response.status).toBe(500);
      expect(mocks.optOut).not.toHaveBeenCalled();
      // A redelivery that can save the hold succeeds.
      mocks.markAttention.mockResolvedValueOnce(true as never);
      const retried = await run("do not contact me");
      expect(retried.status).toBe(200);
    });
  });

  describe("opt-out wording: only a bare carrier STOP suppresses automatically (Jarrad 2026-10-08)", () => {
    const withBody = async (body: string) => {
      const original = INPUT.body;
      (INPUT as { body: string }).body = body;
      process.env.TEST_SUPABASE_URL = "http://example.test";
      process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      mocks.serviceClient = handlerClient([{ data: INSERTED, error: null }]).client;
      try {
        await handleInboundWebhook(
          new Request("https://example.test/api/webhooks/sendillo/sms", { method: "POST", headers: { host: "example.test" }, body: "{}" }),
          { includeFullUrl: true, provider: provider() as never },
        );
      } finally {
        (INPUT as { body: string }).body = original;
      }
    };

    it.each(["STOP", "stop", " Stop ", "STOPALL", "unsubscribe", "CANCEL", "end", "Quit"])("bare %j suppresses the number", async (body) => {
      await withBody(body);
      expect(mocks.optOut).toHaveBeenCalledTimes(1);
      expect(mocks.optOut).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ surface: "stop" }));
    });

    it.each(["stop texting me", "do not contact me", "leave me alone", "please stop", "remove me", "STOP texting me you idiot"])(
      "phrase %j does NOT suppress: it is held for a person, nothing dispatched",
      async (body) => {
        await withBody(body);
        expect(mocks.optOut).not.toHaveBeenCalled();
        expect(mocks.dispatchAi).not.toHaveBeenCalled();
        expect(mocks.markAttention).toHaveBeenCalledTimes(1);
        const reason = (mocks.markAttention.mock.calls[0] as unknown[])[2] as string;
        expect(reason).toMatch(/^(hostile_needs_confirm|optout_phrase_needs_confirm):message-1$/);
      },
    );
  });
});
