import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import * as pathSecretRoute from "./[secret]/route";
import { POST } from "./route";
import { reconcileStoredStatusEvents } from "@/lib/messaging/status-events";
import type { Json } from "@/lib/supabase/types";

const supabase = createTestClient();
const ORIGINAL_ENV = {
  MESSAGING_PROVIDER: process.env.MESSAGING_PROVIDER,
  SENDILLO_API_KEY: process.env.SENDILLO_API_KEY,
  SENDILLO_FROM_NUMBER: process.env.SENDILLO_FROM_NUMBER,
  SENDILLO_WEBHOOK_SECRET: process.env.SENDILLO_WEBHOOK_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
};

type SeedMessageInput = {
  externalId: string;
  status?: string;
  sentAt?: string | null;
  deliveredAt?: string | null;
  failedAt?: string | null;
  errorMessage?: string | null;
  contactId?: string | null;
  propertyId?: string | null;
  conversationId?: string | null;
  metadata?: Json | null;
};

async function seedOutboundMessage(input: SeedMessageInput) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: input.status ?? "sent",
      provider: "sendillo",
      external_id: input.externalId,
      from_address: "+18164876899",
      to_address: "+18165550001",
      body: "seed outbound",
      contact_id: input.contactId ?? null,
      property_id: input.propertyId ?? null,
      conversation_id: input.conversationId ?? null,
      sent_at: input.sentAt ?? null,
      delivered_at: input.deliveredAt ?? null,
      failed_at: input.failedAt ?? null,
      error_message: input.errorMessage ?? null,
      metadata: input.metadata ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "failed to seed outbound message");
  }

  return data.id;
}

async function seedThreadContext(conversationId: string, phone: string) {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: "Sandra",
      last_name: "Status",
      phone_1: phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw new Error(contactError?.message ?? "failed to seed status contact");
  }

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      address: "1 Sandra Status Ln",
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id, org_id")
    .single();
  if (propertyError || !property) {
    throw new Error(propertyError?.message ?? "failed to seed status property");
  }

  const { error: threadError } = await supabase.from("message_threads").insert({
    org_id: property.org_id,
    channel: "sms",
    contact_id: contact.id,
    property_id: property.id,
    conversation_id: conversationId,
    ai_responder_status: "handled",
    ai_responder_reason: "sent",
    ai_responder_status_at: "2026-06-10T16:54:10.000Z",
  });
  if (threadError) {
    throw new Error(threadError.message);
  }

  return { contactId: contact.id, propertyId: property.id };
}

async function bindAiThreadMessage(conversationId: string, messageId: string) {
  const { error } = await supabase
    .from("message_threads")
    .update({ ai_responder_message_id: messageId })
    .eq("conversation_id", conversationId);
  if (error) throw new Error(error.message);
}

async function loadMessage(externalId: string) {
  const { data } = await supabase
    .from("messages")
    .select("status, sent_at, delivered_at, failed_at, error_message")
    .eq("external_id", externalId)
    .maybeSingle();
  return data;
}

async function waitForMessageStatus(
  externalId: string,
  status: string,
  timeoutMs = 1000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await loadMessage(externalId);
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return loadMessage(externalId);
}

function makeRequest(body: unknown, secret = "sendillo-secret") {
  return new Request(
    `https://example.invalid/api/webhooks/sendillo/status?secret=${secret}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/webhooks/sendillo/status (integration)", () => {
  beforeEach(async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    delete process.env.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18164876899";
    process.env.SENDILLO_WEBHOOK_SECRET = "sendillo-secret";
    await resetTenantTables(supabase);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.MESSAGING_PROVIDER = ORIGINAL_ENV.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = ORIGINAL_ENV.SENDILLO_API_KEY;
    process.env.SENDILLO_FROM_NUMBER = ORIGINAL_ENV.SENDILLO_FROM_NUMBER;
    process.env.SENDILLO_WEBHOOK_SECRET = ORIGINAL_ENV.SENDILLO_WEBHOOK_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_ENV.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_ENV.NEXT_PUBLIC_SUPABASE_URL;
  });

  it("marks a matching row delivered and stamps delivered_at", async () => {
    await seedOutboundMessage({
      externalId: "snd_delivered_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });
    await waitForMessageStatus("snd_delivered_001", "sent");

    const response = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_delivered_001",
          to: "+18165550001",
          from: "+18164876899",
          deliveredAt: "2026-06-10T16:55:54.627Z",
        },
      }),
    );

    expect(response.status).toBe(200);

    const { data: row } = await supabase
      .from("messages")
      .select("status, delivered_at, sent_at")
      .eq("external_id", "snd_delivered_001")
      .single();
    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("event_type, processing_status, signature_verified")
      .eq("provider", "sendillo")
      .eq("event_type", "sms_status_delivered")
      .eq("external_id", "snd_delivered_001")
      .single();

    expect(row?.status).toBe("delivered");
    expect(new Date(row?.delivered_at ?? "").toISOString()).toBe(
      "2026-06-10T16:55:54.627Z",
    );
    expect(new Date(row?.sent_at ?? "").toISOString()).toBe(
      "2026-06-10T16:54:00.000Z",
    );
    expect(webhookEvent).toMatchObject({
      event_type: "sms_status_delivered",
      processing_status: "processed",
      signature_verified: true,
    });
  });

  it("marks a matching row sent and stamps sent_at", async () => {
    await seedOutboundMessage({
      externalId: "snd_sent_001",
      status: "queued",
      sentAt: null,
    });
    const queuedRow = await loadMessage("snd_sent_001");
    expect(queuedRow?.status).toBe("queued");

    const response = await POST(
      makeRequest({
        event: "message.sent",
        data: {
          messageId: "snd_sent_001",
          sentAt: "2026-06-10T16:54:00.000Z",
        },
      }),
    );

    expect(response.status).toBe(200);

    const row = await waitForMessageStatus("snd_sent_001", "sent");
    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("event_type, processing_status, signature_verified")
      .eq("provider", "sendillo")
      .eq("event_type", "sms_status_sent")
      .eq("external_id", "snd_sent_001")
      .single();

    expect(row?.status).toBe("sent");
    expect(new Date(row?.sent_at ?? "").toISOString()).toBe(
      "2026-06-10T16:54:00.000Z",
    );
    expect(webhookEvent).toMatchObject({
      event_type: "sms_status_sent",
      processing_status: "processed",
      signature_verified: true,
    });
  });

  it("marks a matching row failed and records the provider error", async () => {
    await seedOutboundMessage({
      externalId: "snd_failed_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });
    await waitForMessageStatus("snd_failed_001", "sent");

    const response = await POST(
      makeRequest({
        event: "message.failed",
        data: {
          messageId: "snd_failed_001",
          failedAt: "2026-06-10T16:56:30.000Z",
          reason: "Carrier rejected recipient",
        },
      }),
    );

    expect(response.status).toBe(200);

    const { data: row } = await supabase
      .from("messages")
      .select("status, failed_at, error_message")
      .eq("external_id", "snd_failed_001")
      .single();

    expect(row?.status).toBe("failed");
    expect(new Date(row?.failed_at ?? "").toISOString()).toBe(
      "2026-06-10T16:56:30.000Z",
    );
    expect(row?.error_message).toBe("Carrier rejected recipient");
  });

  it("rolls Sendillo delivery failures up only for Sandra-generated outbound messages", async () => {
    const aiConversationId = "11111111-1111-4111-8111-111111111111";
    const humanConversationId = "22222222-2222-4222-8222-222222222222";
    const aiThread = await seedThreadContext(aiConversationId, "+18165550111");
    const humanThread = await seedThreadContext(
      humanConversationId,
      "+18165550222",
    );
    const aiMessageId = await seedOutboundMessage({
      externalId: "snd_ai_failed_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
      contactId: aiThread.contactId,
      propertyId: aiThread.propertyId,
      conversationId: aiConversationId,
      metadata: { generated_by: "ai_responder_v1" },
    });
    await bindAiThreadMessage(aiConversationId, aiMessageId);
    await seedOutboundMessage({
      externalId: "snd_human_failed_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
      contactId: humanThread.contactId,
      propertyId: humanThread.propertyId,
      conversationId: humanConversationId,
      metadata: null,
    });

    const aiResponse = await POST(
      makeRequest({
        event: "message.failed",
        data: {
          messageId: "snd_ai_failed_001",
          failedAt: "2026-06-10T16:56:30.000Z",
          reason: "Carrier rejected recipient",
        },
      }),
    );
    const humanResponse = await POST(
      makeRequest({
        event: "message.failed",
        data: {
          messageId: "snd_human_failed_001",
          failedAt: "2026-06-10T16:56:35.000Z",
          reason: "Human message failed",
        },
      }),
    );

    expect(aiResponse.status).toBe(200);
    expect(humanResponse.status).toBe(200);

    const { data: aiState } = await supabase
      .from("message_threads")
      .select(
        "ai_responder_status, ai_last_delivery_status, ai_last_delivery_error",
      )
      .eq("conversation_id", aiConversationId)
      .single();
    const { data: humanState } = await supabase
      .from("message_threads")
      .select(
        "ai_responder_status, ai_last_delivery_status, ai_last_delivery_error",
      )
      .eq("conversation_id", humanConversationId)
      .single();

    expect(aiState).toMatchObject({
      ai_responder_status: "handled",
      ai_last_delivery_status: "failed",
      ai_last_delivery_error: "Carrier rejected recipient",
    });
    expect(humanState).toMatchObject({
      ai_responder_status: "handled",
      ai_last_delivery_status: null,
      ai_last_delivery_error: null,
    });
  });

  it("ignores stale Sendillo callbacks for an older Sandra-generated outbound", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const thread = await seedThreadContext(conversationId, "+18165550333");
    const oldMessageId = await seedOutboundMessage({
      externalId: "snd_ai_old_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
      contactId: thread.contactId,
      propertyId: thread.propertyId,
      conversationId,
      metadata: { generated_by: "ai_responder_v1" },
    });
    const currentMessageId = await seedOutboundMessage({
      externalId: "snd_ai_current_001",
      status: "sent",
      sentAt: "2026-06-10T16:55:00.000Z",
      contactId: thread.contactId,
      propertyId: thread.propertyId,
      conversationId,
      metadata: { generated_by: "ai_responder_v1" },
    });
    expect(oldMessageId).not.toBe(currentMessageId);
    await bindAiThreadMessage(conversationId, currentMessageId);

    const response = await POST(
      makeRequest({
        event: "message.failed",
        data: {
          messageId: "snd_ai_old_001",
          failedAt: "2026-06-10T16:56:30.000Z",
          reason: "Old callback should not roll up",
        },
      }),
    );

    expect(response.status).toBe(200);
    const { data: state } = await supabase
      .from("message_threads")
      .select(
        "ai_responder_message_id, ai_last_delivery_status, ai_last_delivery_error",
      )
      .eq("conversation_id", conversationId)
      .single();

    expect(state).toMatchObject({
      ai_responder_message_id: currentMessageId,
      ai_last_delivery_status: null,
      ai_last_delivery_error: null,
    });
  });

  it("does not overwrite a terminal failed row with a later delivered event", async () => {
    await seedOutboundMessage({
      externalId: "snd_failed_terminal_001",
      status: "failed",
      failedAt: "2026-06-10T16:56:30.000Z",
      errorMessage: "Carrier rejected recipient",
    });
    await waitForMessageStatus("snd_failed_terminal_001", "failed");

    const response = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_failed_terminal_001",
          deliveredAt: "2026-06-10T16:57:30.000Z",
        },
      }),
    );

    expect(response.status).toBe(200);

    const { data: row } = await supabase
      .from("messages")
      .select("status, failed_at, delivered_at, error_message")
      .eq("external_id", "snd_failed_terminal_001")
      .single();

    expect(row?.status).toBe("failed");
    expect(new Date(row?.failed_at ?? "").toISOString()).toBe(
      "2026-06-10T16:56:30.000Z",
    );
    expect(row?.delivered_at).toBeNull();
    expect(row?.error_message).toBe("Carrier rejected recipient");
  });

  it("returns 401 on a bad webhook secret", async () => {
    await seedOutboundMessage({ externalId: "snd_bad_secret_001" });
    await waitForMessageStatus("snd_bad_secret_001", "sent");

    const response = await POST(
      makeRequest(
        {
          event: "message.delivered",
          data: {
            messageId: "snd_bad_secret_001",
            deliveredAt: "2026-06-10T16:55:54.627Z",
          },
        },
        "wrong-secret",
      ),
    );

    expect(response.status).toBe(401);

    const { data: row } = await supabase
      .from("messages")
      .select("status, delivered_at")
      .eq("external_id", "snd_bad_secret_001")
      .single();

    expect(row).toMatchObject({
      status: "sent",
      delivered_at: null,
    });
  });

  it("returns 400 on malformed status payloads and does not reserve a webhook event", async () => {
    const response = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_bad_payload_001",
        },
      }),
    );

    expect(response.status).toBe(400);

    const { count: messageCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "snd_bad_payload_001");
    const { count: eventCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("provider", "sendillo")
      .eq("event_type", "sms_status_delivered")
      .eq("external_id", "snd_bad_payload_001");

    expect(messageCount).toBe(0);
    expect(eventCount).toBe(0);
  });

  it("ignores unknown message ids but still returns 200", async () => {
    const response = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_unknown_001",
          deliveredAt: "2026-06-10T16:55:54.627Z",
        },
      }),
    );

    expect(response.status).toBe(200);

    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true });
    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("processing_status, error_message")
      .eq("provider", "sendillo")
      .eq("event_type", "sms_status_delivered")
      .eq("external_id", "snd_unknown_001")
      .single();

    expect(count).toBe(0);
    expect(webhookEvent).toMatchObject({
      processing_status: "error",
      error_message: "message not found",
    });
  });

  it("reconciles a previously captured unknown event once the message row exists", async () => {
    const deliveredAt = "2026-06-10T16:55:54.627Z";
    const firstResponse = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_reconcile_001",
          deliveredAt,
        },
      }),
    );

    expect(firstResponse.status).toBe(200);

    await seedOutboundMessage({
      externalId: "snd_reconcile_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });

    await reconcileStoredStatusEvents(supabase, "sendillo", "snd_reconcile_001");

    const row = await waitForMessageStatus("snd_reconcile_001", "delivered");
    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("processing_status")
      .eq("provider", "sendillo")
      .eq("event_type", "sms_status_delivered")
      .eq("external_id", "snd_reconcile_001")
      .single();

    expect(row?.status).toBe("delivered");
    expect(new Date(row?.delivered_at ?? "").toISOString()).toBe(deliveredAt);
    expect(webhookEvent?.processing_status).toBe("processed");
  });

  it("accepts the [secret] route alias using the path secret with the shared verifier", async () => {
    await seedOutboundMessage({
      externalId: "snd_path_alias_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });
    await waitForMessageStatus("snd_path_alias_001", "sent");

    const response = await pathSecretRoute.POST(
      new Request("https://example.invalid/api/webhooks/sendillo/status/sendillo-secret", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event: "message.delivered",
          data: {
            messageId: "snd_path_alias_001",
            deliveredAt: "2026-06-10T16:55:54.627Z",
          },
        }),
      }),
      { params: Promise.resolve({ secret: "sendillo-secret" }) },
    );

    expect(response.status).toBe(200);

    const { data: row } = await supabase
      .from("messages")
      .select("status, delivered_at")
      .eq("external_id", "snd_path_alias_001")
      .single();

    expect(row?.status).toBe("delivered");
    expect(new Date(row?.delivered_at ?? "").toISOString()).toBe(
      "2026-06-10T16:55:54.627Z",
    );
  });

  it("is idempotent on replay and does not downgrade delivered rows back to sent", async () => {
    await seedOutboundMessage({
      externalId: "snd_replay_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });
    await waitForMessageStatus("snd_replay_001", "sent");

    const deliveredBody = {
      event: "message.delivered",
      data: {
        messageId: "snd_replay_001",
        deliveredAt: "2026-06-10T16:55:54.627Z",
      },
    };

    const first = await POST(makeRequest(deliveredBody));
    const replay = await POST(makeRequest(deliveredBody));
    const deliveredRow = await waitForMessageStatus(
      "snd_replay_001",
      "delivered",
    );
    const staleDelivered = await POST(
      makeRequest({
        event: "message.delivered",
        data: {
          messageId: "snd_replay_001",
          deliveredAt: "2026-06-10T16:50:00.000Z",
        },
      }),
    );
    const staleSent = await POST(
      makeRequest({
        event: "message.sent",
        data: {
          messageId: "snd_replay_001",
          sentAt: "2026-06-10T16:59:00.000Z",
        },
      }),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(deliveredRow?.status).toBe("delivered");
    expect(staleDelivered.status).toBe(200);
    expect(staleSent.status).toBe(200);

    const row = await waitForMessageStatus("snd_replay_001", "delivered");

    expect(row?.status).toBe("delivered");
    expect(new Date(row?.sent_at ?? "").toISOString()).toBe(
      "2026-06-10T16:54:00.000Z",
    );
    expect(new Date(row?.delivered_at ?? "").toISOString()).toBe(
      "2026-06-10T16:55:54.627Z",
    );
  });

  it("does not move sent_at backward on a stale sent replay", async () => {
    await seedOutboundMessage({
      externalId: "snd_stale_sent_001",
      status: "sent",
      sentAt: "2026-06-10T16:54:00.000Z",
    });
    await waitForMessageStatus("snd_stale_sent_001", "sent");

    const response = await POST(
      makeRequest({
        event: "message.sent",
        data: {
          messageId: "snd_stale_sent_001",
          sentAt: "2026-06-10T16:50:00.000Z",
        },
      }),
    );

    expect(response.status).toBe(200);

    const row = await waitForMessageStatus("snd_stale_sent_001", "sent");
    expect(new Date(row?.sent_at ?? "").toISOString()).toBe(
      "2026-06-10T16:54:00.000Z",
    );
  });

  it("does not move failed_at backward on a stale failed replay", async () => {
    await seedOutboundMessage({
      externalId: "snd_stale_failed_001",
      status: "failed",
      failedAt: "2026-06-10T16:56:30.000Z",
      errorMessage: "Carrier rejected recipient",
    });
    await waitForMessageStatus("snd_stale_failed_001", "failed");

    const response = await POST(
      makeRequest({
        event: "message.failed",
        data: {
          messageId: "snd_stale_failed_001",
          failedAt: "2026-06-10T16:50:00.000Z",
          reason: "Older failure",
        },
      }),
    );

    expect(response.status).toBe(200);

    const row = await waitForMessageStatus("snd_stale_failed_001", "failed");
    expect(new Date(row?.failed_at ?? "").toISOString()).toBe(
      "2026-06-10T16:56:30.000Z",
    );
    expect(row?.error_message).toBe("Carrier rejected recipient");
  });

});
