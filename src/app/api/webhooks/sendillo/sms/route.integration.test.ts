import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { claimInboundSmsIntent } from "@/lib/messaging/inbound-intents";

import { POST } from "./route";

const supabase = createTestClient();
const ORIGINAL_ENV = {
  MESSAGING_PROVIDER: process.env.MESSAGING_PROVIDER,
  SENDILLO_API_KEY: process.env.SENDILLO_API_KEY,
  SENDILLO_FROM_NUMBER: process.env.SENDILLO_FROM_NUMBER,
  SENDILLO_WEBHOOK_SECRET: process.env.SENDILLO_WEBHOOK_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SKIP_INTENT_GATE: process.env.SKIP_INTENT_GATE,
};

async function seedContact(phone: string) {
  const { data } = await supabase
    .from("contacts")
    .insert({
      first_name: "Sendillo",
      last_name: "Inbound",
      phone_1: phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  return data!.id;
}

async function expectNoMessageOrWebhookReservation(externalId: string) {
  const { count: messageCount } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("external_id", externalId);
  const { count: eventCount } = await supabase
    .from("webhook_events")
    .select("*", { count: "exact", head: true })
    .eq("external_id", externalId);
  expect(messageCount).toBe(0);
  expect(eventCount).toBe(0);
}

describe("POST /api/webhooks/sendillo/sms (integration)", () => {
  beforeEach(async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    delete process.env.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18164876899";
    process.env.SENDILLO_WEBHOOK_SECRET = "sendillo-secret";
    process.env.SKIP_INTENT_GATE = "1";
    await resetTenantTables(supabase);
  });

  afterEach(() => {
    process.env.MESSAGING_PROVIDER = ORIGINAL_ENV.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = ORIGINAL_ENV.SENDILLO_API_KEY;
    process.env.SENDILLO_FROM_NUMBER = ORIGINAL_ENV.SENDILLO_FROM_NUMBER;
    process.env.SENDILLO_WEBHOOK_SECRET = ORIGINAL_ENV.SENDILLO_WEBHOOK_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_ENV.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_ENV.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SKIP_INTENT_GATE = ORIGINAL_ENV.SKIP_INTENT_GATE;
  });

  it("rejects when the Sendillo shared secret is missing", async () => {
    const req = new Request("https://example.invalid/api/webhooks/sendillo/sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "inbound.received",
        data: {
          messageId: "snd_missing_secret",
          from: "+18165550001",
          to: "+18164876899",
          body: "hi",
        },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("rejects the wrong Sendillo target URL query secret without reserving the webhook", async () => {
    const req = new Request(
      "https://example.invalid/api/webhooks/sendillo/sms?secret=wrong",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId: "snd_wrong_secret_001",
            from: "+18165550004",
            to: "+18164876899",
            body: "hi",
          },
        }),
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(401);
    await expectNoMessageOrWebhookReservation("snd_wrong_secret_001");
  });

  it("rejects the wrong Sendillo header secret without reserving the webhook", async () => {
    const req = new Request("https://example.invalid/api/webhooks/sendillo/sms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sendillo-webhook-secret": "wrong",
      },
      body: JSON.stringify({
        event: "inbound.received",
        data: {
          messageId: "snd_wrong_secret_002",
          from: "+18165550005",
          to: "+18164876899",
          body: "hi",
        },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    await expectNoMessageOrWebhookReservation("snd_wrong_secret_002");
  });

  it("accepts the shared secret from Sendillo's target URL query", async () => {
    const contactId = await seedContact("+18165550002");
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "1 Sendillo Secret Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: "+18164876899",
      to_address: "+18165550002",
      body: "seed outbound",
      contact_id: contactId,
      property_id: property!.id,
    });

    const body = JSON.stringify({
      event: "inbound.received",
      timestamp: "2026-06-08T19:07:39.264912233Z",
      data: {
        messageId: "snd_realish_001",
        from: "+18165550002",
        to: "+18164876899",
        body: "YES",
        type: "SMS",
        receivedAt: "2026-06-08T19:07:39.257Z",
      },
    });
    const makeRequest = () =>
      new Request(
        "https://example.invalid/api/webhooks/sendillo/sms?secret=sendillo-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const replayRes = await POST(makeRequest());
    expect(replayRes.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, provider, external_id")
      .eq("external_id", "snd_realish_001")
      .single();
    expect(message).toMatchObject({
      contact_id: contactId,
      property_id: property!.id,
      provider: "sendillo",
      external_id: "snd_realish_001",
    });

    const { count: messageCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("external_id", "snd_realish_001");
    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("provider, event_type, signature_verified, processing_status")
      .eq("provider", "sendillo")
      .eq("event_type", "sms_inbound")
      .eq("external_id", "snd_realish_001")
      .single();
    const { count: eventCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("event_type", "sms_inbound")
      .eq("external_id", "snd_realish_001");

    expect(messageCount).toBe(1);
    expect(eventCount).toBe(1);
    expect(webhookEvent).toMatchObject({
      provider: "sendillo",
      event_type: "sms_inbound",
      signature_verified: true,
      processing_status: "processed",
    });
  });

  it("collapses semantic duplicate Sendillo IDs inside the inbound burst window", async () => {
    const contactId = await seedContact("+18165550102");
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "3 Sendillo Dedupe Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: "+18164876899",
      to_address: "+18165550102",
      body: "seed outbound",
      contact_id: contactId,
      property_id: property!.id,
    });

    const makeRequest = (messageId: string, receivedAt: string) =>
      new Request("https://example.invalid/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-webhook-secret": "sendillo-secret",
        },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId,
            from: "+18165550102",
            to: "+18164876899",
            body: "Go away",
            type: "SMS",
            receivedAt,
          },
        }),
      });

    const [first, second, third] = await Promise.all([
      POST(makeRequest("snd_semantic_dup_001", "2026-06-08T19:09:39.000Z")),
      POST(makeRequest("snd_semantic_dup_002", "2026-06-08T19:09:39.080Z")),
      POST(makeRequest("snd_semantic_dup_003", "2026-06-08T19:09:39.120Z")),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    const { count: inboundCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("direction", "inbound")
      .eq("contact_id", contactId)
      .eq("body", "Go away");
    const { data: intent } = await supabase
      .from("sms_inbound_intents")
      .select("id, duplicate_count, canonical_message_id")
      .eq("contact_id", contactId)
      .single();
    const { count: deliveryCount } = await supabase
      .from("sms_inbound_deliveries")
      .select("*", { count: "exact", head: true })
      .eq("intent_id", intent!.id);

    expect(inboundCount).toBe(1);
    expect(intent).toMatchObject({ duplicate_count: 2 });
    expect(intent!.canonical_message_id).toBeTruthy();
    expect(deliveryCount).toBe(3);
  });

  it("lets the same Sendillo ID resume a partially claimed inbound intent", async () => {
    const contactId = await seedContact("+18165550104");
    const { data: contact } = await supabase
      .from("contacts")
      .select("org_id")
      .eq("id", contactId)
      .single();
    const baseInput = {
      orgId: contact!.org_id,
      providerId: "sendillo",
      externalId: "snd_partial_retry_001",
      from: "+18165550104",
      to: "+18164876899",
      body: "Go away",
      receivedAt: new Date("2026-06-08T19:09:39.000Z"),
      raw: { data: { messageId: "snd_partial_retry_001" } },
      mediaUrls: null,
      webhookEventId: null,
      contactId,
      propertyId: null,
      conversationId: null,
      routingResolution: "contact",
    };

    const first = await claimInboundSmsIntent(supabase, baseInput);
    const retry = await claimInboundSmsIntent(supabase, baseInput);
    const duplicate = await claimInboundSmsIntent(supabase, {
      ...baseInput,
      externalId: "snd_partial_retry_002",
      raw: { data: { messageId: "snd_partial_retry_002" } },
    });

    expect(first).toMatchObject({ duplicate: false });
    expect(retry).toMatchObject({
      duplicate: false,
      intentId: first.intentId,
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      intentId: first.intentId,
    });
  });

  it("marks contact-only Sendillo intents complete after triage side effects", async () => {
    const contactId = await seedContact("+18165550106");
    const req = new Request("https://example.invalid/api/webhooks/sendillo/sms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sendillo-webhook-secret": "sendillo-secret",
      },
      body: JSON.stringify({
        event: "inbound.received",
        data: {
          messageId: "snd_contact_only_001",
          from: "+18165550106",
          to: "+18164876899",
          body: "Who is this?",
          type: "SMS",
          receivedAt: "2026-06-08T19:09:39.000Z",
        },
      }),
    });

    expect((await POST(req)).status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("id, property_id, inbound_intent_id")
      .eq("external_id", "snd_contact_only_001")
      .single();
    const { data: intent } = await supabase
      .from("sms_inbound_intents")
      .select("canonical_message_id, status")
      .eq("id", message!.inbound_intent_id!)
      .single();

    expect(message).toMatchObject({
      property_id: null,
      inbound_intent_id: expect.any(String),
    });
    expect(intent).toMatchObject({
      canonical_message_id: message!.id,
      status: "side_effects_complete",
    });
    expect(contactId).toBeTruthy();
  });

  it("treats the same Sendillo body outside the burst window as a real second inbound", async () => {
    const contactId = await seedContact("+18165550103");
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "4 Sendillo Repeat Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: "+18164876899",
      to_address: "+18165550103",
      body: "seed outbound",
      contact_id: contactId,
      property_id: property!.id,
    });

    const makeRequest = (messageId: string, receivedAt: string) =>
      new Request("https://example.invalid/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-webhook-secret": "sendillo-secret",
        },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId,
            from: "+18165550103",
            to: "+18164876899",
            body: "Go away",
            type: "SMS",
            receivedAt,
          },
        }),
      });

    expect(
      (await POST(makeRequest("snd_repeat_001", "2026-06-08T19:09:39.000Z")))
        .status,
    ).toBe(200);
    expect(
      (await POST(makeRequest("snd_repeat_002", "2026-06-08T19:09:42.001Z")))
        .status,
    ).toBe(200);

    const { count: inboundCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("direction", "inbound")
      .eq("contact_id", contactId)
      .eq("body", "Go away");
    const { count: intentCount } = await supabase
      .from("sms_inbound_intents")
      .select("*", { count: "exact", head: true })
      .eq("contact_id", contactId);

    expect(inboundCount).toBe(2);
    expect(intentCount).toBe(2);
  });

  it("keeps same-body Sendillo media messages distinct inside the burst window", async () => {
    const contactId = await seedContact("+18165550105");
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "5 Sendillo Media Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: "+18164876899",
      to_address: "+18165550105",
      body: "seed outbound",
      contact_id: contactId,
      property_id: property!.id,
    });

    const makeRequest = (messageId: string, mediaUrl: string) =>
      new Request("https://example.invalid/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-webhook-secret": "sendillo-secret",
        },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId,
            from: "+18165550105",
            to: "+18164876899",
            body: "See this",
            type: "SMS",
            receivedAt: "2026-06-08T19:09:39.080Z",
            mediaUrls: [mediaUrl],
          },
        }),
      });

    expect((await POST(makeRequest("snd_media_001", "https://mms.test/a.jpg"))).status).toBe(200);
    expect((await POST(makeRequest("snd_media_002", "https://mms.test/b.jpg"))).status).toBe(200);

    const { count: inboundCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("direction", "inbound")
      .eq("contact_id", contactId)
      .eq("body", "See this");
    const { count: intentCount } = await supabase
      .from("sms_inbound_intents")
      .select("*", { count: "exact", head: true })
      .eq("contact_id", contactId);

    expect(inboundCount).toBe(2);
    expect(intentCount).toBe(2);
  });

  it("accepts the shared secret from a header without relying on the query string", async () => {
    const contactId = await seedContact("+18165550003");
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "2 Sendillo Header Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: "+18164876899",
      to_address: "+18165550003",
      body: "seed outbound",
      contact_id: contactId,
      property_id: property!.id,
    });

    const req = new Request("https://example.invalid/api/webhooks/sendillo/sms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-webhook-secret": "sendillo-secret",
        },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId: "snd_realish_002",
            from: "+18165550003",
            to: "+18164876899",
            body: "HEADER OK",
            type: "SMS",
            receivedAt: "2026-06-08T19:08:39.257Z",
          },
        }),
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, provider, external_id")
      .eq("external_id", "snd_realish_002")
      .single();
    expect(message).toMatchObject({
      contact_id: contactId,
      property_id: property!.id,
      provider: "sendillo",
      external_id: "snd_realish_002",
    });
  });
});
