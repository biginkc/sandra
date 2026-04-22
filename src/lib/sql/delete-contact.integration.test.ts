import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

/**
 * Covers the `delete_contact(p_contact_id, p_reason)` SQL function.
 * Three outcomes: the contact row is deleted, any messages linked to
 * that contact have their contact_id nulled, and the message body is
 * replaced with a redacted placeholder that embeds the reason. Required
 * for the Risk #16 "cascading PII delete" use case (TCPA "forget me"
 * requests, accidental skip-trace hits, etc.).
 */

describe("delete_contact() (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("deletes the contact, nulls contact_id on messages, redacts body with reason", async () => {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({ first_name: "Pat", last_name: "Jones", phone_1: "+18165551111" })
      .select()
      .single();

    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      body: "Hi Pat, quick question about your house",
      contact_id: contact!.id,
    });
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      body: "Reply from Pat",
      contact_id: contact!.id,
    });

    const reason = "TCPA opt-out (verified by Jarrad on 2026-04-21)";
    const { error } = await supabase.rpc("delete_contact", {
      p_contact_id: contact!.id,
      p_reason: reason,
    });
    expect(error).toBeNull();

    const { data: contactAfter } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contact!.id)
      .maybeSingle();
    expect(contactAfter).toBeNull();

    const { data: messages } = await supabase
      .from("messages")
      .select("contact_id, body");
    expect(messages).toHaveLength(2);
    for (const m of messages ?? []) {
      expect(m.contact_id).toBeNull();
      expect(m.body).toBe(`[contact deleted: ${reason}]`);
    }
  });

  it("is a no-op when no messages reference the contact", async () => {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({ first_name: "Solo", last_name: "Contact" })
      .select()
      .single();

    const { error } = await supabase.rpc("delete_contact", {
      p_contact_id: contact!.id,
      p_reason: "cleanup",
    });
    expect(error).toBeNull();

    const { data: after } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contact!.id)
      .maybeSingle();
    expect(after).toBeNull();
  });
});
