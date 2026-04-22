import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { POST } from "./route";

// Directly invokes the App Router POST handler with synthetic Request
// objects — no network, no running server. The handler builds its own
// service-role Supabase client from the env (which
// vitest.integration.config.ts points at the test project). The mock
// messaging provider accepts signatures equal to "valid".

const supabase = createTestClient();

function makeRequest(payload: object): Request {
  return new Request("https://example.invalid/api/webhooks/dialpad/sms", {
    method: "POST",
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function seedContact(phone: string, opts: { optIn?: boolean } = {}) {
  const { data } = await supabase
    .from("contacts")
    .insert({ first_name: "Inbound", last_name: "Test", phone_1: phone })
    .select("id")
    .single();
  if (opts.optIn) {
    await supabase.from("consent_events").insert({
      contact_id: data!.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "test-seed",
    });
  }
  return data!.id;
}

describe("POST /api/webhooks/dialpad/sms (integration)", () => {
  beforeEach(async () => {
    // Reuse the test Supabase project's service role key for the
    // handler. Env already has TEST_SUPABASE_SERVICE_ROLE_KEY; the
    // handler falls back to it when SUPABASE_SERVICE_ROLE_KEY is unset.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    await resetTenantTables(supabase);
  });

  it("rejects with 401 when signature is missing / wrong", async () => {
    const req = new Request("https://x.invalid/api/webhooks/dialpad/sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalId: "m1",
        from: "+1",
        to: "+1",
        body: "hi",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("persists a regular inbound as a messages row linked to the contact", async () => {
    const contactId = await seedContact("+18165557777", { optIn: true });
    const res = await POST(
      makeRequest({
        externalId: "msg_hi_001",
        from: "+18165557777",
        to: "+18163706846",
        body: "Hey, got your letter",
      }),
    );
    expect(res.status).toBe(200);

    const { data: messages } = await supabase
      .from("messages")
      .select("direction, status, body, contact_id, external_id")
      .eq("external_id", "msg_hi_001");
    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject({
      direction: "inbound",
      status: "received",
      body: "Hey, got your letter",
      contact_id: contactId,
    });
  });

  it("STOP keyword flips sms_opted_out + writes an opt_out consent event", async () => {
    const contactId = await seedContact("+18165558888", { optIn: true });

    const res = await POST(
      makeRequest({
        externalId: "msg_stop_001",
        from: "+18165558888",
        to: "+18163706846",
        body: "STOP",
      }),
    );
    expect(res.status).toBe(200);

    const { data: contact } = await supabase
      .from("contacts")
      .select("sms_opted_out, sms_opted_out_at")
      .eq("id", contactId)
      .single();
    expect(contact?.sms_opted_out).toBe(true);
    expect(contact?.sms_opted_out_at).not.toBeNull();

    const { data: events } = await supabase
      .from("consent_events")
      .select("event_type, source")
      .eq("contact_id", contactId)
      .eq("event_type", "opt_out");
    expect(events).toHaveLength(1);
    expect(events?.[0].source).toBe("dialpad_inbound_webhook");
  });

  it("HELP keyword logs help_request without mutating sms_opted_out", async () => {
    const contactId = await seedContact("+18165559000", { optIn: true });

    const res = await POST(
      makeRequest({
        externalId: "msg_help_001",
        from: "+18165559000",
        to: "+18163706846",
        body: "HELP",
      }),
    );
    expect(res.status).toBe(200);

    const { data: contact } = await supabase
      .from("contacts")
      .select("sms_opted_out")
      .eq("id", contactId)
      .single();
    expect(contact?.sms_opted_out).toBe(false);

    const { data: events } = await supabase
      .from("consent_events")
      .select("event_type")
      .eq("contact_id", contactId);
    expect(events?.some((e) => e.event_type === "help_request")).toBe(true);
  });

  it("idempotent on retry — second delivery with same external_id does not double-insert", async () => {
    await seedContact("+18165559111", { optIn: true });
    const payload = {
      externalId: "msg_dup_001",
      from: "+18165559111",
      to: "+18163706846",
      body: "first delivery",
    };

    const r1 = await POST(makeRequest(payload));
    expect(r1.status).toBe(200);

    // Second call — Dialpad retry.
    const r2 = await POST(makeRequest(payload));
    expect(r2.status).toBe(200);

    const { count: msgCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "msg_dup_001");
    // Note: current handler inserts the message regardless of
    // webhook_events unique result — idempotency at the event layer
    // prevents downstream double-processing in the handler by
    // `continue`-ing on 23505. Assert that webhook_events has exactly 1.
    const { count: eventCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "msg_dup_001");
    expect(eventCount).toBe(1);
    // The message row is only written once per event because the
    // `continue` short-circuits downstream work on duplicate.
    expect(msgCount).toBe(1);
  });
});
