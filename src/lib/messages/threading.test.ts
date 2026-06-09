import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { ensureConversationIdForThread } from "./threading";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Minimal Supabase fake that forces the *fallback* branch inside
 * `ensureConversationIdForThread`:
 *   - `.rpc("ensure_sms_conversation_id", ...)` reports the function as absent
 *     (i.e. the Sendillo rollout's DB-owned thread registry has not shipped), and
 *   - the `messages` table has no pre-existing conversation row.
 *
 * That is the live production reality until the registry migration is
 * deployed — and it is exactly the state in which the split-thread race bites.
 * Just enough of the chain API to satisfy the fallback path.
 */
function makeFallbackSupabase(
  opts: { existingConversationId?: string | null } = {},
): SupabaseClient<Database> {
  const messagesBuilder: Record<string, unknown> = {};
  Object.assign(messagesBuilder, {
    select: () => messagesBuilder,
    update: () => messagesBuilder,
    eq: () => messagesBuilder,
    not: () => messagesBuilder,
    order: () => messagesBuilder,
    limit: () => messagesBuilder,
    // Terminal of the existing-conversation lookup.
    maybeSingle: () =>
      Promise.resolve({
        data: opts.existingConversationId
          ? { conversation_id: opts.existingConversationId }
          : null,
        error: null,
      }),
    // Terminal of the null-conversation backfill update.
    is: () => Promise.resolve({ error: null }),
  });

  return {
    rpc: () =>
      Promise.resolve({
        data: null,
        error: {
          message:
            "Could not find the function public.ensure_sms_conversation_id(p_contact_id, p_property_id) in the schema cache",
        },
      }),
    from: (table: string) => {
      if (table === "messages") return messagesBuilder;
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

const CONTACT = "11111111-1111-4111-8111-111111111111";
const PROPERTY = "22222222-2222-4222-8222-222222222222";
const OTHER_PROPERTY = "33333333-3333-4333-8333-333333333333";

describe("ensureConversationIdForThread — fallback (RPC / registry migration absent)", () => {
  it("reproduces the split-thread race: an independent first-send and first-reply must converge on ONE conversation id", async () => {
    // Model two SEPARATE serverless invocations — the outbound sender and the
    // inbound webhook — each resolving a thread id before the other's message
    // row is visible. Distinct client instances + sequential awaits release the
    // in-process lock between calls, so nothing but the id-generation strategy
    // can make them agree. A non-deterministic fallback diverges → two threads.
    const outbound = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT,
      PROPERTY,
    );
    const inbound = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT,
      PROPERTY,
    );

    expect(outbound).toMatch(UUID_RE);
    expect(inbound).toBe(outbound);
  });

  it("is stable for the same contact/property and distinct across different properties", async () => {
    const first = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT,
      PROPERTY,
    );
    const second = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT,
      PROPERTY,
    );
    const otherProperty = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT,
      OTHER_PROPERTY,
    );

    expect(second).toBe(first);
    expect(otherProperty).not.toBe(first);
  });

  it("prefers an already-persisted conversation id over minting a new one", async () => {
    const existing = "44444444-4444-4444-8444-444444444444";
    const resolved = await ensureConversationIdForThread(
      makeFallbackSupabase({ existingConversationId: existing }),
      CONTACT,
      PROPERTY,
    );

    expect(resolved).toBe(existing);
  });
});
