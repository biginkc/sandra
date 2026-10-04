import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";
import type { MessagingProvider } from "@/lib/messaging/types";
import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";
import { createTestClient } from "@tests/integration/client";

import { SELLER_REMINDER_COPY } from "./seller-reminder-copy";
import {
  dispatchSellerReminder,
  type ClaimedSellerReminder,
  type SellerReminderAdmin,
  type SellerReminderDeps,
} from "./seller-reminder";

/**
 * Seller reminder dispatch through the REAL `sendSmsToContact` transport against the local stack, with a
 * stubbed provider. Only the outbox state machine is in memory (its SQL is covered by
 * 20261005170000_seller_appointment_reminders.integration.test.ts).
 */

const providerStub = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("@/lib/messaging/registry", () => ({
  getMessagingProvider: () =>
    ({
      providerId: "mock",
      sendSms: providerStub.sendSms,
      verifyWebhookSignature: () => true,
      parseInboundWebhook: () => [],
    }) satisfies MessagingProvider,
}));

// Test-only copy. It names the opener identity the transport requires for a first text in a thread.
const TEST_COPY = "TEST Mel with BMH {first_name} at {time}";
const TEST_BODY = "TEST Mel with BMH Sally at 2:30 PM";
const NOW = new Date("2026-10-07T14:00:00Z"); // 09:00 CDT
const DUE = new Date("2026-10-07T19:30:00Z");
const supabase = createTestClient();
const created = { contacts: [] as string[], properties: [] as string[] };
const ORIGINAL_QUIET = process.env.E2E_QUIET_HOURS_NOW;

async function seed() {
  const phone = `+1816${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const { data: contact, error: ce } = await supabase
    .from("contacts")
    .insert({ first_name: "Sally", last_name: "Reminder", phone_1: phone, phone_1_type: "mobile" })
    .select("id")
    .single();
  if (ce || !contact) throw new Error(`seed contact: ${ce?.message}`);
  const { data: property, error: pe } = await supabase
    .from("properties")
    .insert({ address: `${randomUUID()} Reminder Ln`, state: "MO", homeowner_contact_id: contact.id })
    .select("id,org_id")
    .single();
  if (pe || !property) throw new Error(`seed property: ${pe?.message}`);
  created.contacts.push(contact.id);
  created.properties.push(property.id);
  return { contactId: contact.id, propertyId: property.id, orgId: property.org_id as string };
}

type OutboxRow = {
  status: string; send_key: string; attempts: number; message_id: string | null; reason: string | null; token: string;
};

function harness(contactId: string, propertyId: string, orgId: string) {
  const outbox: OutboxRow = { status: "pending", send_key: randomUUID(), attempts: 0, message_id: null, reason: null, token: "" };
  const finishes: Array<Record<string, unknown>> = [];
  const taskRow = { status: "open", mode: "phone", due_at: DUE.toISOString(), contact_id: contactId };
  const settings = { org_id: "org", enabled: true };
  const admin = {
    from: (table: string) => {
      if (table === "tasks" || table === "seller_reminder_settings") {
        const row = table === "tasks" ? taskRow : settings;
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) };
      }
      return (supabase as unknown as SellerReminderAdmin).from(table);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "fn_finish_seller_reminder") throw new Error(`unexpected rpc ${fn}`);
      finishes.push(args);
      if (args.p_token !== outbox.token || outbox.status !== "claimed") return { data: false, error: null };
      outbox.status = String(args.p_status);
      outbox.reason = (args.p_reason as string | null) ?? null;
      outbox.message_id = (args.p_message_id as string | null) ?? outbox.message_id;
      if (args.p_new_send_key) outbox.send_key = String(args.p_new_send_key);
      return { data: true, error: null };
    },
  } as unknown as SellerReminderAdmin;
  const claim = (): ClaimedSellerReminder | null => {
    if (outbox.status !== "pending") return null;
    outbox.status = "claimed";
    outbox.attempts += 1;
    outbox.token = randomUUID();
    return {
      id: "r", org_id: orgId, task_id: "t", calendar_chain_id: "c", property_id: propertyId, contact_id: contactId,
      due_at: DUE.toISOString(), send_at: NOW.toISOString(), send_local_date: "2026-10-07",
      attempts: outbox.attempts, claim_token: outbox.token, send_key: outbox.send_key,
    };
  };
  const deps: SellerReminderDeps = {
    admin,
    send: (input) => sendSmsToContact(supabase, input),
    getConsent: (id) => getConsentState(supabase, id, "sms"),
    getFlag: async () => true,
    schemaReady: async () => true,
    getCopy: () => TEST_COPY,
    now: () => NOW,
  };
  return { outbox, finishes, claim, deps };
}

beforeAll(() => {
  // Inside the transport's own 08:00-21:00 window.
  process.env.E2E_QUIET_HOURS_NOW = "2026-10-07T17:00:00Z";
});

afterAll(async () => {
  if (ORIGINAL_QUIET === undefined) delete process.env.E2E_QUIET_HOURS_NOW;
  else process.env.E2E_QUIET_HOURS_NOW = ORIGINAL_QUIET;
  for (const id of created.properties) {
    await supabase.from("messages").delete().eq("property_id", id);
  }
  for (const id of created.properties) await supabase.from("properties").delete().eq("id", id);
  for (const id of created.contacts) await supabase.from("contacts").delete().eq("id", id);
});

describe("seller reminder through the real SMS transport (stub provider)", () => {
  it("definitive provider failure retries with a NEW send_key and then sends; the old key would only replay the failure", async () => {
    providerStub.sendSms.mockReset();
    providerStub.sendSms
      .mockRejectedValueOnce(new ProviderError("carrier rejected the request", "twilio", { definitiveRejection: true }))
      .mockResolvedValueOnce({ externalId: "ext-ok", providerStatus: "sent", raw: {} });
    const { contactId, propertyId, orgId } = await seed();
    const h = harness(contactId, propertyId, orgId);
    const firstKey = h.outbox.send_key;

    // attempt 1: provider fails definitively -> re-queued with a fresh persisted key
    const row1 = h.claim()!;
    expect(row1.send_key).toBe(firstKey);
    expect(await dispatchSellerReminder(h.deps, row1)).toMatchObject({ status: "pending", reason: "provider_failed" });
    expect(h.outbox.status).toBe("pending");
    expect(h.outbox.send_key).not.toBe(firstKey);
    expect(h.outbox.send_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);

    // the transport replays the stored failure for the OLD key and never reaches the provider again
    const replay = await sendSmsToContact(supabase, {
      origin: "manual", contactId, propertyId, body: TEST_BODY, idempotencyKey: firstKey,
    });
    expect(replay.status).toBe("provider_failed");
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);

    // attempt 2: the new key reaches the provider and succeeds
    const row2 = h.claim()!;
    expect(row2.attempts).toBe(2);
    expect(await dispatchSellerReminder(h.deps, row2)).toMatchObject({ status: "sent" });
    expect(providerStub.sendSms).toHaveBeenCalledTimes(2);
    expect(providerStub.sendSms.mock.calls[1][0]).toMatchObject({ body: TEST_BODY });
    expect(h.outbox.status).toBe("sent");
    const { data: msg } = await supabase.from("messages").select("status,idempotency_key,metadata,body").eq("id", h.outbox.message_id!).single();
    expect(msg).toMatchObject({ status: "sent", idempotency_key: h.outbox.send_key, body: TEST_BODY });
    expect(msg?.metadata).toMatchObject({ kind: "seller_appointment_reminder", reminderId: "r", taskId: "t" });
    expect(h.claim()).toBeNull();
  });

  it("ambiguous provider delivery is terminal `uncertain`: no new key, no resend", async () => {
    providerStub.sendSms.mockReset();
    providerStub.sendSms.mockRejectedValueOnce(
      new ProviderError("gateway timeout after request", "sendillo", { ambiguousDelivery: true }),
    );
    const { contactId, propertyId, orgId } = await seed();
    const h = harness(contactId, propertyId, orgId);
    const key = h.outbox.send_key;
    expect(await dispatchSellerReminder(h.deps, h.claim()!)).toMatchObject({ status: "uncertain", reason: "unknown_delivery" });
    expect(h.outbox).toMatchObject({ status: "uncertain", send_key: key });
    expect(h.claim()).toBeNull();
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);
  });

  it("a transport-level opt-out recorded after scheduling is skipped before the provider", async () => {
    providerStub.sendSms.mockReset();
    const { contactId, propertyId, orgId } = await seed();
    await supabase.from("consent_events").insert({ contact_id: contactId, channel: "sms", event_type: "opt_out", source: "test" } as never);
    const h = harness(contactId, propertyId, orgId);
    expect(await dispatchSellerReminder(h.deps, h.claim()!)).toMatchObject({ status: "skipped", reason: "opted_out" });
    expect(providerStub.sendSms).not.toHaveBeenCalled();
    await supabase.from("consent_events").delete().eq("contact_id", contactId);
  });
});

describe("no resend without proof of non-delivery", () => {
  it("a Twilio-style generic ProviderError raised after the provider call began is uncertain: no new key, no second send", async () => {
    providerStub.sendSms.mockReset();
    providerStub.sendSms.mockRejectedValueOnce(new ProviderError("socket hang up", "twilio"));
    const { contactId, propertyId, orgId } = await seed();
    const h = harness(contactId, propertyId, orgId);
    const key = h.outbox.send_key;
    expect(await dispatchSellerReminder(h.deps, h.claim()!)).toMatchObject({ status: "uncertain", reason: "unknown_delivery" });
    expect(h.outbox).toMatchObject({ status: "uncertain", send_key: key });
    expect(h.claim()).toBeNull();
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);
  });

  it("crash after the provider accepted, then the contact's first name changes, then the row is reclaimed: uncertain, no second send", async () => {
    providerStub.sendSms.mockReset();
    providerStub.sendSms.mockResolvedValue({ externalId: "ext-1", providerStatus: "sent", raw: {} });
    const { contactId, propertyId, orgId } = await seed();
    const h = harness(contactId, propertyId, orgId);
    const first = h.claim()!;
    // the first dispatch reached the provider and the text went out, then the worker died before finishing
    expect((await sendSmsToContact(supabase, {
      origin: "manual", contactId, propertyId, body: TEST_BODY, idempotencyKey: first.send_key,
    })).status).toBe("sent");
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);
    // before the lease is reclaimed, the seller's first name changes, so the rebuilt body differs
    await supabase.from("contacts").update({ first_name: "Sarah" }).eq("id", contactId);
    h.outbox.status = "pending"; // lease expired; claim again with the SAME key
    const second = h.claim()!;
    expect(second.send_key).toBe(first.send_key);
    expect(await dispatchSellerReminder(h.deps, second)).toMatchObject({ status: "uncertain", reason: "unknown_delivery" });
    expect(providerStub.sendSms).toHaveBeenCalledTimes(1);
    expect(h.outbox.send_key).toBe(first.send_key);
    expect(h.claim()).toBeNull();
  });
});

describe("opening identity rule in the transport", () => {
  it("a first text in a thread whose body does not name 'Mel with BMH' (the approved copy) is skipped, never retried", async () => {
    providerStub.sendSms.mockReset();
    const { contactId, propertyId, orgId } = await seed();
    const h = harness(contactId, propertyId, orgId);
    h.deps.getCopy = () => SELLER_REMINDER_COPY;
    expect(await dispatchSellerReminder(h.deps, h.claim()!)).toMatchObject({ status: "skipped", reason: "opening_identity_required" });
    expect(providerStub.sendSms).not.toHaveBeenCalled();
    expect(h.claim()).toBeNull();
  });
});

describe("transport idempotency-key boundary", () => {
  it("accepts a persisted UUID v4 key and rejects a prefixed string key as db_error", async () => {
    providerStub.sendSms.mockReset();
    const { contactId, propertyId, orgId } = await seed();
    const bad = await sendSmsToContact(supabase, {
      origin: "manual", contactId, propertyId, body: "x", idempotencyKey: `seller-reminder:${randomUUID()}`,
    });
    expect(bad).toEqual({ status: "db_error", error: "SMS idempotency key is invalid." });
    const good = await sendSmsToContact(supabase, {
      origin: "manual", contactId, propertyId, body: "x", idempotencyKey: randomUUID(),
    });
    expect(good).not.toEqual({ status: "db_error", error: "SMS idempotency key is invalid." });
  });
});
