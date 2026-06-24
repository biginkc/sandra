import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { listUnknownSenders } from "./list-unknown-senders";

const supabase = createTestClient();

async function seedUnknownInbound(opts: {
  fromAddress: string;
  body: string;
  createdAtOffsetMin?: number;
  dismissed?: boolean;
}): Promise<string> {
  const offsetMs = (opts.createdAtOffsetMin ?? 0) * 60_000;
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: opts.fromAddress,
      to_address: "+18162804181",
      body: opts.body,
      created_at: new Date(Date.now() + offsetMs).toISOString(),
      dismissed_at: opts.dismissed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

describe("listUnknownSenders (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  // Test case #38
  it("returns only rows where contact_id IS NULL AND dismissed_at IS NULL", async () => {
    // Active unmatched inbound — should appear.
    await seedUnknownInbound({
      fromAddress: "+18165558001",
      body: "active unknown",
    });
    // Dismissed unmatched inbound — should NOT appear.
    await seedUnknownInbound({
      fromAddress: "+18165558002",
      body: "dismissed unknown",
      dismissed: true,
    });
    // Matched inbound — should NOT appear (we'll cheat by attaching to a contact).
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Matched",
        last_name: "Already",
        phone_1: "+18165558003",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: contact!.id,
      property_id: null,
      from_address: "+18165558003",
      to_address: "+18162804181",
      body: "this is matched",
    });

    const senders = await listUnknownSenders(supabase, {});

    expect(senders).toHaveLength(1);
    expect(senders[0].fromAddress).toBe("+18165558001");
    expect(senders[0].latestBody).toBe("active unknown");
  });

  // Test case #39
  it("collapses multiple messages from same from_address to one row with count + latest preview", async () => {
    await seedUnknownInbound({
      fromAddress: "+18165558010",
      body: "first message",
      createdAtOffsetMin: -120,
    });
    await seedUnknownInbound({
      fromAddress: "+18165558010",
      body: "second message",
      createdAtOffsetMin: -60,
    });
    await seedUnknownInbound({
      fromAddress: "+18165558010",
      body: "third (latest) message",
      createdAtOffsetMin: -10,
    });

    // A different sender to make sure grouping is by from_address, not global.
    await seedUnknownInbound({
      fromAddress: "+18165558011",
      body: "different sender",
      createdAtOffsetMin: -30,
    });

    const senders = await listUnknownSenders(supabase, {});

    const ten = senders.find((s) => s.fromAddress === "+18165558010");
    expect(ten).toBeDefined();
    expect(ten!.messageCount).toBe(3);
    expect(ten!.latestBody).toBe("third (latest) message");

    const eleven = senders.find((s) => s.fromAddress === "+18165558011");
    expect(eleven).toBeDefined();
    expect(eleven!.messageCount).toBe(1);
  });

  it("sorts results by most recent activity descending", async () => {
    await seedUnknownInbound({
      fromAddress: "+18165558020",
      body: "old sender",
      createdAtOffsetMin: -180,
    });
    await seedUnknownInbound({
      fromAddress: "+18165558021",
      body: "new sender",
      createdAtOffsetMin: -10,
    });

    const senders = await listUnknownSenders(supabase, {});
    expect(senders[0].fromAddress).toBe("+18165558021");
    expect(senders[1].fromAddress).toBe("+18165558020");
  });

  it("includesDismissed: true also returns dismissed rows", async () => {
    await seedUnknownInbound({
      fromAddress: "+18165558030",
      body: "active",
    });
    await seedUnknownInbound({
      fromAddress: "+18165558031",
      body: "dismissed",
      dismissed: true,
    });

    const active = await listUnknownSenders(supabase, {});
    expect(active.map((s) => s.fromAddress)).toEqual(["+18165558030"]);

    const all = await listUnknownSenders(supabase, { includeDismissed: true });
    expect(all.map((s) => s.fromAddress).sort()).toEqual([
      "+18165558030",
      "+18165558031",
    ]);
    const dismissedRow = all.find((s) => s.fromAddress === "+18165558031");
    expect(dismissedRow!.isDismissed).toBe(true);
  });

  it("does not return known-contact propertyless conversations", async () => {
    await seedUnknownInbound({
      fromAddress: "+18165558040",
      body: "active unknown",
    });
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Known",
        last_name: "Propertyless",
        phone_1: "+18165558041",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: contact!.id,
      property_id: null,
      from_address: "+18165558041",
      to_address: "+18162804181",
      body: "known contact, no property yet",
    });

    const senders = await listUnknownSenders(supabase, {});

    expect(senders.map((sender) => sender.fromAddress)).toEqual([
      "+18165558040",
    ]);
  });
});
