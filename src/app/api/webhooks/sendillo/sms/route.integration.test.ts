import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

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
    })
    .select("id")
    .single();
  return data!.id;
}

function makeSendilloRequest(body: {
  messageId: string;
  from: string;
  to: string;
  body: string;
  receivedAt?: string;
}): Request {
  return new Request(
    "https://example.invalid/api/webhooks/sendillo/sms?secret=sendillo-secret",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "inbound.received",
        timestamp: "2026-06-08T19:07:39.264912233Z",
        data: {
          messageId: body.messageId,
          from: body.from,
          to: body.to,
          body: body.body,
          type: "SMS",
          receivedAt: body.receivedAt ?? "2026-06-08T19:07:39.257Z",
        },
      }),
    },
  );
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

  it("accepts a real Sendillo-shaped inbound when the shared secret is present in the URL", async () => {
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

    const req = new Request(
      "https://example.invalid/api/webhooks/sendillo/sms?secret=sendillo-secret",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
        }),
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, provider, direction, status, external_id")
      .eq("external_id", "snd_realish_001")
      .single();
    expect(message).toMatchObject({
      contact_id: contactId,
      property_id: property!.id,
      provider: "sendillo",
      direction: "inbound",
      status: "received",
    });
  });

  it("does not duplicate STOP consent events when a Sendillo replay resumes a pending keyword webhook", async () => {
    const phone = "+18165550003";
    const contactId = await seedContact(phone);
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      provider: "sendillo",
      external_id: "snd_stop_resume_001",
      from_address: phone,
      to_address: "+18164876899",
      body: "STOP",
      contact_id: contactId,
      metadata: { keyword: "stop" },
    });
    await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_out",
      source: "sendillo_inbound_webhook",
      source_detail: { externalId: "snd_stop_resume_001", from: phone },
    });
    await supabase.from("webhook_events").insert({
      provider: "sendillo",
      event_type: "sms_inbound",
      external_id: "snd_stop_resume_001",
      signature_verified: true,
      processing_status: "pending",
      payload: {
        event: "inbound.received",
        data: {
          messageId: "snd_stop_resume_001",
          from: phone,
          to: "+18164876899",
          body: "STOP",
        },
      },
    });

    const res = await POST(
      makeSendilloRequest({
        messageId: "snd_stop_resume_001",
        from: phone,
        to: "+18164876899",
        body: "STOP",
      }),
    );
    expect(res.status).toBe(200);

    const { count: consentCount } = await supabase
      .from("consent_events")
      .select("*", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("event_type", "opt_out");
    expect(consentCount).toBe(1);

    const { data: contact } = await supabase
      .from("contacts")
      .select("sms_opted_out")
      .eq("id", contactId)
      .single();
    expect(contact?.sms_opted_out).toBe(true);
  });
});
