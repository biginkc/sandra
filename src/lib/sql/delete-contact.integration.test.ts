import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { Database } from "@/lib/supabase/types";

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
  const createdUserIds: string[] = [];

  beforeEach(async () => {
    await resetTenantTables(supabase);
    await seedTwoOrgs(supabase);
  });

  afterEach(async () => {
    for (const id of createdUserIds) {
      await supabase.auth.admin.deleteUser(id);
    }
    createdUserIds.length = 0;
  });

  async function createUserClient(orgId: string) {
    const user = await createOrgUser(supabase, {
      orgId,
      role: "member",
      email: `delete-contact-${orgId.slice(-3)}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`,
    });
    createdUserIds.push(user.userId);
    return clientForUser(user.jwt);
  }

  async function seedContact(orgId: string, firstName: string): Promise<string> {
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({ org_id: orgId, first_name: firstName, last_name: "Jones" })
      .select()
      .single();
    if (error || !contact) {
      throw new Error(`seedContact failed: ${error?.message ?? "no contact"}`);
    }
    return contact!.id;
  }

  it("deletes a same-org contact, nulls contact_id on messages, and redacts body with reason", async () => {
    const caller = await createUserClient(BMH_ORG_ID);
    const contactId = await seedContact(BMH_ORG_ID, "Pat");

    await supabase.from("messages").insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      direction: "outbound",
      body: "Hi Pat, quick question about your house",
      contact_id: contactId,
    });
    await supabase.from("messages").insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      direction: "inbound",
      body: "Reply from Pat",
      contact_id: contactId,
    });

    const reason = "TCPA opt-out (verified by Jarrad on 2026-04-21)";
    const { error } = await caller.rpc("delete_contact", {
      p_contact_id: contactId,
      p_reason: reason,
    });
    expect(error).toBeNull();

    const { data: contactAfter } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
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
    const caller = await createUserClient(BMH_ORG_ID);
    const contactId = await seedContact(BMH_ORG_ID, "Solo");

    const { error } = await caller.rpc("delete_contact", {
      p_contact_id: contactId,
      p_reason: "cleanup",
    });
    expect(error).toBeNull();

    const { data: after } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .maybeSingle();
    expect(after).toBeNull();
  });

  it("rejects unauthenticated callers", async () => {
    const contactId = await seedContact(BMH_ORG_ID, "Anon");
    const anon = createClient<Database>(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error } = await anon.rpc("delete_contact", {
      p_contact_id: contactId,
      p_reason: "blocked",
    });

    expect(error?.message.toLowerCase()).toMatch(
      /permission denied|authenticated user required/,
    );
    const { data: contactAfter } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .maybeSingle();
    expect(contactAfter?.id).toBe(contactId);
  });

  it("rejects authenticated callers from a different org", async () => {
    const caller = await createUserClient(TEST_ORG_B_ID);
    const contactId = await seedContact(BMH_ORG_ID, "Cross");

    const { error } = await caller.rpc("delete_contact", {
      p_contact_id: contactId,
      p_reason: "blocked",
    });

    expect(error?.message).toContain("active access required");
    const { data: contactAfter } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .maybeSingle();
    expect(contactAfter?.id).toBe(contactId);
  });

  it("rejects anon reset_tenant_tables RPC calls", async () => {
    const anon = createClient<Database>(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error } = await anon.rpc("reset_tenant_tables");

    expect(error?.message.toLowerCase()).toContain("permission denied");
  });
});
