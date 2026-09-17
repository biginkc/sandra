import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordAiResponderDeliveryForThread } from "@/lib/messages/ai-responder-thread-state";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

import { applyMessageStatusEvent, reconcileStoredStatusEvents } from "./status-events";
import type { SmsStatusEvent } from "./types";

vi.mock("@/lib/messages/ai-responder-thread-state", () => ({
  recordAiResponderDeliveryForThread: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

type MessageRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  | "id"
  | "org_id"
  | "status"
  | "sent_at"
  | "delivered_at"
  | "failed_at"
  | "error_message"
  | "created_at"
  | "conversation_id"
  | "metadata"
>;

function makeSupabase(input: {
  messages: MessageRow[];
  updatedRows: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const filters: Array<[string, string, unknown]> = [];

  const supabase = {
    from(table: string) {
      if (table !== "messages") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: input.messages, error: null }),
                }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          const builder = {
            eq(column: string, value: unknown) {
              filters.push(["eq", column, value]);
              return builder;
            },
            neq(column: string, value: unknown) {
              filters.push(["neq", column, value]);
              return builder;
            },
            select: async () => ({ data: input.updatedRows, error: null }),
          };
          return builder;
        },
      };
    },
    // This represents the signed-in transport client. The rep-SMS callback
    // must use the separate service client instead.
    rpc: vi.fn(async () => ({
      data: null,
      error: { message: "authenticated callback is forbidden" },
    })),
  } as unknown as SupabaseClient<Database>;

  return { supabase, updates, filters };
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    org_id: "org-1",
    status: "sent",
    sent_at: "2026-06-24T15:00:00.000Z",
    delivered_at: null,
    failed_at: null,
    error_message: null,
    created_at: "2026-06-24T14:59:00.000Z",
    conversation_id: "conv-1",
    metadata: { generated_by: "ai_responder_v1" } as Json,
    ...overrides,
  };
}

describe("applyMessageStatusEvent", () => {
  beforeEach(() => {
    vi.mocked(recordAiResponderDeliveryForThread).mockClear();
    vi.mocked(createAdminClient).mockReset();
  });

  it("does not roll Sandra delivery state forward when guarded update matches zero rows", async () => {
    const { supabase } = makeSupabase({
      messages: [message()],
      updatedRows: [],
    });
    const event: SmsStatusEvent = {
      kind: "delivered",
      externalId: "snd-1",
      timestamp: new Date("2026-06-24T15:01:00.000Z"),
    };

    await expect(
      applyMessageStatusEvent(supabase, "sendillo", event),
    ).resolves.toBe("skipped");

    expect(recordAiResponderDeliveryForThread).not.toHaveBeenCalled();
  });

  it("rolls Sandra delivery state after the guarded message update succeeds", async () => {
    const row = message();
    const { supabase } = makeSupabase({
      messages: [row],
      updatedRows: [{ id: row.id }],
    });
    const event: SmsStatusEvent = {
      kind: "failed",
      externalId: "snd-1",
      timestamp: new Date("2026-06-24T15:01:00.000Z"),
      errorMessage: "Carrier rejected recipient",
    };

    await expect(
      applyMessageStatusEvent(supabase, "sendillo", event),
    ).resolves.toBe("updated");

    expect(recordAiResponderDeliveryForThread).toHaveBeenCalledWith(supabase, {
      conversationId: "conv-1",
      messageId: row.id,
      metadata: row.metadata,
      event,
    });
  });

  it("bridges a rep SMS delivery using only the stored sender account identity", async () => {
    const row = message({
      metadata: {
        repSms: {
          provider: "sendillo",
          providerAccountId: "account-from-message",
        },
      } as Json,
    });
    const rpc = vi.fn(async () => ({ data: { ok: true, matched: true }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as unknown as SupabaseClient<Database>);
    const { supabase } = makeSupabase({
      messages: [row],
      updatedRows: [{ id: row.id }],
    });
    const event = {
      kind: "delivered",
      externalId: "provider-message-1",
      timestamp: new Date("2026-06-24T15:01:00.000Z"),
      // A provider payload must never be able to override the stored
      // account identity used by the durable callback RPC.
      providerAccountId: "account-from-webhook-payload",
    } as SmsStatusEvent & { providerAccountId: string };

    await expect(applyMessageStatusEvent(supabase, "sendillo", event)).resolves.toBe("updated");

    expect(rpc).toHaveBeenCalledWith("fn_record_rep_sms_delivery", {
      p_provider: "sendillo",
      p_provider_account_id: "account-from-message",
      p_provider_message_id: "provider-message-1",
      p_state: "delivered",
      p_provider_status: "delivered",
      p_provider_error: null,
      p_metadata: {
        source: "sendillo_status_webhook",
        messageId: "msg-1",
        messageOrgId: "org-1",
        eventTimestamp: "2026-06-24T15:01:00.000Z",
      },
    });
  });

  it("does not call the rep bridge for ordinary messages or trust callback fields", async () => {
    const row = message({
      metadata: {
        generated_by: "ai_responder_v1",
        providerAccountId: "attacker-controlled-payload-value",
      } as Json,
    });
    const { supabase } = makeSupabase({
      messages: [row],
      updatedRows: [{ id: row.id }],
    });

    await applyMessageStatusEvent(supabase, "sendillo", {
      kind: "failed",
      externalId: "provider-message-2",
      timestamp: new Date("2026-06-24T15:01:00.000Z"),
      errorMessage: "provider failure",
    });

    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
  });

  it("keeps the webhook path successful when the optional bridge RPC is unavailable", async () => {
    const row = message({
      metadata: {
        repSms: {
          provider: "sendillo",
          providerAccountId: "account-from-message",
        },
      } as Json,
    });
    const rpc = vi.fn(async () => ({ data: null, error: { message: "function not installed" } }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as unknown as SupabaseClient<Database>);
    const { supabase } = makeSupabase({
      messages: [row],
      updatedRows: [{ id: row.id }],
    });

    await expect(
      applyMessageStatusEvent(supabase, "sendillo", {
        kind: "failed",
        externalId: "provider-message-3",
        timestamp: new Date("2026-06-24T15:01:00.000Z"),
      }),
    ).resolves.toBe("updated");
  });

  it("uses the service client when transport reconciliation runs as an authenticated user", async () => {
    const row = message({
      metadata: {
        repSms: {
          provider: "sendillo",
          providerAccountId: "account-from-message",
        },
      } as Json,
    });
    const adminRpc = vi.fn(async () => ({ data: { ok: true, matched: true }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc: adminRpc } as unknown as SupabaseClient<Database>);
    const { supabase } = makeSupabase({ messages: [row], updatedRows: [{ id: row.id }] });

    await expect(
      applyMessageStatusEvent(supabase, "sendillo", {
        kind: "delivered",
        externalId: "provider-message-authenticated-transport",
        timestamp: new Date("2026-06-24T15:01:00.000Z"),
      }),
    ).resolves.toBe("updated");

    expect(adminRpc).toHaveBeenCalledTimes(1);
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("does not lose a stored delivery transition when reconciliation uses an authenticated transport client", async () => {
    const row = message({
      metadata: {
        repSms: {
          provider: "sendillo",
          providerAccountId: "account-from-message",
        },
      } as Json,
    });
    const adminRpc = vi.fn(async () => ({ data: { ok: true, matched: true }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc: adminRpc } as unknown as SupabaseClient<Database>);
    const base = makeSupabase({ messages: [row], updatedRows: [{ id: row.id }] }).supabase;
    const baseFrom = (base as unknown as { from: (table: string) => unknown }).from;
    const transportRpc = (base as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    const webhookUpdates: Array<Record<string, unknown>> = [];
    const supabase = {
      ...base,
      from(table: string) {
        if (table !== "webhook_events") return baseFrom(table);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [{
                        event_type: "sms_status_delivered",
                        external_id: "provider-message-stored",
                        payload: {
                          kind: "delivered",
                          timestamp: "2026-06-24T15:01:00.000Z",
                        },
                      }],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            webhookUpdates.push(patch);
            const builder = {
              eq: () => builder,
              select: async () => ({ data: [{ id: "webhook-1" }], error: null }),
            };
            return builder;
          },
        };
      },
    } as unknown as SupabaseClient<Database>;

    await expect(
      reconcileStoredStatusEvents(supabase, "sendillo", "provider-message-stored"),
    ).resolves.toBeUndefined();

    expect(adminRpc).toHaveBeenCalledTimes(1);
    expect(transportRpc).not.toHaveBeenCalled();
    expect(webhookUpdates).toContainEqual({
      processing_status: "processed",
      processed_at: expect.any(String),
    });
  });

  it("promotes only the provider_unknown placeholder from failed to delivered", async () => {
    const row = message({
      status: "failed",
      failed_at: "2026-06-24T15:00:00.000Z",
      error_message: "Sendillo request timed out",
      metadata: {
        providerOutcome: "provider_unknown",
        repSms: {
          provider: "sendillo",
          providerAccountId: "account-from-message",
        },
      } as Json,
    });
    const adminRpc = vi.fn(async () => ({ data: { ok: true, matched: true }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc: adminRpc } as unknown as SupabaseClient<Database>);
    const { supabase, updates, filters } = makeSupabase({ messages: [row], updatedRows: [{ id: row.id }] });

    await expect(
      applyMessageStatusEvent(supabase, "sendillo", {
        kind: "delivered",
        externalId: "provider-message-unknown-placeholder",
        timestamp: new Date("2026-06-24T15:01:00.000Z"),
      }),
    ).resolves.toBe("updated");

    expect(updates[0]).toMatchObject({
      status: "delivered",
      failed_at: null,
      error_message: null,
      metadata: {
        repSms: {
          providerAccountId: "account-from-message",
        },
      },
    });
    expect(updates[0].metadata).not.toHaveProperty("providerOutcome");
    expect(filters).toContainEqual(["eq", "status", "failed"]);
    expect(filters).toContainEqual(["eq", "metadata->>providerOutcome", "provider_unknown"]);
  });
});
