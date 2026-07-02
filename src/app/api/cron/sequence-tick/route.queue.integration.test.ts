import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  getMockMessageLog,
  resetMockState,
} from "@/lib/messaging/providers/mock";
import {
  MOCK_SENDER_PRIMARY,
  seedSenderCatalog,
} from "@tests/integration/delivery";

import { DRAIN_BATCH_SIZE, runSequenceTick } from "./route";
import type { Json } from "@/lib/supabase/types";

const supabase = createTestClient();

const SAFE_NOW = new Date("2026-04-23T18:00:00Z");

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

type FakeQueryResult = {
  data: unknown[] | null;
  error: { message: string } | null;
};

function fakeQuery(result: FakeQueryResult) {
  const query = {
    select: () => query,
    eq: () => query,
    not: () => query,
    lte: () => query,
    order: () => query,
    limit: () => Promise.resolve(result),
  };
  return query;
}

async function seedLead(opts: {
  phone: string;
  state?: string;
  optOut?: boolean;
}): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: "Queue",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  await supabase.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: opts.optOut ? "opt_out" : "opt_in_marketing_written",
    source: "test-seed",
  });

  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: "1 Queue Ln",
      state: opts.state ?? "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (!property) throw new Error("property seed failed");

  return { propertyId: property.id, contactId: contact.id };
}

async function seedQueuedMessage(opts: {
  propertyId: string;
  contactId: string;
  toPhone: string;
  scheduledFor: Date | null;
  status?: string;
  body?: string;
  metadata?: Json;
  fromPhone?: string | null;
}): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: opts.status ?? "queued",
      provider: "mock",
      contact_id: opts.contactId,
      property_id: opts.propertyId,
      from_address:
        opts.fromPhone === undefined ? MOCK_SENDER_PRIMARY : opts.fromPhone,
      to_address: opts.toPhone,
      body: opts.body ?? "Queued test message",
      scheduled_for: opts.scheduledFor?.toISOString() ?? null,
      metadata: opts.metadata ?? null,
    })
    .select("id")
    .single();
  if (!data) throw new Error(`message seed failed: ${error?.message}`);
  return data.id;
}

describe("runSequenceTick — queue drain (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
    await seedSenderCatalog(supabase, await getOrgId(), [MOCK_SENDER_PRIMARY]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops cleanly when there are no queued messages due", async () => {
    const summary = await runSequenceTick(supabase);
    expect(summary.dueMessagesSelected).toBe(0);
    expect(summary.drainLimitHit).toBe(false);
    expect(summary.processed).toBe(0);
    expect(summary.drained).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("keeps the production default drain cap at 240 queued messages", () => {
    expect(DRAIN_BATCH_SIZE).toBe(240);
  });

  it("releases a queued message whose scheduled_for <= now", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550101",
    });
    const pastTime = new Date(SAFE_NOW.getTime() - 60 * 60_000);
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550101",
      scheduledFor: pastTime,
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.dueMessagesSelected).toBe(1);
    expect(summary.drained).toBe(1);

    const { data: msg } = await supabase
      .from("messages")
      .select("status")
      .eq("id", msgId)
      .single();
    expect(msg!.status).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(1);
    expect(getMockMessageLog()[0].to).toBe("+18165550101");
  });

  it("does not release a message whose scheduled_for is in the future", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550102",
    });
    const futureTime = new Date(SAFE_NOW.getTime() + 60 * 60_000);
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550102",
      scheduledFor: futureTime,
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.drained).toBe(0);

    const { data: msg } = await supabase
      .from("messages")
      .select("status")
      .eq("id", msgId)
      .single();
    expect(msg!.status).toBe("queued");
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("ignores already-sent messages — drain query only touches status='queued'", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550103",
    });
    const pastTime = new Date(SAFE_NOW.getTime() - 60 * 60_000);
    await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550103",
      scheduledFor: pastTime,
      status: "sent",
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.drained).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("does not send to opted-out contacts — drain terminal-fails the row", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550104",
      optOut: true,
    });
    const pastTime = new Date(SAFE_NOW.getTime() - 60 * 60_000);
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550104",
      scheduledFor: pastTime,
    });

    await runSequenceTick(supabase);

    // releaseQueuedMessage returns blocked_no_consent; the drain then
    // terminal-fails the row — it can never send, so leaving it queued
    // would poison queued counts and the oldest-first head forever.
    const { data: msg } = await supabase
      .from("messages")
      .select("status, error_message")
      .eq("id", msgId)
      .single();
    expect(msg!.status).toBe("failed");
    expect(msg!.error_message).toMatch(/opted out/i);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("caps the drain at the configured limit when more messages are due", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550105",
    });
    const pastTime = new Date(SAFE_NOW.getTime() - 60 * 60_000);

    // Each queued message needs a unique body so mock externalIds don't clash.
    for (let i = 0; i < 4; i++) {
      await seedQueuedMessage({
        propertyId,
        contactId,
        toPhone: "+18165550105",
        scheduledFor: pastTime,
        body: `Cap test message ${i}`,
      });
    }

    const summary = await runSequenceTick(supabase, { drainLimit: 3 });
    expect(summary.dueMessagesSelected).toBe(3);
    expect(summary.drainLimitHit).toBe(true);
    expect(summary.drained).toBe(3);
    expect(summary.budgetExhausted).toBe(false);

    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("status", "queued");
    expect(count).toBe(1);
  });

  it("fails the tick when the due queued message query errors", async () => {
    let messageQueries = 0;
    const failingSupabase = {
      from(table: string) {
        if (table === "sequence_enrollments") {
          return fakeQuery({ data: [], error: null });
        }
        messageQueries += 1;
        return messageQueries === 1
          ? fakeQuery({ data: [], error: null })
          : fakeQuery({
              data: null,
              error: { message: "messages query failed" },
            });
      },
    } as unknown as Parameters<typeof runSequenceTick>[0];

    await expect(runSequenceTick(failingSupabase)).rejects.toThrow(
      "fetch due queued messages failed: messages query failed",
    );
  });

  it("terminal-fails stale pending provider attempts without re-sending", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550116",
    });
    const stalePendingAt = new Date(SAFE_NOW.getTime() - 20 * 60_000);
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550116",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      status: "pending",
      metadata: {
        providerAttempt: {
          pendingAt: stalePendingAt.toISOString(),
          maxPendingMs: 15 * 60_000,
        },
      },
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.stalePendingFailed).toBe(1);
    expect(summary.drained).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: msg } = await supabase
      .from("messages")
      .select("status, failed_at, error_message, metadata")
      .eq("id", msgId)
      .single();
    expect(msg?.status).toBe("failed");
    expect(new Date(msg!.failed_at!).getTime()).toBe(SAFE_NOW.getTime());
    expect(msg?.error_message).toMatch(/failed without re-sending/i);
    expect(msg?.metadata).toMatchObject({
      providerAttempt: {
        terminal: true,
        recoveryReason: "stale_pending_provider_attempt",
      },
    });
  });

  it("recovers stale stamped pending rows even when many fresh rows exist", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550118",
    });
    const freshPendingAt = new Date(SAFE_NOW.getTime() - 5 * 60_000);
    const stalePendingAt = new Date(SAFE_NOW.getTime() - 20 * 60_000);
    const rows = Array.from({ length: DRAIN_BATCH_SIZE }, (_, i) => ({
      channel: "sms",
      direction: "outbound",
      status: "pending",
      provider: "mock",
      contact_id: contactId,
      property_id: propertyId,
      to_address: "+18165550118",
      body: `fresh pending ${i}`,
      scheduled_for: new Date(SAFE_NOW.getTime() - 60 * 60_000).toISOString(),
      metadata: {
        providerAttempt: {
          pendingAt: freshPendingAt.toISOString(),
          maxPendingMs: 15 * 60_000,
        },
      },
    }));
    const { error: bulkError } = await supabase.from("messages").insert(rows);
    if (bulkError) throw new Error(`fresh pending seed failed: ${bulkError.message}`);
    const staleId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550118",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      status: "pending",
      body: "stale pending behind fresh page",
      metadata: {
        providerAttempt: {
          pendingAt: stalePendingAt.toISOString(),
          maxPendingMs: 15 * 60_000,
        },
      },
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.stalePendingFailed).toBe(1);

    const { data: stale } = await supabase
      .from("messages")
      .select("status")
      .eq("id", staleId)
      .single();
    expect(stale?.status).toBe("failed");
  });

  it("leaves fresh or unstamped pending rows alone", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550117",
    });
    await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550117",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      status: "pending",
      metadata: {
        providerAttempt: {
          pendingAt: new Date(SAFE_NOW.getTime() - 5 * 60_000).toISOString(),
          maxPendingMs: 15 * 60_000,
        },
      },
    });
    await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550117",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      status: "pending",
      metadata: { legacy: true },
      body: "legacy unstamped pending",
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.stalePendingFailed).toBe(0);

    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    expect(count).toBe(2);
  });

  it("stops draining when the time budget is exhausted and leaves the rest queued", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550106",
    });
    const pastTime = new Date(SAFE_NOW.getTime() - 60 * 60_000);
    for (let i = 0; i < 2; i++) {
      await seedQueuedMessage({
        propertyId,
        contactId,
        toPhone: "+18165550106",
        scheduledFor: pastTime,
        body: `Budget test message ${i}`,
      });
    }

    // budgetMs: 0 → the guard trips before any enrollment or release work.
    const summary = await runSequenceTick(supabase, { budgetMs: 0 });
    expect(summary.budgetExhausted).toBe(true);
    expect(summary.drained).toBe(0);
    expect(summary.processed).toBe(0);

    // Nothing sent, nothing stranded mid-flight — all rows still queued.
    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("status", "queued");
    expect(count).toBe(2);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("defers blocked head-of-queue rows so eligible messages behind them still release", async () => {
    // Oldest due row: opted-out contact → release blocks, row stays queued.
    const blockedLead = await seedLead({
      phone: "+18165550107",
      optOut: true,
    });
    const blockedId = await seedQueuedMessage({
      propertyId: blockedLead.propertyId,
      contactId: blockedLead.contactId,
      toPhone: "+18165550107",
      scheduledFor: new Date(SAFE_NOW.getTime() - 2 * 60 * 60_000),
      body: "Starvation blocked head",
    });

    // Newer due row: eligible contact.
    const okLead = await seedLead({ phone: "+18165550108" });
    await seedQueuedMessage({
      propertyId: okLead.propertyId,
      contactId: okLead.contactId,
      toPhone: "+18165550108",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      body: "Starvation eligible tail",
    });

    // drainLimit 1 models the cap being fully consumed by the blocked
    // head. Tick 1 only reaches the opted-out row: nothing sends, and
    // the row is terminal-failed so it stops pinning the head slot.
    const tick1 = await runSequenceTick(supabase, { drainLimit: 1 });
    expect(tick1.drained).toBe(0);
    expect(tick1.drainOutcomes.blocked_terminal_dispo).toBe(1);

    const { data: blocked } = await supabase
      .from("messages")
      .select("status")
      .eq("id", blockedId)
      .single();
    expect(blocked!.status).toBe("failed");

    // Tick 2's oldest-first head slot is now free — the eligible row sends.
    // Pre-fix this re-selected the same blocked row forever (starvation).
    const tick2 = await runSequenceTick(supabase, { drainLimit: 1 });
    expect(tick2.drained).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect(getMockMessageLog()[0].to).toBe("+18165550108");
  });

  it("defers quiet-hours-blocked rows out of the due-window (still queued, later scheduled_for)", async () => {
    // 08:00Z = 3:00am Central — inside TCPA quiet hours for MO.
    const QUIET_NOW = new Date("2026-04-23T08:00:00Z");
    vi.setSystemTime(QUIET_NOW);

    const { propertyId, contactId } = await seedLead({
      phone: "+18165550109",
      state: "MO",
    });
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550109",
      scheduledFor: new Date(QUIET_NOW.getTime() - 60 * 60_000),
      body: "Quiet hours defer test",
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.drained).toBe(0);
    expect(summary.drainOutcomes.blocked_quiet_hours).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);

    // Still queued — quiet-hours rows become sendable later — but pushed
    // out of the due-window so they stop occupying oldest-first slots.
    const { data: msg } = await supabase
      .from("messages")
      .select("status, scheduled_for")
      .eq("id", msgId)
      .single();
    expect(msg!.status).toBe("queued");
    expect(new Date(msg!.scheduled_for!).getTime()).toBeGreaterThan(
      QUIET_NOW.getTime(),
    );
  });

  it("defers transient provider failures without terminal-failing queued rows", async () => {
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550110",
    });
    const msgId = await seedQueuedMessage({
      propertyId,
      contactId,
      toPhone: "+18165550110",
      scheduledFor: new Date(SAFE_NOW.getTime() - 60 * 60_000),
      body: "FAIL-RATE_LIMIT cron defer",
    });

    const summary = await runSequenceTick(supabase);
    expect(summary.dueMessagesSelected).toBe(1);
    expect(summary.drained).toBe(0);
    expect(summary.drainOutcomes.provider_deferred).toBe(1);

    const { data: msg } = await supabase
      .from("messages")
      .select("status, scheduled_for, failed_at, metadata")
      .eq("id", msgId)
      .single();
    expect(msg!.status).toBe("queued");
    expect(msg!.failed_at).toBeNull();
    expect(new Date(msg!.scheduled_for!).getTime()).toBeGreaterThan(
      SAFE_NOW.getTime(),
    );
    expect(msg!.metadata).toMatchObject({
      providerRetry: {
        attempts: 1,
        transient: true,
      },
    });
  });
});
