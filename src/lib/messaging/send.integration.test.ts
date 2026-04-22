import { beforeEach, describe, expect, it } from "vitest";

import { sendSmsToContact } from "@/lib/messaging/send";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// MESSAGING_PROVIDER=mock comes from vitest.integration.config.ts — the
// real Dialpad adapter never gets loaded during these tests.

const supabase = createTestClient();

async function seed(params: {
  phone?: string | null;
  state?: string;
  withConsent?: boolean;
}): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: "Integration",
      last_name: "Test",
      phone_1: params.phone === undefined ? "+18165559999" : params.phone,
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

  it("happy path: marketing consent + business hours → message row sent", async () => {
    // Pin a time inside the send window by letting the wall clock
    // decide. Test skips itself outside business hours to stay
    // deterministic even when run at 2am. (CI will be set to a fixed
    // zone later; for now local-dev runs may see this skip.)
    const now = new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        hour12: false,
      }).format(now),
      10,
    );
    if (hour < 8 || hour >= 21) {
      // eslint-disable-next-line no-console
      console.warn("sendSmsToContact happy-path test skipped — outside 8a–9p CT");
      return;
    }
    const { contactId, propertyId } = await seed({ withConsent: true });

    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "Hey — quick question about your property",
    });
    expect(outcome.status).toBe("sent");

    const { data: msg } = await supabase
      .from("messages")
      .select("status, direction, external_id, body, contact_id, property_id")
      .eq("contact_id", contactId)
      .single();
    expect(msg?.status).toBe("sent");
    expect(msg?.direction).toBe("outbound");
    expect(msg?.external_id).toMatch(/^mock_/);
    expect(msg?.property_id).toBe(propertyId);
  });

  it("blocks with no_consent when no consent event exists", async () => {
    const { contactId, propertyId } = await seed({ withConsent: false });
    const outcome = await sendSmsToContact(supabase, {
      contactId,
      propertyId,
      body: "hi",
    });
    expect(outcome.status).toBe("blocked_no_consent");
    if (outcome.status === "blocked_no_consent") {
      expect(outcome.consentState).toBe("no_consent");
    }

    // Nothing persisted.
    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
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
