import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordAiResponderDeliveryForThread } from "@/lib/messages/ai-responder-thread-state";
import type { Database, Json } from "@/lib/supabase/types";

import { applyMessageStatusEvent } from "./status-events";
import type { SmsStatusEvent } from "./types";

vi.mock("@/lib/messages/ai-responder-thread-state", () => ({
  recordAiResponderDeliveryForThread: vi.fn(async () => undefined),
}));

type MessageRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  | "id"
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
  } as unknown as SupabaseClient<Database>;

  return { supabase, updates, filters };
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
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
});
