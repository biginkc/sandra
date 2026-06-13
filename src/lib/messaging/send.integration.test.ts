import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseQueuedMessage, sendSmsToContact } from "@/lib/messaging/send";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// MESSAGING_PROVIDER=mock comes from vitest.integration.config.ts — the
// real Dialpad adapter never gets loaded during these tests.

const supabase = createTestClient();
const ORIGINAL_ENV = {
  MESSAGING_PROVIDER: process.env.MESSAGING_PROVIDER,
  SENDILLO_API_KEY: process.env.SENDILLO_API_KEY,
  SENDILLO_FROM_NUMBER: process.env.SENDILLO_FROM_NUMBER,
};

async function seed(params: {
  phone?: string | null;
  state?: string;
  withConsent?: boolean;
}): Promise<{ contactId: string; propertyId: string }> {
  const phone1 = params.phone === undefined ? "+18165559999" : params.phone;
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: "Integration",
      last_name: "Test",
      phone_1: phone1,
      phone_1_type: phone1 ? "mobile" : "unknown",
    })
    .select("id")
    .single();
  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: "1 Integration Ln",
      state: params.state ?? "MO",
      homeowner_contact_id: contact!.id,
    })
    .select("id")
    .single();
  if (params.withConsent) {
    await recordConsentEvent(supabase, {
      contactId: contact!.id,
      channel: "sms",
      eventType: "opt_in_marketing_written",
      source: "integration-test",
    });
  }
  return { contactId: contact!.id, propertyId: property!.id };
}

describe("sendSmsToContact (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  afterEach(() => {
    process.env.MESSAGING_PROVIDER = ORIGINAL_ENV.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = ORIGINAL_ENV.SENDILLO_API_KEY;
    process.env.SENDILLO_FROM_NUMBER = ORIGINAL_ENV.SENDILLO_FROM_NUMBER;
  });

  it("happy path: marketing consent + business hours → message row sent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    try {
      const { contactId, propertyId } = await seed({ withConsent: true });

      const outcome = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "Hey — quick question about your property",
      });
      expect(outcome.status).toBe("sent");

      const { data: msg } = await supabase
        .from("messages")
        .select(
          "status, direction, external_id, body, contact_id, property_id, conversation_id",
        )
        .eq("contact_id", contactId)
        .single();
      expect(msg?.status).toBe("sent");
      expect(msg?.direction).toBe("outbound");
      expect(msg?.external_id).toMatch(/^mock_/);
      expect(msg?.property_id).toBe(propertyId);
      expect(msg?.conversation_id).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block when no consent event exists and quiet hours allow sending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    const { contactId, propertyId } = await seed({ withConsent: false });
    try {
      const outcome = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "hi",
      });
      expect(outcome.status).toBe("sent");

      const { data: rows } = await supabase
        .from("messages")
        .select("status, conversation_id")
        .eq("contact_id", contactId);
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.status).toBe("sent");
      expect(rows?.[0]?.conversation_id).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an explicit conversationId override when one is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    const { contactId, propertyId } = await seed({ withConsent: true });
    const conversationId = "45454545-4545-4454-8454-454545454545";
    try {
      const { data: property } = await supabase
        .from("properties")
        .select("org_id")
        .eq("id", propertyId)
        .single();
      await supabase.from("message_threads").upsert(
        {
          org_id: property!.org_id,
          channel: "sms",
          contact_id: contactId,
          property_id: propertyId,
          conversation_id: conversationId,
        },
        { onConflict: "channel,contact_id,property_id" },
      );

      const outcome = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        conversationId,
        body: "hi",
      });
      expect(outcome.status).toBe("sent");

      const { data: rows } = await supabase
        .from("messages")
        .select("conversation_id")
        .eq("contact_id", contactId);
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.conversation_id).toBe(conversationId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs the thread registry when an explicit conversationId override is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    const { contactId, propertyId } = await seed({ withConsent: true });
    const staleConversationId = "56565656-5656-4565-8565-565656565656";
    const activeConversationId = "67676767-6767-4676-8676-676767676767";
    try {
      const { data: property } = await supabase
        .from("properties")
        .select("org_id")
        .eq("id", propertyId)
        .single();

      await supabase.from("message_threads").upsert(
        {
          org_id: property!.org_id,
          channel: "sms",
          contact_id: contactId,
          property_id: propertyId,
          conversation_id: staleConversationId,
        },
        { onConflict: "channel,contact_id,property_id" },
      );
      await supabase.from("messages").insert({
        id: "67676767-6767-4676-8676-676767676760",
        channel: "sms",
        direction: "inbound",
        status: "received",
        property_id: propertyId,
        contact_id: contactId,
        conversation_id: activeConversationId,
        body: "active thread owner",
      });
      await supabase.from("messages").insert({
        id: "56565656-5656-4565-8565-565656565650",
        channel: "sms",
        direction: "inbound",
        status: "received",
        property_id: propertyId,
        contact_id: contactId,
        conversation_id: staleConversationId,
        body: "stale thread history",
      });

      const first = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        conversationId: activeConversationId,
        body: "hi",
      });
      expect(first.status).toBe("sent");
      if (first.status !== "sent") return;

      const { data: threadRow } = await supabase
        .from("message_threads")
        .select("conversation_id")
        .eq("channel", "sms")
        .eq("contact_id", contactId)
        .eq("property_id", propertyId)
        .single();
      expect(threadRow?.conversation_id).toBe(activeConversationId);

      const followUp = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "follow up",
      });
      expect(followUp.status).toBe("sent");
      if (followUp.status !== "sent") return;

      const { data: rows } = await supabase
        .from("messages")
        .select("conversation_id")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true });
      expect(rows).toHaveLength(4);
      expect(rows?.every((row) => row.conversation_id === activeConversationId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an explicit conversationId that already belongs to another thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    try {
      const current = await seed({
        phone: "+18165550001",
        withConsent: true,
      });
      const other = await seed({
        phone: "+18165550002",
        withConsent: true,
      });
      const otherOutcome = await sendSmsToContact(supabase, {
        contactId: other.contactId,
        propertyId: other.propertyId,
        body: "other thread",
      });
      expect(otherOutcome.status).toBe("sent");
      if (otherOutcome.status !== "sent") return;

      const { data: otherRow } = await supabase
        .from("messages")
        .select("conversation_id")
        .eq("id", otherOutcome.messageId)
        .single();

      const outcome = await sendSmsToContact(supabase, {
        contactId: current.contactId,
        propertyId: current.propertyId,
        conversationId: otherRow!.conversation_id!,
        body: "wrong thread",
      });

      expect(outcome).toEqual({
        status: "db_error",
        error: "conversation belongs to another thread",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an explicit conversationId that has no existing owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    try {
      const { contactId, propertyId } = await seed({
        phone: "+18165550003",
        withConsent: true,
      });
      const outcome = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        conversationId: "73737373-7373-4737-8737-737373737373",
        body: "wrong thread",
      });

      expect(outcome).toEqual({
        status: "db_error",
        error: "conversation has no existing owner",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks with no_consent when contact has opted out after opt-in", async () => {
    const { contactId, propertyId } = await seed({ withConsent: true });
    await recordConsentEvent(supabase, {
      contactId,
      channel: "sms",
      eventType: "opt_out",
      source: "integration-test-opt-out",
    });
    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "hi",
    });
    expect(outcome.status).toBe("blocked_no_consent");
    if (outcome.status === "blocked_no_consent") {
      expect(outcome.consentState).toBe("opted_out");
    }
  });

  it("blocks with no_phone when contact has no phone_1", async () => {
    const { contactId, propertyId } = await seed({
      phone: null,
      withConsent: true,
    });
    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "hi",
    });
    expect(outcome.status).toBe("blocked_no_phone");
  });

  it("blocks with quiet_hours when property has an unknown state", async () => {
    const { contactId, propertyId } = await seed({
      state: "ZZ",
      withConsent: true,
    });
    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "hi",
    });
    expect(outcome.status).toBe("blocked_quiet_hours");
    if (outcome.status === "blocked_quiet_hours") {
      expect(outcome.check.ok).toBe(false);
    }
  });

  it("queue path: writes status='queued' without a provider call, without consent check", async () => {
    // Deliberately no consent event — queue should STILL succeed,
    // because consent is re-checked at release time, not at queue time.
    const { contactId, propertyId } = await seed({ withConsent: false });

    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "this is queued, not sent",
      queueOnly: true,
    });
    expect(outcome.status).toBe("queued");
    if (outcome.status !== "queued") return;

    const { data: row } = await supabase
      .from("messages")
      .select("status, direction, external_id, sent_at, conversation_id")
      .eq("id", outcome.messageId)
      .single();
    expect(row?.status).toBe("queued");
    expect(row?.direction).toBe("outbound");
    expect(row?.external_id).toBeNull();
    expect(row?.sent_at).toBeNull();
    expect(row?.conversation_id).toBeTruthy();
  });

  it("reuses one conversation_id for repeated sends on the same contact/property thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    try {
      const { contactId, propertyId } = await seed({ withConsent: true });

      const first = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "first send",
      });
      expect(first.status).toBe("sent");

      const second = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "second send",
      });
      expect(second.status).toBe("sent");

      const { data: rows } = await supabase
        .from("messages")
        .select("conversation_id")
        .eq("contact_id", contactId)
        .eq("property_id", propertyId)
        .order("created_at", { ascending: true });
      expect(rows).toBeDefined();
      expect(
        new Set(
          (rows ?? [])
            .map((row) => row.conversation_id)
            .filter((value): value is string => typeof value === "string"),
        ).size,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release path: queued → sent, requires fresh consent check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));
    try {
      const { contactId, propertyId } = await seed({ withConsent: true });

      // Queue first.
      const queue = await sendSmsToContact(supabase, {
        contactId,
        propertyId,
        body: "queued then released",
        queueOnly: true,
      });
      expect(queue.status).toBe("queued");
      if (queue.status !== "queued") return;

      // Release.
      const release = await releaseQueuedMessage(supabase, queue.messageId);
      expect(release.status).toBe("sent");

      const { data: row } = await supabase
        .from("messages")
        .select("status, external_id")
        .eq("id", queue.messageId)
        .single();
      expect(row?.status).toBe("sent");
      expect(row?.external_id).toMatch(/^mock_/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks with blocked_landline when phone_1 is classified landline", async () => {
    const { contactId, propertyId } = await seed({ withConsent: true });
    await supabase
      .from("contacts")
      .update({ phone_1_type: "landline" })
      .eq("id", contactId);

    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "should never send",
    });
    expect(outcome.status).toBe("blocked_landline");

    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("release fails permanently when the queued destination was classified landline and promoted out of slot 1", async () => {
    const { contactId, propertyId } = await seed({ withConsent: true });
    const queue = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "queued before classification",
      queueOnly: true,
    });
    expect(queue.status).toBe("queued");
    if (queue.status !== "queued") return;

    // Classification lands between queue and release: the queued-to
    // number turns out to be a landline, and a known mobile gets
    // promoted into slot 1 (backfill promotion). The queued to_address
    // now matches slot 2, not slot 1 — release must still catch it.
    await supabase
      .from("contacts")
      .update({
        phone_1: "+18165550001",
        phone_1_type: "mobile",
        phone_2: "+18165559999",
        phone_2_type: "landline",
      })
      .eq("id", contactId);

    const release = await releaseQueuedMessage(supabase, queue.messageId);
    expect(release.status).toBe("blocked_landline");

    // Failed permanently — the auto-send tick must not retry it.
    const { data: row } = await supabase
      .from("messages")
      .select("status, error_message")
      .eq("id", queue.messageId)
      .single();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toMatch(/landline/i);
  });

  it("release blocks when consent was revoked between queue and release", async () => {
    const { contactId, propertyId } = await seed({ withConsent: true });
    const queue = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "queued while consented",
      queueOnly: true,
    });
    expect(queue.status).toBe("queued");
    if (queue.status !== "queued") return;

    // Revoke between queue and release.
    await recordConsentEvent(supabase, {
      contactId,
      channel: "sms",
      eventType: "opt_out",
      source: "integration-test-mid-queue-revoke",
    });

    const release = await releaseQueuedMessage(supabase, queue.messageId);
    expect(release.status).toBe("blocked_no_consent");

    // Row stays in queued state (we didn't flip it).
    const { data: row } = await supabase
      .from("messages")
      .select("status")
      .eq("id", queue.messageId)
      .single();
    expect(row?.status).toBe("queued");
  });

  it("release blocks when the queued row belongs to a different provider than the active one", async () => {
    process.env.MESSAGING_PROVIDER = "sendillo";
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18164876899";

    const { contactId, propertyId } = await seed({ withConsent: true });
    const { data: queued } = await supabase
      .from("messages")
      .insert({
        channel: "sms",
        direction: "outbound",
        status: "queued",
        provider: "mock",
        contact_id: contactId,
        property_id: propertyId,
        from_address: "+18163706846",
        to_address: "+18165559999",
        body: "provider mismatch",
      })
      .select("id")
      .single();

    const outcome = await releaseQueuedMessage(supabase, queued!.id);
    expect(outcome.status).toBe("db_error");
    if (outcome.status === "db_error") {
      expect(outcome.error).toMatch(/belongs to provider mock/i);
    }

    const { data: row } = await supabase
      .from("messages")
      .select("status, error_message")
      .eq("id", queued!.id)
      .single();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toMatch(/belongs to provider mock/i);
  });

  it("release blocks when a queued Sendillo row targets an obsolete sender number", async () => {
    process.env.MESSAGING_PROVIDER = "sendillo";
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18164876899";

    const { contactId, propertyId } = await seed({ withConsent: true });
    const { data: queued } = await supabase
      .from("messages")
      .insert({
        channel: "sms",
        direction: "outbound",
        status: "queued",
        provider: "sendillo",
        contact_id: contactId,
        property_id: propertyId,
        from_address: "+12073049295",
        to_address: "+18165559999",
        body: "old sender",
      })
      .select("id")
      .single();

    const outcome = await releaseQueuedMessage(supabase, queued!.id);
    expect(outcome.status).toBe("db_error");
    if (outcome.status === "db_error") {
      expect(outcome.error).toMatch(/no longer matches active Sendillo sender/i);
    }

    const { data: row } = await supabase
      .from("messages")
      .select("status, error_message")
      .eq("id", queued!.id)
      .single();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toMatch(/no longer matches active Sendillo sender/i);
  });

  it("release preserves queued metadata when the message is sent", async () => {
    const now = new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        hour12: false,
      }).format(now),
      10,
    );
    if (hour < 8 || hour >= 21) return;

    const { contactId, propertyId } = await seed({ withConsent: true });
    const queue = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "queued metadata survives release",
      queueOnly: true,
      metadata: {
        source: "send.integration.test",
        nested: { keep: true },
      },
    });
    expect(queue.status).toBe("queued");
    if (queue.status !== "queued") return;

    const release = await releaseQueuedMessage(supabase, queue.messageId);
    expect(release.status).toBe("sent");

    const { data: row } = await supabase
      .from("messages")
      .select("metadata")
      .eq("id", queue.messageId)
      .single();
    expect(row?.metadata).toMatchObject({
      source: "send.integration.test",
      nested: { keep: true },
      providerStatus: "sent",
    });
  });

  // --------------------------------------------------------------------------
  // Send-now contract — relied on by the SMS Cockpit's reply box. Cockpit
  // calls sendSmsToContact with queueOnly=false; these tests anchor that
  // path explicitly so a regression that breaks live-reply gets caught.
  // --------------------------------------------------------------------------
  it("send-now: explicit queueOnly=false fires the provider immediately, no queued row sits around", async () => {
    const now = new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        hour12: false,
      }).format(now),
      10,
    );
    if (hour < 8 || hour >= 21) return;
    const { contactId, propertyId } = await seed({ withConsent: true });

    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "live reply from cockpit",
      queueOnly: false,
    });
    expect(outcome.status).toBe("sent");

    const { data: rows } = await supabase
      .from("messages")
      .select("status")
      .eq("contact_id", contactId);
    expect(rows).toHaveLength(1);
    expect(rows![0].status).toBe("sent");
    // Specifically: no row in 'queued' state.
    expect(rows!.some((r) => r.status === "queued")).toBe(false);
  });

  it("send-now: consent + quiet-hours gates still apply with queueOnly=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T18:00:00Z"));

    // No consent no longer blocks unless the contact explicitly opted out.
    const a = await seed({ phone: "+18165550101", withConsent: false });
    try {
      const noConsent = await sendSmsToContact(supabase, {
        contactId: a.contactId,
        propertyId: a.propertyId,
        body: "should be allowed",
        queueOnly: false,
      });
      expect(noConsent.status).toBe("sent");

      // Unknown state → quiet-hours blocked even with explicit queueOnly: false.
      const b = await seed({
        phone: "+18165550102",
        state: "ZZ",
        withConsent: true,
      });
      const quietBlocked = await sendSmsToContact(supabase, {
        contactId: b.contactId,
        propertyId: b.propertyId,
        body: "should be blocked",
        queueOnly: false,
      });
      expect(quietBlocked.status).toBe("blocked_quiet_hours");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records provider_failed when the mock provider errors on FAIL prefix", async () => {
    // Same time-window gate as the happy path test.
    const now = new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        hour12: false,
      }).format(now),
      10,
    );
    if (hour < 8 || hour >= 21) return;

    const { contactId, propertyId } = await seed({ withConsent: true });
    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "FAIL: force the mock to reject",
    });
    expect(outcome.status).toBe("provider_failed");

    const { data: msg } = await supabase
      .from("messages")
      .select("status, error_message")
      .eq("contact_id", contactId)
      .single();
    expect(msg?.status).toBe("failed");
    expect(msg?.error_message).toMatch(/forced failure/i);
  });
});
