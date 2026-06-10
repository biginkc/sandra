import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { listThreads } from "@/lib/messages/list-threads";
import { POST } from "./route";

// Directly invokes the App Router POST handler with synthetic Request
// objects — no network, no running server. The handler builds its own
// service-role Supabase client from the env (which
// vitest.integration.config.ts points at the test project). The mock
// messaging provider accepts signatures equal to "valid".

const supabase = createTestClient();
const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

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

const createdAuthUsers: string[] = [];
async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: `test-pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return data.user.id;
}

async function seedContact(
  phone: string,
  opts: { optIn?: boolean; phone2?: string | null; phone3?: string | null } = {},
) {
  const { data } = await supabase
    .from("contacts")
    .insert({
      first_name: "Inbound",
      last_name: "Test",
      phone_1: phone,
      phone_2: opts.phone2 ?? null,
      phone_3: opts.phone3 ?? null,
    })
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

async function seedPendingKeywordReplay(params: {
  contactId: string;
  phone: string;
  externalId: string;
  body: string;
  eventType: "opt_out" | "help_request";
  keyword: "stop" | "help" | "dnc";
}) {
  const sourceDetail = {
    externalId: params.externalId,
    from: params.phone,
    ...(params.keyword === "dnc" ? { keyword: "dnc" } : {}),
  };
  await supabase.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    provider: "mock",
    external_id: params.externalId,
    from_address: params.phone,
    to_address: "+18163706846",
    body: params.body,
    contact_id: params.contactId,
    metadata: { keyword: params.keyword },
  });
  await supabase.from("consent_events").insert({
    contact_id: params.contactId,
    channel: "sms",
    event_type: params.eventType,
    source: "mock_inbound_webhook",
    source_detail: sourceDetail,
  });
  await supabase.from("webhook_events").insert({
    provider: "mock",
    event_type: "sms_inbound",
    external_id: params.externalId,
    signature_verified: true,
    processing_status: "pending",
    payload: {
      externalId: params.externalId,
      from: params.phone,
      to: "+18163706846",
      body: params.body,
    },
  });
}

describe("POST /api/webhooks/dialpad/sms (integration)", () => {
  beforeEach(async () => {
    // Reuse the test Supabase project's service role key for the
    // handler. Env already has TEST_SUPABASE_SERVICE_ROLE_KEY; the
    // handler falls back to it when SUPABASE_SERVICE_ROLE_KEY is unset.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    process.env.SKIP_INTENT_GATE = "1";
    process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS ?? "";
    await resetTenantTables(supabase);
  });

  afterEach(async () => {
    process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
    for (const id of createdAuthUsers) {
      await supabase.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
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

  it("matches an inbound sender stored in phone_2 and links the only property", async () => {
    const contactId = await seedContact("+18165550111", {
      optIn: true,
      phone2: "+18165550112",
    });
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "12 Phone Two Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();

    const res = await POST(
      makeRequest({
        externalId: "msg_phone2_001",
        from: "+18165550112",
        to: "+18163706846",
        body: "Replying from my other number",
      }),
    );
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, metadata")
      .eq("external_id", "msg_phone2_001")
      .single();
    expect(message?.contact_id).toBe(contactId);
    expect(message?.property_id).toBe(property!.id);
    expect(message?.metadata).toMatchObject({
      routing: "matched_single_linked_property",
    });
  });

  it("disambiguates duplicate contact phones by recipient-number history", async () => {
    const sharedPhone = "+18165553333";
    const matchedContactId = await seedContact(sharedPhone, { optIn: true });
    await seedContact("+18165553334", { optIn: true, phone2: sharedPhone });

    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "44 Routed Reply Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: matchedContactId,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: sharedPhone,
      body: "Prior outbound anchor",
      contact_id: matchedContactId,
      property_id: property!.id,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_dupe_phone_001",
        from: sharedPhone,
        to: "+18163706846",
        body: "Reply to the known sender",
      }),
    );
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, metadata")
      .eq("external_id", "msg_dupe_phone_001")
      .single();
    expect(message?.contact_id).toBe(matchedContactId);
    expect(message?.property_id).toBe(property!.id);
    expect(message?.metadata).toMatchObject({
      routing: "matched_recipient_number",
    });
  });

  it("STOP keyword flips sms_opted_out + writes an opt_out consent event AND emits no notification (decision #2)", async () => {
    const contactId = await seedContact("+18165558888", { optIn: true });
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "1 Stop Thread Ln",
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
      from_address: "+18163706846",
      to_address: "+18165558888",
      body: "Reply STOP to unsubscribe.",
      contact_id: contactId,
      property_id: property!.id,
    });

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
    expect(events?.[0].source).toBe("mock_inbound_webhook");

    const { data: stopMessage } = await supabase
      .from("messages")
      .select("property_id")
      .eq("external_id", "msg_stop_001")
      .single();
    expect(stopMessage?.property_id).toBe(property!.id);

    // Feature 7 regression guard — STOP is silent.
    const { count: notifCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true });
    expect(notifCount).toBe(0);
  });

  it("HELP keyword logs help_request without mutating sms_opted_out AND emits no notification (decision #2)", async () => {
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

    // Feature 7 regression guard — HELP is silent.
    const { count: notifCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true });
    expect(notifCount).toBe(0);
  });

  it("STOP opts out every matching contact even when recipient-number history resolves one thread", async () => {
    const sharedPhone = "+18165559012";
    const firstContactId = await seedContact(sharedPhone, {
      optIn: true,
    });
    const secondContactId = await seedContact("+18165559013", {
      optIn: true,
      phone2: sharedPhone,
    });
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "12 Scoped Stop Way",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: firstContactId,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: sharedPhone,
      body: "Reply STOP to unsubscribe.",
      contact_id: firstContactId,
      property_id: property!.id,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_stop_ambiguous_001",
        from: sharedPhone,
        to: "+18163706846",
        body: "STOP",
      }),
    );
    expect(res.status).toBe(200);

    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, sms_opted_out")
      .in("id", [firstContactId, secondContactId])
      .order("id");
    expect(contacts).toEqual(
      [
        { id: firstContactId, sms_opted_out: true },
        { id: secondContactId, sms_opted_out: true },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const { data: events } = await supabase
      .from("consent_events")
      .select("contact_id, event_type")
      .in("contact_id", [firstContactId, secondContactId])
      .eq("event_type", "opt_out")
      .order("contact_id");
    expect(events).toEqual(
      [
        { contact_id: firstContactId, event_type: "opt_out" },
        { contact_id: secondContactId, event_type: "opt_out" },
      ].sort((left, right) => left.contact_id.localeCompare(right.contact_id)),
    );
  });

  it("STOP opts out every matching contact when the shared phone is ambiguous", async () => {
    const sharedPhone = "+18165559014";
    const firstContactId = await seedContact(sharedPhone, { optIn: true });
    const secondContactId = await seedContact("+18165559015", {
      optIn: true,
      phone2: sharedPhone,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_stop_all_matches_001",
        from: sharedPhone,
        to: "+18163706846",
        body: "STOP",
      }),
    );
    expect(res.status).toBe(200);

    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, sms_opted_out")
      .in("id", [firstContactId, secondContactId])
      .order("id");
    expect(contacts).toEqual(
      [
        { id: firstContactId, sms_opted_out: true },
        { id: secondContactId, sms_opted_out: true },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const { data: events } = await supabase
      .from("consent_events")
      .select("contact_id, event_type")
      .in("contact_id", [firstContactId, secondContactId])
      .eq("event_type", "opt_out")
      .order("contact_id");
    expect(events).toEqual(
      [
        { contact_id: firstContactId, event_type: "opt_out" },
        { contact_id: secondContactId, event_type: "opt_out" },
      ].sort((left, right) => left.contact_id.localeCompare(right.contact_id)),
    );
  });

  it("auto-qualifies the threaded prospect on first inbound reply", async () => {
    const phone = "+18165552600";
    const contactId = await seedContact(phone, { optIn: true });

    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "1 Auto-Qualify Ln",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    // Prior outbound to this contact threaded to the prospect property —
    // that's what the handler uses to resolve propertyId on the inbound.
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: phone,
      body: "Hi, are you the owner of 1 Auto-Qualify Ln?",
      contact_id: contactId,
      property_id: property!.id,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_autoq_001",
        from: phone,
        to: "+18163706846",
        body: "Yeah that's me — what's the offer?",
      }),
    );
    expect(res.status).toBe(200);

    const { data: after } = await supabase
      .from("properties")
      .select("status, qualified_at, qualified_by")
      .eq("id", property!.id)
      .single();
    expect(after?.status).toBe("new_lead");
    expect(after?.qualified_by).toBe("system:inbound_reply");
    expect(after?.qualified_at).not.toBeNull();
  });

  it("routes the inbound reply to the property that used the recipient number", async () => {
    const phone = "+18165552601";
    const contactId = await seedContact(phone, { optIn: true });

    const { data: propertyA } = await supabase
      .from("properties")
      .insert({
        address: "10 Alpha Way",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    const { data: propertyB } = await supabase
      .from("properties")
      .insert({
        address: "20 Bravo Way",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        from_address: "+18163706846",
        to_address: phone,
        body: "Property A intro",
        contact_id: contactId,
        property_id: propertyA!.id,
      },
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        from_address: "+18163706847",
        to_address: phone,
        body: "Property B intro",
        contact_id: contactId,
        property_id: propertyB!.id,
      },
    ]);

    const res = await POST(
      makeRequest({
        externalId: "msg_route_001",
        from: phone,
        to: "+18163706846",
        body: "This reply is for property A",
      }),
    );
    expect(res.status).toBe(200);

    const { data: inbound } = await supabase
      .from("messages")
      .select("property_id, conversation_id, metadata")
      .eq("external_id", "msg_route_001")
      .single();
    expect(inbound?.property_id).toBe(propertyA!.id);
    expect(inbound?.conversation_id).toBeTruthy();
    expect(inbound?.metadata).toMatchObject({
      routing: "matched_recipient_number",
    });

    const { data: propertyAMessages } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("property_id", propertyA!.id)
      .order("created_at", { ascending: true });
    expect(
      new Set(
        (propertyAMessages ?? [])
          .map((row) => row.conversation_id)
          .filter((value): value is string => typeof value === "string"),
      ).size,
    ).toBe(1);
  });

  it("auto-qualify is a no-op when the property is already past prospect", async () => {
    const phone = "+18165552700";
    const contactId = await seedContact(phone, { optIn: true });

    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "2 Already New Ln",
        state: "MO",
        status: "contacted",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: phone,
      body: "follow-up",
      contact_id: contactId,
      property_id: property!.id,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_autoq_noop_001",
        from: phone,
        to: "+18163706846",
        body: "another reply",
      }),
    );
    expect(res.status).toBe(200);

    const { data: after } = await supabase
      .from("properties")
      .select("status, qualified_at")
      .eq("id", property!.id)
      .single();
    // Status stays where it was; qualified_at was never stamped.
    expect(after?.status).toBe("contacted");
    expect(after?.qualified_at).toBeNull();
  });

  it("idempotent on retry — second delivery with same external_id does not double-insert (incl. notifications)", async () => {
    const phone = "+18165559111";
    const contactId = await seedContact(phone, { optIn: true });
    // Give it a property + prior outbound so the inbound threads to a
    // real propertyId — that's what triggers the notification dispatch.
    const assignee = await createAuthUser(
      `idempotent-assignee-${Date.now()}@test.invalid`,
    );
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "3 Idempotent Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
        assigned_user_id: assignee,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: phone,
      body: "initial",
      contact_id: contactId,
      property_id: property!.id,
    });

    const payload = {
      externalId: "msg_dup_001",
      from: phone,
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
    const { count: eventCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "msg_dup_001");
    expect(eventCount).toBe(1);
    // The message row is only written once per event because the
    // `continue` short-circuits downstream work on duplicate.
    expect(msgCount).toBe(1);

    // Feature 7 regression guard — notification fires exactly once
    // across the two deliveries (webhook_events dedup gates it).
    const { count: notifCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", assignee);
    expect(notifCount).toBe(1);
  });

  it("resumes downstream side effects when a retry finds a pending inbound row already inserted", async () => {
    const phone = "+18165559112";
    const contactId = await seedContact(phone, { optIn: true });
    const assignee = await createAuthUser(
      `idempotent-replay-${Date.now()}@test.invalid`,
    );
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "4 Replay Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
        assigned_user_id: assignee,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        provider: "mock",
        from_address: "+18163706846",
        to_address: phone,
        body: "initial",
        contact_id: contactId,
        property_id: property!.id,
      },
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        provider: "mock",
        external_id: "msg_dup_resume_001",
        from_address: phone,
        to_address: "+18163706846",
        body: "already inserted",
        contact_id: contactId,
        property_id: property!.id,
      },
    ]);
    await supabase.from("webhook_events").insert({
      provider: "mock",
      event_type: "sms_inbound",
      external_id: "msg_dup_resume_001",
      signature_verified: true,
      processing_status: "pending",
      payload: {
        externalId: "msg_dup_resume_001",
        from: phone,
        to: "+18163706846",
        body: "already inserted",
      },
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_dup_resume_001",
        from: phone,
        to: "+18163706846",
        body: "already inserted",
      }),
    );
    expect(res.status).toBe(200);

    const { count: notifCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", assignee);
    expect(notifCount).toBe(1);

    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("processing_status")
      .eq("provider", "mock")
      .eq("event_type", "sms_inbound")
      .eq("external_id", "msg_dup_resume_001")
      .single();
    expect(webhookEvent?.processing_status).toBe("processed");
  });

  it("does not duplicate owner notifications when a retry resumes after the notification already fired", async () => {
    const phone = "+18165559117";
    const contactId = await seedContact(phone, { optIn: true });
    const assignee = await createAuthUser(
      `idempotent-notif-${Date.now()}@test.invalid`,
    );
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "5 Replay Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
        assigned_user_id: assignee,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        provider: "mock",
        from_address: "+18163706846",
        to_address: phone,
        body: "initial",
        contact_id: contactId,
        property_id: property!.id,
      },
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        provider: "mock",
        external_id: "msg_dup_resume_notif_001",
        from_address: phone,
        to_address: "+18163706846",
        body: "already notified",
        contact_id: contactId,
        property_id: property!.id,
        metadata: {
          processing: {
            ownerNotificationSentAt: "2026-06-09T12:00:00.000Z",
          },
        },
      },
    ]);
    await supabase.from("notifications").insert({
      org_id: "00000000-0000-0000-0000-000000000bbb",
      user_id: assignee,
      event_type: "owner_message_added",
      entity_type: "message",
      entity_id: "55555555-5555-4555-8555-555555555555",
      title: "New SMS reply",
      body: "Replay Ln",
    });
    await supabase.from("webhook_events").insert({
      provider: "mock",
      event_type: "sms_inbound",
      external_id: "msg_dup_resume_notif_001",
      signature_verified: true,
      processing_status: "pending",
      payload: {
        externalId: "msg_dup_resume_notif_001",
        from: phone,
        to: "+18163706846",
        body: "already notified",
      },
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_dup_resume_notif_001",
        from: phone,
        to: "+18163706846",
        body: "already notified",
      }),
    );
    expect(res.status).toBe(200);

    const { count: notifCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", assignee)
      .eq("event_type", "owner_message_added");
    expect(notifCount).toBe(1);
  });

  it("uses the persisted inbound row's property when a replay resolves to different fresh thread context", async () => {
    const phone = "+18165559117";
    const contactId = await seedContact(phone, { optIn: true });
    const assigneeA = await createAuthUser(
      `persisted-prop-a-${Date.now()}@test.invalid`,
    );
    const assigneeB = await createAuthUser(
      `persisted-prop-b-${Date.now()}@test.invalid`,
    );

    const { data: propertyA } = await supabase
      .from("properties")
      .insert({
        address: "21 Persisted Replay Ln",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
        assigned_user_id: assigneeA,
      })
      .select("id")
      .single();
    const { data: propertyB } = await supabase
      .from("properties")
      .insert({
        address: "22 Fresh Resolve Ln",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
        assigned_user_id: assigneeB,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        provider: "mock",
        external_id: "msg_persisted_thread_001",
        from_address: phone,
        to_address: "+18163706840",
        body: "old persisted thread",
        contact_id: contactId,
        property_id: propertyA!.id,
      },
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        provider: "mock",
        external_id: "msg_persisted_thread_anchor",
        from_address: "+18163706846",
        to_address: phone,
        body: "latest property B outbound",
        contact_id: contactId,
        property_id: propertyB!.id,
      },
    ]);
    const res = await POST(
      makeRequest({
        externalId: "msg_persisted_thread_001",
        from: phone,
        to: "+18163706846",
        body: "replay should trust persisted property",
      }),
    );
    expect(res.status).toBe(200);

    const { data: notifs } = await supabase
      .from("notifications")
      .select("user_id, body")
      .eq("event_type", "owner_message_added");
    expect(notifs).toHaveLength(1);
    expect(notifs?.[0]).toMatchObject({
      user_id: assigneeA,
    });
    expect(notifs?.[0]?.body).toContain("21 Persisted Replay Ln");
    expect(notifs?.[0]?.body).not.toContain("22 Fresh Resolve Ln");
  });

  it("notifies admins and surfaces a propertyless thread when one contact maps to multiple recipient-number properties", async () => {
    const phone = "+18165559118";
    const contactId = await seedContact(phone, { optIn: true });
    const adminEmail = `triage-admin-${Date.now()}@bmhgroupkc.com`;
    const adminUserId = await createAuthUser(adminEmail);
    process.env.ADMIN_EMAILS = adminEmail;

    const { data: propertyA } = await supabase
      .from("properties")
      .insert({
        address: "31 Triage A Ln",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();
    const { data: propertyB } = await supabase
      .from("properties")
      .insert({
        address: "32 Triage B Ln",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contactId,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        provider: "mock",
        from_address: "+18163706846",
        to_address: phone,
        body: "thread a",
        contact_id: contactId,
        property_id: propertyA!.id,
      },
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        provider: "mock",
        from_address: "+18163706846",
        to_address: phone,
        body: "thread b",
        contact_id: contactId,
        property_id: propertyB!.id,
      },
    ]);

    const inboundBody = "which property is this about?";
    const res = await POST(
      makeRequest({
        externalId: "msg_triage_recipient_001",
        from: phone,
        to: "+18163706846",
        body: inboundBody,
      }),
    );
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, metadata")
      .eq("external_id", "msg_triage_recipient_001")
      .single();
    expect(message?.contact_id).toBe(contactId);
    expect(message?.property_id).toBeNull();
    expect(message?.metadata).toMatchObject({
      routing: "ambiguous_recipient_number",
      processing: {
        ownerNotificationSentAt: expect.any(String),
      },
    });

    const { data: notifs } = await supabase
      .from("notifications")
      .select("user_id, title, body")
      .eq("event_type", "owner_message_added")
      .eq("user_id", adminUserId);
    expect(notifs).toHaveLength(1);
    expect(notifs?.[0]?.title).toBe("New SMS reply needs property triage");
    expect(notifs?.[0]?.body).toContain(inboundBody);

    const threads = await listThreads(supabase, {});
    expect(
      threads.some(
        (thread) =>
          thread.contactId === contactId &&
          thread.propertyId === null &&
          thread.lastMessageBody === inboundBody,
      ),
    ).toBe(true);
  });

  it("notifies admins and surfaces a propertyless thread when a known contact has no linked property", async () => {
    const phone = "+18165559119";
    const contactId = await seedContact(phone, { optIn: true });
    const adminEmail = `triage-noproperty-${Date.now()}@bmhgroupkc.com`;
    const adminUserId = await createAuthUser(adminEmail);
    process.env.ADMIN_EMAILS = adminEmail;

    const inboundBody = "texting back with no property history";
    const res = await POST(
      makeRequest({
        externalId: "msg_triage_contact_only_001",
        from: phone,
        to: "+18163706846",
        body: inboundBody,
      }),
    );
    expect(res.status).toBe(200);

    const { data: message } = await supabase
      .from("messages")
      .select("contact_id, property_id, metadata")
      .eq("external_id", "msg_triage_contact_only_001")
      .single();
    expect(message?.contact_id).toBe(contactId);
    expect(message?.property_id).toBeNull();
    expect(message?.metadata).toMatchObject({
      routing: "matched_contact_without_property",
      processing: {
        ownerNotificationSentAt: expect.any(String),
      },
    });

    const { data: notifs } = await supabase
      .from("notifications")
      .select("user_id, title, body")
      .eq("event_type", "owner_message_added")
      .eq("user_id", adminUserId);
    expect(notifs).toHaveLength(1);
    expect(notifs?.[0]?.title).toBe("New SMS reply needs property triage");
    expect(notifs?.[0]?.body).toContain(inboundBody);

    const threads = await listThreads(supabase, {});
    expect(
      threads.some(
        (thread) =>
          thread.contactId === contactId &&
          thread.propertyId === null &&
          thread.lastMessageBody === inboundBody,
      ),
    ).toBe(true);
  });

  it("does not duplicate STOP consent events when replay resumes a pending keyword webhook", async () => {
    const phone = "+18165559113";
    const contactId = await seedContact(phone, { optIn: true });
    await seedPendingKeywordReplay({
      contactId,
      phone,
      externalId: "msg_stop_resume_001",
      body: "STOP",
      eventType: "opt_out",
      keyword: "stop",
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_stop_resume_001",
        from: phone,
        to: "+18163706846",
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

  it("acknowledges duplicate delivery while another worker is actively processing it", async () => {
    await supabase.from("webhook_events").insert({
      provider: "mock",
      event_type: "sms_inbound",
      external_id: "msg_inflight_001",
      signature_verified: true,
      processing_status: "processing",
      processing_started_at: new Date().toISOString(),
      payload: {
        externalId: "msg_inflight_001",
        from: "+18165559116",
        to: "+18163706846",
        body: "still processing",
      },
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_inflight_001",
        from: "+18165559116",
        to: "+18163706846",
        body: "still processing",
      }),
    );
    expect(res.status).toBe(200);

    const { count: messageCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "msg_inflight_001");
    expect(messageCount).toBe(0);

    const { data: webhookEvent } = await supabase
      .from("webhook_events")
      .select("processing_status")
      .eq("provider", "mock")
      .eq("event_type", "sms_inbound")
      .eq("external_id", "msg_inflight_001")
      .single();
    expect(webhookEvent?.processing_status).toBe("processing");
  });

  it("does not duplicate HELP consent events when replay resumes a pending keyword webhook", async () => {
    const phone = "+18165559114";
    const contactId = await seedContact(phone, { optIn: true });
    await seedPendingKeywordReplay({
      contactId,
      phone,
      externalId: "msg_help_resume_001",
      body: "HELP",
      eventType: "help_request",
      keyword: "help",
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_help_resume_001",
        from: phone,
        to: "+18163706846",
        body: "HELP",
      }),
    );
    expect(res.status).toBe(200);

    const { count: consentCount } = await supabase
      .from("consent_events")
      .select("*", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("event_type", "help_request");
    expect(consentCount).toBe(1);
  });

  it("does not duplicate DNC consent events when replay resumes a pending keyword webhook", async () => {
    const phone = "+18165559115";
    const contactId = await seedContact(phone, { optIn: true });
    await seedPendingKeywordReplay({
      contactId,
      phone,
      externalId: "msg_dnc_resume_001",
      body: "please do not contact me",
      eventType: "opt_out",
      keyword: "dnc",
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_dnc_resume_001",
        from: phone,
        to: "+18163706846",
        body: "please do not contact me",
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

  // --------------------------------------------------------------------------
  // Feature 7 — owner_message_added notification on regular inbound (test 18)
  // --------------------------------------------------------------------------
  it("fires owner_message_added notification for the assignee on a regular inbound reply", async () => {
    const phone = "+18165550018";
    const contactId = await seedContact(phone, { optIn: true });
    const assignee = await createAuthUser(
      `webhook-notif-${Date.now()}@test.invalid`,
    );
    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "18 Notify Ln",
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contactId,
        assigned_user_id: assignee,
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: "+18163706846",
      to_address: phone,
      body: "hi there",
      contact_id: contactId,
      property_id: property!.id,
    });

    const res = await POST(
      makeRequest({
        externalId: "msg_notif_001",
        from: phone,
        to: "+18163706846",
        body: "hey, let's talk",
      }),
    );
    expect(res.status).toBe(200);

    const { data: notifs } = await supabase
      .from("notifications")
      .select("user_id, event_type, entity_type, entity_id, read_at, body")
      .eq("user_id", assignee);
    expect(notifs).toHaveLength(1);
    expect(notifs![0]).toMatchObject({
      event_type: "owner_message_added",
      entity_type: "message",
      read_at: null,
    });
    expect(notifs![0].body).toContain("18 Notify Ln");
  });
});
