import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import {
  canonicalizeThreadId,
  ensureConversationIdForThread,
} from "./threading";

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
  opts: {
    existingConversationId?: string | null;
    existingConversationIds?: string[];
    rpcErrorCode?: string;
    rpcErrorMessage?: string;
    /** Whether the contacts-table existence check finds the contact.
     *  Defaults to true. */
    contactExists?: boolean;
  } = {},
): SupabaseClient<Database> {
  let existingOrderAscending = false;
  const messagesBuilder: Record<string, unknown> = {};
  Object.assign(messagesBuilder, {
    select: () => messagesBuilder,
    update: () => messagesBuilder,
    eq: () => messagesBuilder,
    not: () => messagesBuilder,
    order: (_column: string, opts?: { ascending?: boolean }) => {
      existingOrderAscending = opts?.ascending ?? false;
      return messagesBuilder;
    },
    limit: () => messagesBuilder,
    // Terminal of the existing-conversation lookup.
    maybeSingle: () =>
      Promise.resolve({
        data:
          opts.existingConversationIds && opts.existingConversationIds.length > 0
            ? {
                conversation_id: existingOrderAscending
                  ? opts.existingConversationIds[0]
                  : opts.existingConversationIds[opts.existingConversationIds.length - 1],
              }
            : opts.existingConversationId
              ? { conversation_id: opts.existingConversationId }
              : null,
        error: null,
      }),
    is: () => messagesBuilder,
    // The backfill update awaits the builder directly, so make it
    // thenable — every filter (.eq/.is) keeps chaining until awaited.
    then: (
      onFulfilled: (value: { error: null }) => unknown,
    ) => Promise.resolve({ error: null }).then(onFulfilled),
  });

  return {
    rpc: () =>
      Promise.resolve({
        data: null,
        error: {
          code: opts.rpcErrorCode ?? "PGRST202",
          message:
            opts.rpcErrorMessage ??
            "Could not find the function public.ensure_sms_conversation_id(p_contact_id, p_property_id) in the schema cache",
        },
      }),
    from: (table: string) => {
      if (table === "messages") return messagesBuilder;
      if (table === "contacts") {
        const contactsBuilder: Record<string, unknown> = {};
        Object.assign(contactsBuilder, {
          select: () => contactsBuilder,
          eq: () => contactsBuilder,
          maybeSingle: () =>
            Promise.resolve({
              data: (opts.contactExists ?? true) ? { id: "found" } : null,
              error: null,
            }),
        });
        return contactsBuilder;
      }
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

  it("adopts the earliest existing conversation id when the fallback sees multiple historical rows", async () => {
    const earliest = "11111111-2222-4333-8444-555555555555";
    const latest = "99999999-8888-4777-8666-555555555555";
    const resolved = await ensureConversationIdForThread(
      makeFallbackSupabase({
        existingConversationIds: [earliest, latest],
      }),
      CONTACT,
      PROPERTY,
    );

    expect(resolved).toBe(earliest);
  });

  it("normalizes contact/property UUID casing before hashing", async () => {
    const lowercase = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT.toLowerCase(),
      PROPERTY.toLowerCase(),
    );
    const uppercase = await ensureConversationIdForThread(
      makeFallbackSupabase(),
      CONTACT.toUpperCase(),
      PROPERTY.toUpperCase(),
    );

    expect(uppercase).toBe(lowercase);
  });

  it("fails closed when the RPC rejects the contact/property pair instead of falling back", async () => {
    await expect(
      ensureConversationIdForThread(
        makeFallbackSupabase({
          rpcErrorCode: "42501",
          rpcErrorMessage: "contact/property thread scope not found",
        }),
        CONTACT,
        PROPERTY,
      ),
    ).rejects.toThrow("contact/property thread scope not found");
  });

  it("fails closed on permission-style schema cache errors instead of silently falling back", async () => {
    await expect(
      ensureConversationIdForThread(
        makeFallbackSupabase({
          rpcErrorCode: "42501",
          rpcErrorMessage:
            "permission denied for function ensure_sms_conversation_id while loading schema cache",
        }),
        CONTACT,
        PROPERTY,
      ),
    ).rejects.toThrow("permission denied for function ensure_sms_conversation_id");
  });

  it("pre-080 RPC rejecting a null property falls back to the deterministic contact-level id", async () => {
    // Deploy-window state (Codex P1 on PR #270): new code, un-migrated
    // DB. The old RPC exists and raises scope-not-found for ANY
    // null-property call — inbound webhooks must keep working via the
    // deterministic fallback instead of 500ing.
    const pre080 = () =>
      makeFallbackSupabase({
        rpcErrorCode: "42501",
        rpcErrorMessage: "contact/property thread scope not found",
      });

    const first = await ensureConversationIdForThread(pre080(), CONTACT, null);
    const second = await ensureConversationIdForThread(pre080(), CONTACT, null);

    expect(first).toMatch(UUID_RE);
    expect(second).toBe(first);
  });

  it("contact-level fallback fails closed when the contact does not exist", async () => {
    // The same 42501 also covers a genuinely missing contact under the
    // new RPC — the fallback disambiguates via a contact lookup.
    await expect(
      ensureConversationIdForThread(
        makeFallbackSupabase({
          rpcErrorCode: "42501",
          rpcErrorMessage: "contact/property thread scope not found",
          contactExists: false,
        }),
        CONTACT,
        null,
      ),
    ).rejects.toThrow("contact not found for contact-level thread");
  });
});

/**
 * Row-backed stub for canonicalizeThreadId: captures eq/is filters and
 * resolves maybeSingle() against an in-memory messages table, honoring
 * the not-null conversation filter and created_at ordering.
 */
function makeCanonicalizeSupabase(
  rows: Array<{
    channel: string;
    conversation_id: string | null;
    contact_id: string | null;
    property_id: string | null;
    created_at: string;
  }>,
) {
  function builder() {
    const filters: Array<(r: (typeof rows)[number]) => boolean> = [];
    let ascending = true;
    const b = {
      select: () => b,
      eq: (col: string, val: string) => {
        filters.push((r) => r[col as keyof (typeof rows)[number]] === val);
        return b;
      },
      is: (col: string, val: null) => {
        filters.push((r) => r[col as keyof (typeof rows)[number]] === val);
        return b;
      },
      not: (col: string, _op: string, _val: null) => {
        filters.push((r) => r[col as keyof (typeof rows)[number]] !== null);
        return b;
      },
      order: (_col: string, opts?: { ascending?: boolean }) => {
        ascending = opts?.ascending ?? true;
        return b;
      },
      limit: () => b,
      maybeSingle: () => {
        const matched = rows
          .filter((r) => filters.every((f) => f(r)))
          .sort((x, y) =>
            ascending
              ? x.created_at.localeCompare(y.created_at)
              : y.created_at.localeCompare(x.created_at),
          );
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
    };
    return b;
  }
  return {
    from: (table: string) => {
      if (table === "messages") return builder();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe("canonicalizeThreadId — the URL-compat doormat", () => {
  const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CONTACT_UUID = "11111111-1111-4111-8111-111111111111";
  const supabase = makeCanonicalizeSupabase([
    // Conversation CONV: CONTACT_UUID at property p-a (newest activity).
    {
      channel: "sms",
      conversation_id: CONV,
      contact_id: CONTACT_UUID,
      property_id: "p-a",
      created_at: "2026-06-12T12:00:00Z",
    },
    // Same contact, older thread at p-b under a different conversation.
    {
      channel: "sms",
      conversation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      contact_id: CONTACT_UUID,
      property_id: "p-b",
      created_at: "2026-06-01T12:00:00Z",
    },
    // Property-less thread for another contact.
    {
      channel: "sms",
      conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      contact_id: "c-nondashed",
      property_id: null,
      created_at: "2026-06-10T12:00:00Z",
    },
  ]);

  it("returns a real conversation id unchanged", async () => {
    expect(await canonicalizeThreadId(supabase, CONV)).toBe(CONV);
  });

  it("resolves a stale bare contact UUID to the contact's most recent conversation", async () => {
    // Production contact ids are UUID-shaped, so they parse as
    // conversation ids first; when no conversation matches, retry as a
    // contact (Codex round-3 on PR #268, now centralized here).
    expect(await canonicalizeThreadId(supabase, CONTACT_UUID)).toBe(CONV);
  });

  it("resolves a legacy:contact:property link to that thread's conversation", async () => {
    expect(
      await canonicalizeThreadId(supabase, `legacy:${CONTACT_UUID}:p-b`),
    ).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("resolves a legacy property-less link via the null-property branch", async () => {
    expect(
      await canonicalizeThreadId(supabase, "legacy:c-nondashed:none"),
    ).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("resolves a bare non-UUID contact id to its latest conversation", async () => {
    expect(await canonicalizeThreadId(supabase, "c-nondashed")).toBe(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
  });

  it("returns null for an id that matches nothing", async () => {
    expect(
      await canonicalizeThreadId(supabase, "99999999-9999-4999-8999-999999999999"),
    ).toBeNull();
  });
});
