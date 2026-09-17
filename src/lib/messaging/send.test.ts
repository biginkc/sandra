import { describe, expect, it, vi, beforeEach } from "vitest";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { ProviderError } from "@/lib/errors/classes";

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));

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
function fakeSupabase(queues: Record<string, Array<{ data: unknown; error: { message: string } | null }>>) {
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

describe("sendSmsToContact — ambiguous Sendillo outcomes", () => {
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

 it("refuses training before queue creation or provider resolution", async () => {
  vi.mocked(assertNotTrainingTarget).mockRejectedValueOnce(new Error("Internal training"));
  vi.mocked(getMessagingProvider).mockClear();
  const client = fakeSupabase({});
  const fromSpy = vi.spyOn(client, "from");
  await expect(sendSmsToContact(client, { origin: "manual", contactId: CONTACT_ID, propertyId: PROPERTY_ID, body: "Practice", queueOnly: true })).rejects.toThrow("Internal training");
  expect(getMessagingProvider).not.toHaveBeenCalled();
  expect(fromSpy).not.toHaveBeenCalled();
 });
