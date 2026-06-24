import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

import {
  clearAiResponderThreadState,
  recordAiResponderDeliveryForThread,
  recordAiResponderOutcomeForThread,
} from "./ai-responder-thread-state";

type ThreadUpdate = Database["public"]["Tables"]["message_threads"]["Update"];

function makeSupabase(messages = new Map<string, { status: string; error_message: string | null }>()) {
  const threadUpdates: Array<{ conversationId: string; patch: ThreadUpdate }> = [];

  const supabase = {
    from(table: string) {
      if (table === "messages") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({
                data: messages.get(id) ?? null,
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "message_threads") {
        return {
          update: (patch: ThreadUpdate) => ({
            eq: (_column: string, conversationId: string) => {
              threadUpdates.push({ conversationId, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, threadUpdates };
}

describe("ai-responder-thread-state", () => {
  it("clears prior Sandra state for a new inbound conversation", async () => {
    const { supabase, threadUpdates } = makeSupabase();

    await clearAiResponderThreadState(supabase, "conv-1");

    expect(threadUpdates).toHaveLength(1);
    expect(threadUpdates[0]).toMatchObject({
      conversationId: "conv-1",
      patch: {
        ai_responder_status: null,
        ai_responder_reason: null,
        ai_responder_status_at: null,
        ai_last_delivery_status: null,
        ai_last_delivery_error: null,
      },
    });
  });

  it("records sent as handled with initial delivery state from the outbound message", async () => {
    const { supabase, threadUpdates } = makeSupabase(
      new Map([["msg-1", { status: "sent", error_message: null }]]),
    );

    await recordAiResponderOutcomeForThread(supabase, {
      conversationId: "conv-1",
      outcome: { outcome: "sent", messageId: "msg-1", confidence: 0.91 },
      completedAt: "2026-06-24T15:00:00.000Z",
    });

    expect(threadUpdates[0]).toMatchObject({
      conversationId: "conv-1",
      patch: {
        ai_responder_status: "handled",
        ai_responder_reason: "sent",
        ai_responder_status_at: "2026-06-24T15:00:00.000Z",
        ai_last_delivery_status: "sent",
        ai_last_delivery_error: null,
      },
    });
  });

  it.each([
    [{ outcome: "auto_closed" as const, reason: "model:not_interested" }],
    [{ outcome: "opted_out" as const, reason: "model:opt_out" }],
  ])("records %s as handled", async (outcome) => {
    const { supabase, threadUpdates } = makeSupabase();

    await recordAiResponderOutcomeForThread(supabase, {
      conversationId: "conv-1",
      outcome,
      completedAt: "2026-06-24T15:00:00.000Z",
    });

    expect(threadUpdates[0].patch).toMatchObject({
      ai_responder_status: "handled",
      ai_responder_reason: outcome.reason,
    });
  });

  it("records escalated as escalated and skips skipped outcomes", async () => {
    const { supabase, threadUpdates } = makeSupabase();

    await recordAiResponderOutcomeForThread(supabase, {
      conversationId: "conv-1",
      outcome: { outcome: "escalated", reason: "model:needs_human" },
      completedAt: "2026-06-24T15:00:00.000Z",
    });
    await recordAiResponderOutcomeForThread(supabase, {
      conversationId: "conv-1",
      outcome: { outcome: "skipped", reason: "already_terminal" },
      completedAt: "2026-06-24T15:01:00.000Z",
    });

    expect(threadUpdates).toHaveLength(1);
    expect(threadUpdates[0].patch).toMatchObject({
      ai_responder_status: "escalated",
      ai_responder_reason: "model:needs_human",
    });
  });

  it("records delivery state only for Sandra-generated outbound metadata", async () => {
    const { supabase, threadUpdates } = makeSupabase();

    await recordAiResponderDeliveryForThread(supabase, {
      conversationId: "conv-1",
      metadata: { generated_by: "ai_responder_v1" } as Json,
      event: {
        kind: "failed",
        externalId: "snd-1",
        timestamp: new Date("2026-06-24T15:02:00.000Z"),
        errorMessage: "Carrier rejected recipient",
      },
    });
    await recordAiResponderDeliveryForThread(supabase, {
      conversationId: "conv-2",
      metadata: null,
      event: {
        kind: "failed",
        externalId: "snd-2",
        timestamp: new Date("2026-06-24T15:03:00.000Z"),
      },
    });

    expect(threadUpdates).toHaveLength(1);
    expect(threadUpdates[0]).toMatchObject({
      conversationId: "conv-1",
      patch: {
        ai_last_delivery_status: "failed",
        ai_last_delivery_error: "Carrier rejected recipient",
      },
    });
  });
});
