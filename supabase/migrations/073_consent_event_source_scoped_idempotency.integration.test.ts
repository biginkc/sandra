import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedContact(): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      first_name: "Consent",
      last_name: "Scope",
      phone_1: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
}

describe("Migration 073 — consent source-scoped idempotency", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("allows the same external id to be recorded once per provider/source", async () => {
    const contactId = await seedContact();
    const sharedExternalId = "shared-provider-message-id";

    const first = await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_out",
      source: "dialpad_inbound_webhook",
      source_detail: { externalId: sharedExternalId },
    });
    const second = await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_out",
      source: "sendillo_inbound_webhook",
      source_detail: { externalId: sharedExternalId },
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const { data, error } = await supabase
      .from("consent_events")
      .select("source, source_external_id")
      .eq("contact_id", contactId)
      .eq("event_type", "opt_out")
      .order("source");
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        source: "dialpad_inbound_webhook",
        source_external_id: sharedExternalId,
      },
      {
        source: "sendillo_inbound_webhook",
        source_external_id: sharedExternalId,
      },
    ]);
  });

  it("still rejects a replay from the same provider/source", async () => {
    const contactId = await seedContact();
    const sharedExternalId = "same-provider-replay-id";

    const first = await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "help_request",
      source: "sendillo_inbound_webhook",
      source_detail: { externalId: sharedExternalId },
    });
    const replay = await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "help_request",
      source: "sendillo_inbound_webhook",
      source_detail: { externalId: sharedExternalId },
    });

    expect(first.error).toBeNull();
    expect(replay.error?.code).toBe("23505");
    expect(replay.error?.message).toContain(
      "idx_consent_events_external_idempotency",
    );
  });
});
