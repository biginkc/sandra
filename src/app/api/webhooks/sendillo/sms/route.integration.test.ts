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
      .select("contact_id, property_id, provider, external_id")
      .eq("external_id", "snd_realish_001")
      .single();
    expect(message).toMatchObject({
      contact_id: contactId,
      property_id: property!.id,
      provider: "sendillo",
      external_id: "snd_realish_001",
    });
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
    });

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
