import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { listThreads, looksLikeTestTraffic } from "./list-threads";

/**
 * Stub Supabase client that records every `.in("id", chunk)` call and returns
 * rows for the contacts/properties tables based on a seed map. Just enough of
 * the chain API to satisfy listThreads.
 */
function makeStub(opts: {
  messages: Array<{
    contact_id: string;
    property_id: string | null;
    conversation_id?: string | null;
    body: string;
    direction: "inbound" | "outbound";
    created_at: string;
    read_at: string | null;
  }>;
  contacts: Map<string, { id: string; first_name: string | null; last_name: string | null; entity_name: string | null; phone_1: string | null }>;
  properties: Map<string, { id: string; address: string | null; city: string | null; state: string | null; assigned_user_id: string | null }>;
  consentEvents?: Array<{
    contact_id: string;
    event_type: string;
    occurred_at: string;
  }>;
}) {
  const inCalls: Record<string, string[][]> = {
    contacts: [],
    properties: [],
    consent_events: [],
  };

  const messagesQuery = {
    select: () => messagesQuery,
    eq: () => messagesQuery,
    not: () => messagesQuery,
    neq: () => messagesQuery,
    gte: () => messagesQuery,
    order: () => Promise.resolve({ data: opts.messages, error: null }),
  };

  function tableQuery(name: "contacts" | "properties") {
    return {
      select: () => ({
        in: (_col: string, chunk: string[]) => {
          inCalls[name].push(chunk);
          const source = name === "contacts" ? opts.contacts : opts.properties;
          const data = chunk
            .map((id) => source.get(id))
            .filter((row): row is NonNullable<typeof row> => Boolean(row));
          return Promise.resolve({ data, error: null });
        },
      }),
    };
  }

  function consentQuery() {
    // The consent_events query uses .select(...).eq("channel", "sms").in(...).order(...)
    return {
      select: () => ({
        eq: () => ({
          in: (_col: string, chunk: string[]) => {
            inCalls.consent_events.push(chunk);
            const data = (opts.consentEvents ?? []).filter((ev) =>
              chunk.includes(ev.contact_id),
            );
            return {
              order: () => Promise.resolve({ data, error: null }),
            };
          },
        }),
      }),
    };
  }

  const supabase = {
    from: (table: string) => {
      if (table === "messages") return messagesQuery;
      if (table === "contacts") return tableQuery("contacts");
      if (table === "properties") return tableQuery("properties");
      if (table === "consent_events") return consentQuery();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, inCalls };
}

describe("listThreads — chunking", () => {
  it("splits oversized contact-id IN clauses into multiple Supabase calls", async () => {
    // 600 contacts > the 250 chunk threshold ⇒ should produce 3 chunked calls.
    const N = 600;
    const messages = Array.from({ length: N }, (_, i) => ({
      contact_id: `c-${i}`,
      property_id: `p-${i}`,
      body: `msg ${i}`,
      direction: "inbound" as const,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      read_at: null,
    }));
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        { id: m.contact_id, first_name: "C", last_name: String(0), entity_name: null, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id!,
        { id: m.property_id!, address: "1 Main", city: null, state: null, assigned_user_id: null },
      ]),
    );

    const { supabase, inCalls } = makeStub({ messages, contacts, properties });

    const threads = await listThreads(supabase, {});

    // Pre-fix this would be 1 call with 600 ids → PostgREST 400.
    expect(inCalls.contacts.length).toBe(3);
    expect(inCalls.contacts.map((c) => c.length)).toEqual([250, 250, 100]);
    expect(inCalls.properties.length).toBe(3);
    expect(inCalls.properties.map((c) => c.length)).toEqual([250, 250, 100]);

    // And the result still includes all N contacts hydrated end-to-end.
    expect(threads.length).toBe(N);
    expect(new Set(threads.map((t) => t.contactId)).size).toBe(N);
  });

  it("skips the network entirely when there are no contact ids", async () => {
    const { supabase, inCalls } = makeStub({
      messages: [],
      contacts: new Map(),
      properties: new Map(),
    });
    // Spy on `from` to assert we don't even touch the contacts table.
    const fromSpy = vi.spyOn(supabase, "from");

    const threads = await listThreads(supabase, {});

    expect(threads).toEqual([]);
    expect(inCalls.contacts.length).toBe(0);
    expect(inCalls.properties.length).toBe(0);
    // messages table may still be queried; contacts/properties must not be.
    const tablesHit = fromSpy.mock.calls.map((c) => c[0]);
    expect(tablesHit).not.toContain("contacts");
    expect(tablesHit).not.toContain("properties");
  });
});

describe("listThreads — isOptedOut (DNC) flag", () => {
  function buildBasicSeed(contactIds: string[]) {
    const messages = contactIds.map((cid, i) => ({
      contact_id: cid,
      property_id: `p-${i}`,
      body: "hi",
      direction: "inbound" as const,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      read_at: null,
    }));
    const contacts = new Map(
      contactIds.map((cid) => [
        cid,
        { id: cid, first_name: null, last_name: null, entity_name: cid, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        { id: m.property_id, address: null, city: null, state: null, assigned_user_id: null },
      ]),
    );
    return { messages, contacts, properties };
  }

  it("marks isOptedOut=true when contact's latest consent event is opt_out", async () => {
    const seed = buildBasicSeed(["c-opted-out", "c-clean"]);
    const { supabase } = makeStub({
      ...seed,
      consentEvents: [
        {
          contact_id: "c-opted-out",
          event_type: "opt_out",
          occurred_at: new Date().toISOString(),
        },
        {
          contact_id: "c-opted-out",
          event_type: "opt_in_marketing_written",
          occurred_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const threads = await listThreads(supabase, {});
    const optedOut = threads.find((t) => t.contactId === "c-opted-out");
    const clean = threads.find((t) => t.contactId === "c-clean");

    expect(optedOut?.isOptedOut).toBe(true);
    expect(clean?.isOptedOut).toBe(false);
  });

  it("marks isOptedOut=false when contact has no consent events at all", async () => {
    const seed = buildBasicSeed(["c-no-events"]);
    const { supabase } = makeStub({ ...seed, consentEvents: [] });

    const threads = await listThreads(supabase, {});
    expect(threads[0]?.isOptedOut).toBe(false);
  });

  it("marks isOptedOut=false when latest event is opt_in (overrides prior opt_out)", async () => {
    const seed = buildBasicSeed(["c-resubscribed"]);
    const { supabase } = makeStub({
      ...seed,
      consentEvents: [
        {
          contact_id: "c-resubscribed",
          event_type: "opt_in_confirmed",
          occurred_at: new Date().toISOString(),
        },
        {
          contact_id: "c-resubscribed",
          event_type: "opt_out",
          occurred_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const threads = await listThreads(supabase, {});
    expect(threads[0]?.isOptedOut).toBe(false);
  });

  it("treats provider_auto_opt_out the same as a manual opt_out", async () => {
    const seed = buildBasicSeed(["c-auto-opted-out"]);
    const { supabase } = makeStub({
      ...seed,
      consentEvents: [
        {
          contact_id: "c-auto-opted-out",
          event_type: "provider_auto_opt_out",
          occurred_at: new Date().toISOString(),
        },
      ],
    });

    const threads = await listThreads(supabase, {});
    expect(threads[0]?.isOptedOut).toBe(true);
  });

  it("returns separate thread rows when one contact has two property conversations", async () => {
    const createdAt = new Date().toISOString();
    const { supabase } = makeStub({
      messages: [
        {
          contact_id: "c-shared",
          property_id: "p-a",
          body: "about property A",
          direction: "inbound",
          created_at: createdAt,
          read_at: null,
        },
        {
          contact_id: "c-shared",
          property_id: "p-b",
          body: "about property B",
          direction: "outbound",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          read_at: null,
        },
      ],
      contacts: new Map([
        [
          "c-shared",
          {
            id: "c-shared",
            first_name: "Shared",
            last_name: "Owner",
            entity_name: null,
            phone_1: "+18165550123",
          },
        ],
      ]),
      properties: new Map([
        [
          "p-a",
          {
            id: "p-a",
            address: "1 Alpha Ave",
            city: null,
            state: null,
            assigned_user_id: null,
          },
        ],
        [
          "p-b",
          {
            id: "p-b",
            address: "2 Bravo Blvd",
            city: null,
            state: null,
            assigned_user_id: null,
          },
        ],
      ]),
      consentEvents: [],
    });

    const threads = await listThreads(supabase, {});
    const shared = threads.filter((thread) => thread.contactId === "c-shared");

    expect(shared).toHaveLength(2);
    expect(shared.map((thread) => thread.propertyId).sort()).toEqual([
      "p-a",
      "p-b",
    ]);
    expect(new Set(shared.map((thread) => thread.threadId)).size).toBe(2);
  });
});

describe("listThreads — recency-only sort", () => {
  function seedFixtures(
    rows: Array<{
      cid: string;
      age: number;
      unread: boolean;
      convId?: string | null;
    }>,
  ) {
    const now = Date.now();
    const messages = rows.map((m) => ({
      contact_id: m.cid,
      property_id: `p-${m.cid}`,
      conversation_id: m.convId ?? null,
      body: "x",
      direction: "inbound" as const,
      created_at: new Date(now - m.age).toISOString(),
      read_at: m.unread ? null : new Date(now - m.age + 1).toISOString(),
    }));

    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        { id: m.contact_id, first_name: null, last_name: null, entity_name: m.contact_id, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        { id: m.property_id, address: null, city: null, state: null, assigned_user_id: null },
      ]),
    );
    return makeStub({ messages, contacts, properties });
  }

  it("orders strictly by last message recency — read state never moves a row", async () => {
    // Unread-first bubbling (feedback-f E2a) was retired: the dedicated
    // Unread chip owns "what needs attention", so reading a thread must
    // not reposition it in All/Mine/Unassigned.
    const { supabase } = seedFixtures([
      { cid: "c-recent-read", age: 1_000, unread: false },
      { cid: "c-recent-unread", age: 5_000, unread: true },
      { cid: "c-old-unread", age: 60_000, unread: true },
      { cid: "c-old-read", age: 90_000, unread: false },
    ]);
    const threads = await listThreads(supabase, {});

    expect(threads.map((t) => t.contactId)).toEqual([
      "c-recent-read",
      "c-recent-unread",
      "c-old-unread",
      "c-old-read",
    ]);
  });

  it("unreadOnly keeps the pinned includeThreadId thread after it is read", async () => {
    // Read-on-open marks the open thread read; the cockpit pins it via
    // includeThreadId so it doesn't vanish from the Unread list while
    // the user is still viewing it.
    const { supabase } = seedFixtures([
      { cid: "c-open", age: 1_000, unread: false },
      { cid: "c-unread", age: 5_000, unread: true },
      { cid: "c-other-read", age: 9_000, unread: false },
    ]);

    const pinned = await listThreads(supabase, {
      unreadOnly: true,
      includeThreadId: "legacy:c-open:p-c-open",
    });
    expect(pinned.map((t) => t.contactId)).toEqual(["c-open", "c-unread"]);

    const unpinned = await listThreads(supabase, { unreadOnly: true });
    expect(unpinned.map((t) => t.contactId)).toEqual(["c-unread"]);
  });

  it("pins via stale URL formats when the thread is grouped by conversation UUID", async () => {
    // Codex P1 on PR #268: old inbox links carry legacy / bare-contact ids
    // while the thread may now group under a conversation UUID. The pin
    // must match by identity, not raw string equality.
    const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const seed = () =>
      seedFixtures([
        { cid: "c-open", age: 1_000, unread: false, convId: CONV },
        { cid: "c-unread", age: 5_000, unread: true },
      ]);

    // Stale legacy-format link.
    const viaLegacy = await listThreads(seed().supabase, {
      unreadOnly: true,
      includeThreadId: "legacy:c-open:p-c-open",
    });
    expect(viaLegacy.map((t) => t.contactId)).toEqual(["c-open", "c-unread"]);

    // Pre-Phase-2 bare contact-id link.
    const viaContact = await listThreads(seed().supabase, {
      unreadOnly: true,
      includeThreadId: "c-open",
    });
    expect(viaContact.map((t) => t.contactId)).toEqual(["c-open", "c-unread"]);

    // Canonical conversation-UUID link.
    const viaConversation = await listThreads(seed().supabase, {
      unreadOnly: true,
      includeThreadId: CONV,
    });
    expect(viaConversation.map((t) => t.contactId)).toEqual([
      "c-open",
      "c-unread",
    ]);
  });

  it("bare contact-id pin keeps only the contact's most recent thread", async () => {
    // Codex round-2 on PR #268: a contact can have several threads (one
    // per property). A bare-contact pin must resolve to the thread with
    // the contact's latest message — matching fetchInboxDetail — not pin
    // every read thread the contact appears in.
    const now = Date.now();
    const messages = [
      // c-multi, two threads, both fully read. p-a is the more recent.
      { cid: "c-multi", pid: "p-a", age: 1_000, unread: false },
      { cid: "c-multi", pid: "p-b", age: 9_000, unread: false },
      // Unrelated unread thread that must survive the filter.
      { cid: "c-unread", pid: "p-u", age: 5_000, unread: true },
    ].map((m) => ({
      contact_id: m.cid,
      property_id: m.pid,
      conversation_id: null,
      body: "x",
      direction: "inbound" as const,
      created_at: new Date(now - m.age).toISOString(),
      read_at: m.unread ? null : new Date(now - m.age + 1).toISOString(),
    }));
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        { id: m.contact_id, first_name: null, last_name: null, entity_name: m.contact_id, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        { id: m.property_id, address: null, city: null, state: null, assigned_user_id: null },
      ]),
    );

    const { supabase } = makeStub({ messages, contacts, properties });
    const threads = await listThreads(supabase, {
      unreadOnly: true,
      includeThreadId: "c-multi",
    });

    // p-a (the contact's latest thread) is pinned; p-b stays filtered out.
    expect(threads.map((t) => t.threadId)).toEqual([
      "legacy:c-multi:p-a",
      "legacy:c-unread:p-u",
    ]);
  });

  it("pins a stale bare-contact link whose contact id is a real UUID", async () => {
    // Codex round-3 on PR #268: production contact ids are UUIDs, so a
    // stale `?thread=<contactId>` link parses as a conversation id. When
    // no conversation in the window matches, the pin must retry the UUID
    // as a contact id — mirroring fetchInboxDetail — instead of silently
    // attaching to nothing.
    const CONTACT_UUID = "11111111-1111-4111-8111-111111111111";
    const now = Date.now();
    const messages = [
      { cid: CONTACT_UUID, pid: "p-a", age: 1_000, unread: false },
      { cid: CONTACT_UUID, pid: "p-b", age: 9_000, unread: false },
      { cid: "c-unread", pid: "p-u", age: 5_000, unread: true },
    ].map((m) => ({
      contact_id: m.cid,
      property_id: m.pid,
      conversation_id: null,
      body: "x",
      direction: "inbound" as const,
      created_at: new Date(now - m.age).toISOString(),
      read_at: m.unread ? null : new Date(now - m.age + 1).toISOString(),
    }));
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        { id: m.contact_id, first_name: null, last_name: null, entity_name: m.contact_id, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        { id: m.property_id, address: null, city: null, state: null, assigned_user_id: null },
      ]),
    );

    const { supabase } = makeStub({ messages, contacts, properties });
    const threads = await listThreads(supabase, {
      unreadOnly: true,
      includeThreadId: CONTACT_UUID,
    });

    expect(threads.map((t) => t.threadId)).toEqual([
      `legacy:${CONTACT_UUID}:p-a`,
      "legacy:c-unread:p-u",
    ]);
  });
});

describe("looksLikeTestTraffic", () => {
  it("flags Jitter canary contact names", () => {
    expect(looksLikeTestTraffic("Canary CANARY-STOP-1778862210079", null)).toBe(true);
    expect(looksLikeTestTraffic("Canary CANARY-AI-HAPPY-1777657500276", null)).toBe(true);
  });

  it("flags synthetic jitter addresses even without a contact", () => {
    expect(
      looksLikeTestTraffic(null, "Jitter Canary 26710917291-1 Golden Path Ln, Kansas City, MO"),
    ).toBe(true);
  });

  it("does not flag real homeowners", () => {
    expect(looksLikeTestTraffic("Sheka Newsome", "8101 E 133rd ST, Grandview, MO")).toBe(false);
    expect(looksLikeTestTraffic(null, null)).toBe(false);
  });

  it("does not flag substring collisions with real names/streets", () => {
    // Codex P1: the matcher must follow the fixture contract (prefixes),
    // never generic substrings.
    expect(looksLikeTestTraffic("Bob Canary", "123 Canary Ln, Kansas City, MO")).toBe(false);
    expect(looksLikeTestTraffic("Jane Doe", "44 Jitterbug Dr, Liberty, MO")).toBe(false);
    expect(looksLikeTestTraffic("Canary Smith", null)).toBe(false);
    expect(looksLikeTestTraffic(null, "901 W Jittery Way")).toBe(false);
  });

  it("flags the JITTER-SANDRA-V1 writeback-proof address shape", () => {
    expect(looksLikeTestTraffic(null, "JITTER-SANDRA-V1 writeback proof mpwl5neb")).toBe(true);
  });
});
