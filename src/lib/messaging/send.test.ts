import { describe, expect, it, vi, beforeEach } from "vitest";

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

  it("manual send: does not run the fresh re-check at all — sends normally", async () => {
    const provider = fakeProvider();
    vi.mocked(getMessagingProvider).mockReturnValue(provider);

    const supabase = fakeSupabase({
      contacts: [{ data: CONTACT_ROW, error: null }],
      properties: [{ data: PROPERTY_ROW, error: null }],
      messages: [
        { data: { id: "msg-2" }, error: null }, // pending insert
        { data: null, error: null }, // sent-status update
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
