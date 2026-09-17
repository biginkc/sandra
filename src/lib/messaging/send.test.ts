import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { ProviderError } from "@/lib/errors/classes";

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));
const adminRpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpc }),
}));

// Mock every side-dependency sendSmsToContact touches *before* the fresh
// automated-suppression re-check, so the test can drive the pipeline up to
// that exact boundary with a minimal, deterministic fake Supabase client.
vi.mock("./registry", () => ({
  getMessagingProvider: vi.fn(),
}));
vi.mock("./consent", () => ({
  getConsentState: vi.fn(),
}));
vi.mock("./opt-out-phone", () => ({
  isSmsPhoneSuppressed: vi.fn(),
}));
vi.mock("./quiet-hours", () => ({
  checkQuietHours: vi.fn(),
}));
vi.mock("@/lib/messages/threading", () => ({
  ensureConversationIdForThread: vi.fn(),
}));

import { sendSmsToContact } from "./send";
import { getMessagingProvider } from "./registry";
import { getConsentState } from "./consent";
import { isSmsPhoneSuppressed } from "./opt-out-phone";
import { checkQuietHours } from "./quiet-hours";
import { ensureConversationIdForThread } from "@/lib/messages/threading";

const CONTACT_ID = "11111111-1111-1111-1111-111111111111";
const PROPERTY_ID = "22222222-2222-2222-2222-222222222222";

/** A thenable, infinitely-chainable fake Postgrest query builder that
 *  resolves to a fixed `{ data, error }` result regardless of which
 *  builder methods are called on the way there. */
function chain(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: () => builder,
    update: () => builder,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

/** Fake Supabase client whose `.from(table)` hands back the next queued
 *  chain for that table (FIFO per table) — lets a test script exactly
 *  which result each successive call to the same table should return. */
function fakeSupabase(queues: Record<string, Array<{ data: unknown; error: { message: string; code?: string } | null }>>) {
  return {
    from: (table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) {
        throw new Error(`fakeSupabase: no queued result for table "${table}"`);
      }
      return chain(q.shift()!);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeProvider() {
  return {
    providerId: "fake-test-provider",
    sendSms: vi.fn().mockResolvedValue({
      externalId: "ext-1",
      providerStatus: "queued",
      raw: {},
    }),
    verifyWebhookSignature: () => true,
    parseInboundWebhook: () => [],
  };
}

const CONTACT_ROW = {
  id: CONTACT_ID,
  phone_1: "+15005550006",
  phone_1_type: "mobile",
  phone_2: null,
  phone_2_type: null,
  phone_3: null,
  phone_3_type: null,
  do_not_contact: false,
  sms_opted_out: false,
};

const PROPERTY_ROW = {
  id: PROPERTY_ID,
  org_id: "33333333-3333-3333-3333-333333333333",
  state: "MO",
  outreach_dispo: null,
};

beforeEach(() => {
  vi.mocked(getMessagingProvider).mockReturnValue(fakeProvider());
  vi.mocked(getConsentState).mockResolvedValue("can_send_marketing");
  vi.mocked(isSmsPhoneSuppressed).mockResolvedValue(false);
  vi.mocked(checkQuietHours).mockReturnValue({
    ok: true,
    localTime: "10:00",
    zone: "America/Chicago",
  } as never);
  vi.mocked(ensureConversationIdForThread).mockResolvedValue("conv-1");
});

describe("sendSmsToContact — fail-closed fresh-state suppression re-check", () => {
  it("automated send: fresh property reload errors → held, no provider call, typed outcome", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [
        { data: CONTACT_ROW, error: null }, // main pipeline lookup
        { data: { do_not_contact: false, sms_opted_out: false }, error: null }, // fresh re-check
      ],
      properties: [
        { data: PROPERTY_ROW, error: null }, // main pipeline lookup
        { data: null, error: { message: "connection reset by peer" } }, // fresh re-check — ERRORS
      ],
      messages: [
        { data: { id: "msg-1" }, error: null }, // pending insert
        { data: null, error: null }, // held-status update
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "automated",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(provider.sendSms).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "blocked_fresh_state_unavailable",
      messageId: "msg-1",
      error: "connection reset by peer",
    });
  });

  it("automated send: fresh property reload returns no row (maybeSingle null, no error) → held, no provider call", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [
        { data: CONTACT_ROW, error: null }, // main pipeline lookup
        { data: { do_not_contact: false, sms_opted_out: false }, error: null }, // fresh re-check
      ],
      properties: [
        { data: PROPERTY_ROW, error: null }, // main pipeline lookup
        { data: null, error: null }, // fresh re-check — row gone, no error
      ],
      messages: [
        { data: { id: "msg-3" }, error: null }, // pending insert
        { data: null, error: null }, // held-status update
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "automated",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(provider.sendSms).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "blocked_fresh_state_unavailable",
      messageId: "msg-3",
      error: "fresh suppression state reload: property row not found",
    });
  });

  it("automated send: fresh contact reload returns no row (maybeSingle null, no error) → held, no provider call", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [
        { data: CONTACT_ROW, error: null }, // main pipeline lookup
        { data: null, error: null }, // fresh re-check — row gone, no error
      ],
      properties: [
        { data: PROPERTY_ROW, error: null }, // main pipeline lookup
        { data: PROPERTY_ROW, error: null }, // fresh re-check
      ],
      messages: [
        { data: { id: "msg-4" }, error: null }, // pending insert
        { data: null, error: null }, // held-status update
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "automated",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(provider.sendSms).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "blocked_fresh_state_unavailable",
      messageId: "msg-4",
      error: "fresh suppression state reload: contact row not found",
    });
  });

  it("manual send: does not run the fresh re-check at all — sends normally", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [
        { data: { id: "msg-2" }, error: null }, // pending insert
        { data: { id: "msg-2" }, error: null }, // sent-status CAS result
      ],
      webhook_events: [{ data: [], error: null }], // status-event reconciliation
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(provider.sendSms).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "sent", messageId: "msg-2" });
  });
});

describe("sendSmsToContact — Sendillo organization scope", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function sendilloProvider() {
    return { ...fakeProvider(), providerId: "sendillo" };
  }

  function setupSendilloPreflight() {
    return fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
    });
  }

  it("blocks a Sendillo dispatch for a property in another organization before inserting or calling the provider", async () => {
    const provider = sendilloProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    vi.stubEnv("SENDILLO_ORG_ID", "different-org");

    const outcome = await sendSmsToContact(setupSendilloPreflight(), {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(outcome).toEqual({
      status: "db_error",
      error: "Sendillo texting is not available for this organization.",
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it("blocks a Sendillo dispatch when tenant scope configuration is missing", async () => {
    const provider = sendilloProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    vi.stubEnv("SENDILLO_ORG_ID", "");

    const outcome = await sendSmsToContact(setupSendilloPreflight(), {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(outcome).toEqual({
      status: "db_error",
      error: "Sendillo texting organization scope is not configured. Set SENDILLO_ORG_ID before assigning numbers.",
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it("blocks a keyed replay from another organization before reading or revealing its ledger row", async () => {
    const provider = sendilloProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("SENDILLO_ORG_ID", "configured-org");

    const supabase = fakeSupabase({
      properties: [{ data: { ...PROPERTY_ROW, org_id: "other-org" }, error: null }],
      messages: [{ data: { id: "must-not-be-read" }, error: null }],
    });
    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });

    expect(outcome).toEqual({
      status: "db_error",
      error: "Sendillo texting is not available for this organization.",
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });
});

describe("sendSmsToContact — rep SMS idempotency replay", () => {
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  const existing = (overrides: Record<string, unknown> = {}) => ({
    id: "message-existing",
    org_id: PROPERTY_ROW.org_id,
    property_id: PROPERTY_ID,
    contact_id: CONTACT_ID,
    body: "hello",
    status: "sent",
    external_id: "provider-existing",
    error_message: null,
    from_address: "+18165551234",
    to_address: CONTACT_ROW.phone_1,
    metadata: null,
    ...overrides,
  });

  it("replays a completed submission without calling the provider again", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [{ data: existing(), error: null }],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
      idempotencyKey,
    });

    expect(outcome).toEqual({ status: "sent", messageId: "message-existing", externalId: "provider-existing" });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it("replays a completed submission even when provider configuration is unavailable on reload", async () => {
    vi.mocked(getMessagingProvider).mockClear();
    vi.mocked(getMessagingProvider).mockImplementation(() => null);
    const supabase = fakeSupabase({
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [{ data: existing(), error: null }],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
      idempotencyKey,
    });

    expect(outcome).toEqual({ status: "sent", messageId: "message-existing", externalId: "provider-existing" });
    expect(getMessagingProvider).not.toHaveBeenCalled();
  });

  it("holds a pending submission as provider_unknown rather than issuing a duplicate request", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [{ data: existing({ status: "pending", external_id: null }), error: null }],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
      idempotencyKey,
    });

    expect(outcome).toEqual({
      status: "provider_unknown",
      messageId: "message-existing",
      error: "A previous SMS request is still being reconciled.",
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it("rejects a replay with a changed body before any provider call", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [{ data: existing(), error: null }],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "edited after response loss",
      from: "+18165551234",
      idempotencyKey,
    });

    expect(outcome).toEqual({
      status: "db_error",
      error: "SMS idempotency key was already used for a different message body. Start a new message before sending.",
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });

  it("wins an insert race by replaying the winner instead of sending twice", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [
        { data: null, error: null },
        { data: null, error: { message: "duplicate key", code: "23505" } },
        { data: existing(), error: null },
        { data: null, error: null },
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
      idempotencyKey,
    });

    expect(outcome).toEqual({ status: "sent", messageId: "message-existing", externalId: "provider-existing" });
    expect(provider.sendSms).not.toHaveBeenCalled();
  });
});

describe("sendSmsToContact — ambiguous Sendillo outcomes", () => {
  beforeEach(() => {
    vi.stubEnv("SENDILLO_ORG_ID", PROPERTY_ROW.org_id);
  });

  it.each([
    ["transport", { transportFailure: true }],
    ["timeout", { isAbort: true }],
    ["server error", { status: 503, ambiguousDelivery: true }],
    ["accepted without id", { acceptedWithoutId: true }],
  ])("returns provider_unknown and does not expose a retry for %s", async (_label, details) => {
    const provider = fakeProvider();
    provider.providerId = "sendillo";
    provider.sendSms.mockRejectedValueOnce(
      new ProviderError("Sendillo delivery state is unknown", "sendillo", details),
    );
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [
        { data: { id: "msg-unknown" }, error: null },
        { data: null, error: null },
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(outcome).toEqual({
      status: "provider_unknown",
      messageId: "msg-unknown",
      error: "Sendillo delivery state is unknown",
    });
    expect(provider.sendSms).toHaveBeenCalledTimes(1);
  });

  it("keeps a preflight notSent rejection retryable", async () => {
    const provider = fakeProvider();
    provider.providerId = "sendillo";
    provider.sendSms.mockRejectedValueOnce(
      new ProviderError("Sendillo sender is missing", "sendillo", { notSent: true }),
    );
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [
        { data: { id: "msg-failed" }, error: null },
        { data: null, error: null },
      ],
    });

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      body: "hello",
      from: "+18165551234",
    });

    expect(outcome).toEqual({
      status: "provider_failed",
      messageId: "msg-failed",
      error: "Sendillo sender is missing",
    });
  });
});

describe("sendSmsToContact — service-owned rep SMS retry fence", () => {
  const receipt = (claimGeneration: number) => ({
    receiptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    claimToken: claimGeneration === 1
      ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    claimGeneration,
    orgId: PROPERTY_ROW.org_id,
  });

  it("records a proven pre-provider authorization failure, then permits the owner-fenced next generation", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);
    const authorize = vi.fn()
      .mockRejectedValueOnce(new Error("sender grant was revoked"))
      .mockResolvedValueOnce(undefined);
    adminRpc
      .mockResolvedValueOnce({ data: { ok: true, state: "failed_not_dispatched" }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted", providerMessageId: "ext-1" }, error: null });

    const first = await sendSmsToContact(
      fakeSupabase({
        contacts: [{ data: CONTACT_ROW, error: null }],
        properties: [{ data: PROPERTY_ROW, error: null }],
        messages: [
          { data: { id: "msg-failed" }, error: null },
          { data: null, error: null },
        ],
      }),
      {
        origin: "manual",
        contactId: CONTACT_ID,
        propertyId: PROPERTY_ID,
        body: "hello",
        from: "+18163706846",
        repSmsReceipt: receipt(1),
      },
      { provider, authorize },
    );

    expect(first).toEqual({
      status: "provider_failed",
      messageId: "msg-failed",
      error: "sender grant was revoked",
      providerAttempted: false,
    });
    expect(provider.sendSms).not.toHaveBeenCalled();
    expect(adminRpc).toHaveBeenNthCalledWith(1, "fn_record_rep_sms_delivery_result", expect.objectContaining({
      p_receipt_id: receipt(1).receiptId,
      p_claim_token: receipt(1).claimToken,
      p_claim_generation: 1,
      p_state: "failed_not_dispatched",
      p_provider_error: "sender grant was revoked",
    }));

    const second = await sendSmsToContact(
      fakeSupabase({
        contacts: [{ data: CONTACT_ROW, error: null }],
        properties: [{ data: PROPERTY_ROW, error: null }],
        messages: [
          { data: { id: "msg-retry" }, error: null },
          { data: { id: "msg-retry" }, error: null },
        ],
        webhook_events: [{ data: [], error: null }],
      }),
      {
        origin: "manual",
        contactId: CONTACT_ID,
        propertyId: PROPERTY_ID,
        body: "hello",
        from: "+18163706846",
        repSmsReceipt: receipt(2),
      },
      { provider, authorize },
    );

    expect(second).toEqual({ status: "sent", messageId: "msg-retry", externalId: "ext-1" });
    expect(provider.sendSms).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith("msg-failed");
    expect(authorize).toHaveBeenCalledWith("msg-retry");
    expect(adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_delivery_result", expect.objectContaining({
      p_receipt_id: receipt(2).receiptId,
      p_claim_token: receipt(2).claimToken,
      p_claim_generation: 2,
      p_state: "accepted",
      p_provider_message_id: "ext-1",
    }));
  });
});

 it("refuses training before queue creation or provider resolution", async () => {
  vi.mocked(assertNotTrainingTarget).mockRejectedValueOnce(new Error("Internal training"));
  vi.mocked(getMessagingProvider).mockClear();
  const client = fakeSupabase({});
  const fromSpy = vi.spyOn(client, "from");
  await expect(sendSmsToContact(client, { origin: "manual", contactId: CONTACT_ID, propertyId: PROPERTY_ID, body: "Practice", queueOnly: true })).rejects.toThrow("Internal training");
  expect(getMessagingProvider).not.toHaveBeenCalled();
  expect(fromSpy).not.toHaveBeenCalled();
 });
