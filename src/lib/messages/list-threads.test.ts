import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import {
  countNeedsOutcomeThreads,
  listThreadPage,
  listThreads,
  looksLikeTestTraffic,
} from "./list-threads";

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
    from_address?: string | null;
    to_address?: string | null;
    created_at: string;
    read_at: string | null;
  }>;
  contacts: Map<
    string,
    {
      id: string;
      first_name: string | null;
      last_name: string | null;
      entity_name: string | null;
      phone_1: string | null;
      phone_2?: string | null;
      phone_3?: string | null;
      do_not_contact?: boolean;
      sms_opted_out?: boolean;
    }
  >;
  properties: Map<
    string,
    {
      id: string;
      address: string | null;
      city: string | null;
      state: string | null;
      status?: string | null;
      outreach_dispo?: string | null;
      is_dnc_locked?: boolean;
      assigned_user_id: string | null;
      needs_human_attention?: boolean;
      last_ai_escalation_reason?: string | null;
    }
  >;
  messageThreads?: Map<
    string,
    {
      conversation_id: string;
      ai_responder_status?: string | null;
      ai_responder_reason?: string | null;
      ai_responder_status_at?: string | null;
      ai_last_delivery_status?: string | null;
      ai_last_delivery_error?: string | null;
    }
  >;
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
    message_threads: [],
  };

  const messagesQuery = {
    select: () => messagesQuery,
    eq: () => messagesQuery,
    not: () => messagesQuery,
    neq: () => messagesQuery,
    gte: () => messagesQuery,
    // Stamp a deterministic conversation id on any row the test didn't
    // give one — mirrors the DB invariant since migration 081 (the fill
    // trigger guarantees every contact-bearing SMS row has one).
    order: () =>
      Promise.resolve({
        data: opts.messages.map((m) => ({
          ...m,
          from_address:
            m.from_address ??
            (m.direction === "inbound" ? "+15551234567" : "+18162804181"),
          to_address:
            m.to_address ??
            (m.direction === "inbound" ? "+18162804181" : "+15551234567"),
          conversation_id:
            m.conversation_id ??
            `conv:${m.contact_id}:${m.property_id ?? "none"}`,
        })),
        error: null,
      }),
  };

  function tableQuery(name: "contacts" | "properties" | "message_threads") {
    return {
      select: () => ({
        in: (_col: string, chunk: string[]) => {
          inCalls[name].push(chunk);
          const source =
            name === "contacts"
              ? opts.contacts
              : name === "properties"
                ? opts.properties
                : (opts.messageThreads ?? new Map());
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
      if (table === "message_threads") return tableQuery("message_threads");
      if (table === "consent_events") return consentQuery();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, inCalls };
}

describe("listThreads — chunking", () => {
  it("loads one bounded server-filtered page with full-window counts", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        rows: [
          {
            thread_id: "11111111-1111-4111-8111-111111111111",
            contact_id: "22222222-2222-4222-8222-222222222222",
            contact_name: "Seller",
            thread_customer_phone: "+18165550100",
            thread_business_phone: "+18165550200",
            property_id: "33333333-3333-4333-8333-333333333333",
            property_address: "123 Main St, Kansas City, MO",
            property_status: "prospect",
            outreach_dispo: null,
            is_dnc_locked: false,
            assignee_id: "44444444-4444-4444-8444-444444444444",
            last_message_body: "Hello",
            last_message_direction: "inbound",
            last_message_at: "2026-08-17T12:00:00.000Z",
            unread_count: 1,
            has_inbound: true,
            needs_human_attention: false,
            escalation_reason: null,
            is_opted_out: false,
            is_test_traffic: false,
            needs_outcome: true,
            ai_responder_status: null,
            ai_responder_reason: null,
            ai_responder_status_at: null,
            ai_last_delivery_status: null,
            ai_last_delivery_error: null,
          },
        ],
        counts: {
          all: 53_503,
          mine: 220,
          unassigned: 52_000,
          unread: 45,
          escalated: 3,
          dispo: 900,
          needs_outcome: 17,
        },
        total: 45,
        hidden_count: 8,
        limit: 200,
        offset: 0,
      },
      error: null,
    }));
    const supabase = { rpc } as unknown as SupabaseClient<Database>;

    const page = await listThreadPage(supabase, {
      filter: "unread",
      currentUserId: "44444444-4444-4444-8444-444444444444",
      includeThreadId: null,
      hideNoise: true,
      page: 1,
    });

    expect(page.counts.all).toBe(53_503);
    expect(page.total).toBe(45);
    expect(page.hiddenCount).toBe(8);
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0].needsOutcome).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "sms_inbox_thread_page_snapshot",
      expect.objectContaining({
        p_filter: "unread",
        p_limit: 200,
        p_offset: 0,
      }),
    );
  });

  it("fails closed on a paged snapshot tenant collision", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: { __error: "cross_org_conversation_id_ambiguity", count: 1 },
        error: null,
      })),
    } as unknown as SupabaseClient<Database>;

    await expect(
      listThreadPage(supabase, {
        filter: "all",
        currentUserId: null,
        includeThreadId: null,
        hideNoise: true,
        page: 1,
      }),
    ).rejects.toThrow("cross_org_conversation_id_ambiguity");
  });

  it("clamps non-finite and oversized pages before the PostgreSQL integer offset", async () => {
    const rpc = vi.fn(async (_name: string, args: { p_limit: number }) => ({
      data: {
        rows: [],
        counts: {
          all: 0,
          mine: 0,
          unassigned: 0,
          unread: 0,
          escalated: 0,
          dispo: 0,
          needs_outcome: 0,
        },
        total: 0,
        hidden_count: 0,
        limit: args.p_limit,
        offset: 0,
      },
      error: null,
    }));
    const supabase = { rpc } as unknown as SupabaseClient<Database>;

    await listThreadPage(supabase, {
      filter: "all",
      currentUserId: null,
      includeThreadId: null,
      hideNoise: true,
      page: Number.POSITIVE_INFINITY,
      pageSize: 500,
    });
    expect(rpc).toHaveBeenLastCalledWith(
      "sms_inbox_thread_page_snapshot",
      expect.objectContaining({ p_offset: 0 }),
    );

    await listThreadPage(supabase, {
      filter: "all",
      currentUserId: null,
      includeThreadId: null,
      hideNoise: true,
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 500,
    });
    const maxSafeIntegerOffset = Math.floor(2_147_483_647 / 500) * 500;
    expect(rpc).toHaveBeenLastCalledWith(
      "sms_inbox_thread_page_snapshot",
      expect.objectContaining({ p_offset: maxSafeIntegerOffset }),
    );
  });

  it("fails closed when the server reports the snapshot thread ceiling", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: {
          __error: "thread_limit_exceeded",
          limit: 20_000,
          count: 20_001,
        },
        error: null,
      })),
    } as unknown as SupabaseClient<Database>;

    await expect(listThreads(supabase, {})).rejects.toThrow(
      "thread_limit_exceeded",
    );
  });

  it("fails closed when the server reports a cross-organization thread identity collision", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: {
          __error: "cross_org_conversation_id_ambiguity",
          count: 1,
        },
        error: null,
      })),
    } as unknown as SupabaseClient<Database>;

    await expect(listThreads(supabase, {})).rejects.toThrow(
      "cross_org_conversation_id_ambiguity",
    );
  });

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
        {
          id: m.contact_id,
          first_name: "C",
          last_name: String(0),
          entity_name: null,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id!,
        {
          id: m.property_id!,
          address: "1 Main",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          is_dnc_locked: false,
          assigned_user_id: null,
        },
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

describe("listThreads — Sandra AI state", () => {
  it("hydrates thread-level Sandra state and filters escalated from message_threads", async () => {
    const messages = [
      {
        contact_id: "c-handled",
        property_id: "p-handled",
        conversation_id: "conv-handled",
        body: "thanks",
        direction: "inbound" as const,
        created_at: "2026-06-24T15:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-escalated",
        property_id: "p-escalated",
        conversation_id: "conv-escalated",
        body: "call me",
        direction: "inbound" as const,
        created_at: "2026-06-24T14:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-property-attention",
        property_id: "p-property-attention",
        conversation_id: "conv-property-attention",
        body: "legacy attention flag only",
        direction: "inbound" as const,
        created_at: "2026-06-24T13:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-dispo",
        property_id: "p-dispo",
        conversation_id: "conv-dispo",
        body: "not interested",
        direction: "inbound" as const,
        created_at: "2026-06-24T12:00:00.000Z",
        read_at: null,
      },
    ];
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        {
          id: m.property_id,
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: m.property_id === "p-dispo" ? "not_interested" : null,
          assigned_user_id: null,
          needs_human_attention: m.property_id === "p-property-attention",
        },
      ]),
    );
    const messageThreads = new Map([
      [
        "conv-handled",
        {
          conversation_id: "conv-handled",
          ai_responder_status: "handled",
          ai_responder_reason: "sent",
          ai_responder_status_at: "2026-06-24T15:01:00.000Z",
          ai_last_delivery_status: "failed",
          ai_last_delivery_error: "Carrier rejected recipient",
        },
      ],
      [
        "conv-escalated",
        {
          conversation_id: "conv-escalated",
          ai_responder_status: "escalated",
          ai_responder_reason: "model:needs_human",
          ai_responder_status_at: "2026-06-24T14:01:00.000Z",
          ai_last_delivery_status: null,
          ai_last_delivery_error: null,
        },
      ],
    ]);

    const { supabase } = makeStub({
      messages,
      contacts,
      properties,
      messageThreads,
    });

    const all = await listThreads(supabase, {});
    expect(all.find((t) => t.threadId === "conv-handled")).toMatchObject({
      aiResponderStatus: "handled",
      aiResponderReason: "sent",
      aiLastDeliveryStatus: "failed",
      aiLastDeliveryError: "Carrier rejected recipient",
    });

    await expect(
      listThreads(supabase, { handledOnly: true }),
    ).resolves.toMatchObject([{ threadId: "conv-handled" }]);
    await expect(
      listThreads(supabase, { dispoOnly: true }),
    ).resolves.toMatchObject([{ threadId: "conv-dispo" }]);
    await expect(
      listThreads(supabase, { escalatedOnly: true }),
    ).resolves.toMatchObject([{ threadId: "conv-escalated" }]);
  });

  it("filters Dispo by property outreach disposition, not Sandra AI handled state", async () => {
    const messages = [
      {
        contact_id: "c-ai-handled",
        property_id: "p-ai-handled",
        conversation_id: "conv-ai-handled",
        body: "Sandra replied",
        direction: "inbound" as const,
        created_at: "2026-06-24T16:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-dispo",
        property_id: "p-dispo",
        conversation_id: "conv-dispo",
        body: "not interested",
        direction: "inbound" as const,
        created_at: "2026-06-24T15:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-property-null",
        property_id: null,
        conversation_id: "conv-property-null",
        body: "which house?",
        direction: "inbound" as const,
        created_at: "2026-06-24T14:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: null,
        conversation_id: "conv-mixed",
        body: "latest contact-level reply",
        direction: "inbound" as const,
        created_at: "2026-06-24T13:00:00.000Z",
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: "p-mixed",
        conversation_id: "conv-mixed",
        body: "older linked message",
        direction: "outbound" as const,
        created_at: "2026-06-24T12:00:00.000Z",
        read_at: null,
      },
    ];
    const contacts = new Map(
      Array.from(new Set(messages.map((m) => m.contact_id))).map(
        (contactId) => [
          contactId,
          {
            id: contactId,
            first_name: null,
            last_name: null,
            entity_name: contactId,
            phone_1: null,
          },
        ],
      ),
    );
    const properties = new Map([
      [
        "p-ai-handled",
        {
          id: "p-ai-handled",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          is_dnc_locked: false,
          assigned_user_id: null,
        },
      ],
      [
        "p-dispo",
        {
          id: "p-dispo",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: "not_interested",
          assigned_user_id: null,
        },
      ],
      [
        "p-mixed",
        {
          id: "p-mixed",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: "nurture",
          assigned_user_id: null,
        },
      ],
    ]);
    const messageThreads = new Map([
      [
        "conv-ai-handled",
        {
          conversation_id: "conv-ai-handled",
          ai_responder_status: "handled",
          ai_responder_reason: "sent",
        },
      ],
    ]);

    const { supabase } = makeStub({
      messages,
      contacts,
      properties,
      messageThreads,
    });

    const threads = await listThreads(supabase, { dispoOnly: true });

    expect(threads.map((thread) => thread.threadId)).toEqual([
      "conv-dispo",
      "conv-mixed",
    ]);
    expect(threads.every((thread) => thread.outreachDispo !== null)).toBe(true);
    expect(threads.map((thread) => thread.threadId)).not.toContain(
      "conv-ai-handled",
    );
    expect(threads.map((thread) => thread.threadId)).not.toContain(
      "conv-property-null",
    );
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
        {
          id: cid,
          first_name: null,
          last_name: null,
          entity_name: cid,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        {
          id: m.property_id,
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          is_dnc_locked: false,
          assigned_user_id: null,
        },
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

  it("hydrates the property DNC lock even when the visible thread belongs to an agent contact", async () => {
    const seed = buildBasicSeed(["agent-contact"]);
    seed.properties.get("p-0")!.is_dnc_locked = true;

    const { supabase } = makeStub({ ...seed, consentEvents: [] });
    const threads = await listThreads(supabase, {});

    expect(threads[0]).toMatchObject({
      contactId: "agent-contact",
      isOptedOut: false,
      isDncLocked: true,
    });
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

  it("uses the latest SMS address pair as the displayed thread phone", async () => {
    const { supabase } = makeStub({
      messages: [
        {
          contact_id: "c-secondary-phone",
          property_id: "p-secondary-phone",
          body: "reply from secondary",
          direction: "inbound",
          from_address: "+18165559902",
          to_address: "+18162804181",
          created_at: new Date().toISOString(),
          read_at: null,
        },
      ],
      contacts: new Map([
        [
          "c-secondary-phone",
          {
            id: "c-secondary-phone",
            first_name: "Secondary",
            last_name: "Phone",
            entity_name: null,
            phone_1: "+18165559901",
            phone_2: "+18165559902",
          },
        ],
      ]),
      properties: new Map([
        [
          "p-secondary-phone",
          {
            id: "p-secondary-phone",
            address: "200 Secondary St",
            city: null,
            state: "MO",
            assigned_user_id: null,
          },
        ],
      ]),
    });

    const threads = await listThreads(supabase, {});

    expect(threads[0]?.contactPhone).toBe("+18165559902");
    expect(threads[0]?.threadCustomerPhone).toBe("+18165559902");
    expect(threads[0]?.threadBusinessPhone).toBe("+18162804181");
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
            status: "prospect",
            outreach_dispo: null,
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
            status: "prospect",
            outreach_dispo: null,
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

  it("merges propertyless and property-stamped messages sharing the same conversation id into one property bucket", async () => {
    const createdAt = new Date().toISOString();
    const { supabase } = makeStub({
      messages: [
        {
          contact_id: "c-merged",
          property_id: null,
          conversation_id: "conv-merged",
          body: "which one?",
          direction: "inbound",
          created_at: createdAt,
          read_at: null,
        },
        {
          contact_id: "c-merged",
          property_id: "p-merged",
          conversation_id: "conv-merged",
          body: "about merged property",
          direction: "outbound",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          read_at: null,
        },
      ],
      contacts: new Map([
        [
          "c-merged",
          {
            id: "c-merged",
            first_name: "Merged",
            last_name: "Owner",
            entity_name: null,
            phone_1: "+18165550124",
          },
        ],
      ]),
      properties: new Map([
        [
          "p-merged",
          {
            id: "p-merged",
            address: "10 Merged Ave",
            city: null,
            state: null,
            status: "prospect",
            outreach_dispo: null,
            assigned_user_id: null,
          },
        ],
      ]),
      consentEvents: [],
    });

    const threads = await listThreads(supabase, {});

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadId: "conv-merged",
      contactId: "c-merged",
      propertyId: "p-merged",
      propertyAddress: "10 Merged Ave",
    });
  });

  it("uses the newest non-null property when one conversation carries two linked properties", async () => {
    const { supabase } = makeStub({
      messages: [
        {
          contact_id: "c-newest-wins",
          property_id: "p-recent",
          conversation_id: "conv-newest-wins",
          body: "newer linked context",
          direction: "inbound",
          created_at: "2026-06-09T12:00:00.000Z",
          read_at: null,
        },
        {
          contact_id: "c-newest-wins",
          property_id: "p-older",
          conversation_id: "conv-newest-wins",
          body: "older linked context",
          direction: "outbound",
          created_at: "2026-06-08T12:00:00.000Z",
          read_at: null,
        },
      ],
      contacts: new Map([
        [
          "c-newest-wins",
          {
            id: "c-newest-wins",
            first_name: "Newest",
            last_name: "Wins",
            entity_name: null,
            phone_1: "+18165550126",
          },
        ],
      ]),
      properties: new Map([
        [
          "p-older",
          {
            id: "p-older",
            address: "100 Older Ave",
            city: null,
            state: null,
            status: "prospect",
            outreach_dispo: null,
            assigned_user_id: null,
          },
        ],
        [
          "p-recent",
          {
            id: "p-recent",
            address: "200 Newer Ave",
            city: null,
            state: null,
            status: "prospect",
            outreach_dispo: null,
            assigned_user_id: null,
          },
        ],
      ]),
      consentEvents: [],
    });

    const threads = await listThreads(supabase, {});

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadId: "conv-newest-wins",
      contactId: "c-newest-wins",
      propertyId: "p-recent",
      propertyAddress: "200 Newer Ave",
      lastMessageBody: "newer linked context",
    });
  });

  it("keeps two propertyless conversations for the same contact as separate buckets", async () => {
    const { supabase } = makeStub({
      messages: [
        {
          contact_id: "c-two-null",
          property_id: null,
          conversation_id: "conv-null-a",
          body: "first propertyless thread",
          direction: "inbound",
          created_at: new Date().toISOString(),
          read_at: null,
        },
        {
          contact_id: "c-two-null",
          property_id: null,
          conversation_id: "conv-null-b",
          body: "second propertyless thread",
          direction: "inbound",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          read_at: null,
        },
      ],
      contacts: new Map([
        [
          "c-two-null",
          {
            id: "c-two-null",
            first_name: "Two",
            last_name: "Null",
            entity_name: null,
            phone_1: "+18165550125",
          },
        ],
      ]),
      properties: new Map(),
      consentEvents: [],
    });

    const threads = await listThreads(supabase, {});

    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.threadId).sort()).toEqual([
      "conv-null-a",
      "conv-null-b",
    ]);
    expect(threads.every((thread) => thread.propertyId === null)).toBe(true);
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
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id,
        {
          id: m.property_id,
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
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
    // the user is still viewing it. The pin is an exact conversation id —
    // stale URL formats are canonicalized upstream (canonicalizeThreadId),
    // so listThreads itself never sees legacy or bare-contact ids.
    const { supabase } = seedFixtures([
      { cid: "c-open", age: 1_000, unread: false },
      { cid: "c-unread", age: 5_000, unread: true },
      { cid: "c-other-read", age: 9_000, unread: false },
    ]);

    const pinned = await listThreads(supabase, {
      unreadOnly: true,
      includeThreadId: "conv:c-open:p-c-open",
    });
    expect(pinned.map((t) => t.contactId)).toEqual(["c-open", "c-unread"]);

    const unpinned = await listThreads(supabase, { unreadOnly: true });
    expect(unpinned.map((t) => t.contactId)).toEqual(["c-unread"]);
  });
});

describe("listThreads — escalatedOnly", () => {
  // Three threads: one Sandra handed off, one legacy property attention flag
  // with no thread-level Sandra state, and one Sandra handled cleanly.
  // escalatedOnly should return only the current thread-level handoff.
  function seedEscalation() {
    const now = Date.now();
    const messages = [
      {
        contact_id: "c-esc",
        property_id: "p-esc",
        body: "I want to talk to a human",
        direction: "inbound" as const,
        created_at: new Date(now - 1_000).toISOString(),
        read_at: new Date(now).toISOString(),
      },
      {
        contact_id: "c-property-attention",
        property_id: "p-property-attention",
        body: "legacy property attention only",
        direction: "inbound" as const,
        created_at: new Date(now - 1_500).toISOString(),
        read_at: new Date(now).toISOString(),
      },
      {
        contact_id: "c-calm",
        property_id: "p-calm",
        body: "sounds good, thanks",
        direction: "inbound" as const,
        created_at: new Date(now - 2_000).toISOString(),
        read_at: new Date(now).toISOString(),
      },
    ];
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map([
      [
        "p-esc",
        {
          id: "p-esc",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
          needs_human_attention: true,
          last_ai_escalation_reason: "keyword:handoff_request",
        },
      ],
      [
        "p-property-attention",
        {
          id: "p-property-attention",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
          needs_human_attention: true,
          last_ai_escalation_reason: "keyword:handoff_request",
        },
      ],
      [
        "p-calm",
        {
          id: "p-calm",
          address: null,
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
          needs_human_attention: false,
          last_ai_escalation_reason: "model:not_interested",
        },
      ],
    ]);
    const messageThreads = new Map([
      [
        "conv:c-esc:p-esc",
        {
          conversation_id: "conv:c-esc:p-esc",
          ai_responder_status: "escalated",
          ai_responder_reason: "keyword:handoff_request",
          ai_responder_status_at: new Date(now - 900).toISOString(),
          ai_last_delivery_status: null,
          ai_last_delivery_error: null,
        },
      ],
      [
        "conv:c-calm:p-calm",
        {
          conversation_id: "conv:c-calm:p-calm",
          ai_responder_status: "handled",
          ai_responder_reason: "sent",
          ai_responder_status_at: new Date(now - 1_900).toISOString(),
          ai_last_delivery_status: "sent",
          ai_last_delivery_error: null,
        },
      ],
    ]);
    return makeStub({ messages, contacts, properties, messageThreads });
  }

  it("returns only threads Sandra escalated for human review", async () => {
    const { supabase } = seedEscalation();
    const threads = await listThreads(supabase, { escalatedOnly: true });
    expect(threads.map((t) => t.contactId)).toEqual(["c-esc"]);
    expect(threads[0].needsHumanAttention).toBe(true);
    expect(threads[0].escalationReason).toBe("keyword:handoff_request");
    expect(threads[0].aiResponderStatus).toBe("escalated");
  });

  it("returns all threads when escalatedOnly is not set", async () => {
    const { supabase } = seedEscalation();
    const threads = await listThreads(supabase, {});
    expect(threads.map((t) => t.contactId).sort()).toEqual([
      "c-calm",
      "c-esc",
      "c-property-attention",
    ]);
    expect(
      threads.find((t) => t.contactId === "c-calm")?.escalationReason,
    ).toBeNull();
  });
});

describe("looksLikeTestTraffic", () => {
  it("flags Jitter canary contact names", () => {
    expect(looksLikeTestTraffic("Canary CANARY-STOP-1778862210079", null)).toBe(
      true,
    );
    expect(
      looksLikeTestTraffic("Canary CANARY-AI-HAPPY-1777657500276", null),
    ).toBe(true);
  });

  it("flags synthetic jitter addresses even without a contact", () => {
    expect(
      looksLikeTestTraffic(
        null,
        "Jitter Canary 26710917291-1 Golden Path Ln, Kansas City, MO",
      ),
    ).toBe(true);
  });

  it("does not flag real homeowners", () => {
    expect(
      looksLikeTestTraffic("Sheka Newsome", "8101 E 133rd ST, Grandview, MO"),
    ).toBe(false);
    expect(looksLikeTestTraffic(null, null)).toBe(false);
  });

  it("does not flag substring collisions with real names/streets", () => {
    // Codex P1: the matcher must follow the fixture contract (prefixes),
    // never generic substrings.
    expect(
      looksLikeTestTraffic("Bob Canary", "123 Canary Ln, Kansas City, MO"),
    ).toBe(false);
    expect(
      looksLikeTestTraffic("Jane Doe", "44 Jitterbug Dr, Liberty, MO"),
    ).toBe(false);
    expect(looksLikeTestTraffic("Canary Smith", null)).toBe(false);
    expect(looksLikeTestTraffic(null, "901 W Jittery Way")).toBe(false);
  });

  it("flags the JITTER-SANDRA-V1 writeback-proof address shape", () => {
    expect(
      looksLikeTestTraffic(null, "JITTER-SANDRA-V1 writeback proof mpwl5neb"),
    ).toBe(true);
  });
});

describe("listThreads — Needs Outcome", () => {
  it("marks replied early-stage threads with no outreach outcome", async () => {
    const now = Date.now();
    const messages = [
      {
        contact_id: "c-needs",
        property_id: "p-needs",
        body: "Yes, tell me more",
        direction: "inbound" as const,
        created_at: new Date(now).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-followup",
        property_id: "p-followup",
        conversation_id: "conv-followup",
        body: "I'll call tomorrow",
        direction: "outbound" as const,
        created_at: new Date(now - 1_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-followup",
        property_id: "p-followup",
        conversation_id: "conv-followup",
        body: "Yes, call me",
        direction: "inbound" as const,
        created_at: new Date(now - 2_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-dispo",
        property_id: "p-dispo",
        body: "No thanks",
        direction: "inbound" as const,
        created_at: new Date(now - 3_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-lead",
        property_id: "p-lead",
        body: "Call me",
        direction: "inbound" as const,
        created_at: new Date(now - 4_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-contacted",
        property_id: "p-contacted",
        body: "Maybe",
        direction: "inbound" as const,
        created_at: new Date(now - 5_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-terminal",
        property_id: "p-terminal",
        body: "I'm interested",
        direction: "inbound" as const,
        created_at: new Date(now - 6_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-dnc",
        property_id: "p-dnc",
        body: "Stop",
        direction: "inbound" as const,
        created_at: new Date(now - 7_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-sms-opted-out",
        property_id: "p-sms-opted-out",
        body: "Stop texting",
        direction: "inbound" as const,
        created_at: new Date(now - 8_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: null,
        conversation_id: "conv-mixed",
        body: "Yes, maybe",
        direction: "inbound" as const,
        created_at: new Date(now - 9_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: "p-mixed",
        conversation_id: "conv-mixed",
        body: "We reached out about this property",
        direction: "outbound" as const,
        created_at: new Date(now - 10_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-no-property",
        property_id: null,
        body: "Who is this?",
        direction: "inbound" as const,
        created_at: new Date(now - 11_000).toISOString(),
        read_at: null,
      },
    ];
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
          do_not_contact: m.contact_id === "c-dnc",
          sms_opted_out: m.contact_id === "c-sms-opted-out",
        },
      ]),
    );
    const properties = new Map([
      [
        "p-needs",
        {
          id: "p-needs",
          address: "1 Needs Ave",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-followup",
        {
          id: "p-followup",
          address: "2 Outbound St",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-dispo",
        {
          id: "p-dispo",
          address: "3 Dispo Dr",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: "not_interested",
          assigned_user_id: null,
        },
      ],
      [
        "p-lead",
        {
          id: "p-lead",
          address: "4 Lead Ln",
          city: null,
          state: null,
          status: "new_lead",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-contacted",
        {
          id: "p-contacted",
          address: "5 Contacted Ct",
          city: null,
          state: null,
          status: "contacted",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-terminal",
        {
          id: "p-terminal",
          address: "6 Terminal Trl",
          city: null,
          state: null,
          status: "interested",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-dnc",
        {
          id: "p-dnc",
          address: "7 Dnc Dr",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-sms-opted-out",
        {
          id: "p-sms-opted-out",
          address: "8 Sms Opt Out St",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-mixed",
        {
          id: "p-mixed",
          address: "9 Mixed Message Rd",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
    ]);

    const { supabase } = makeStub({ messages, contacts, properties });
    const threads = await listThreads(supabase, {});

    expect(
      threads
        .filter((thread) => thread.needsOutcome)
        .map((thread) => thread.propertyId),
    ).toEqual(["p-needs", "p-followup", "p-lead", "p-contacted", "p-mixed"]);
    expect(
      threads.find((thread) => thread.propertyId === "p-sms-opted-out")
        ?.isOptedOut,
    ).toBe(true);
  });

  it("filters to the same Needs Outcome predicate", async () => {
    const now = Date.now();
    const messages = [
      {
        contact_id: "c-needs",
        property_id: "p-needs",
        body: "Yes",
        direction: "inbound" as const,
        created_at: new Date(now).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-lead",
        property_id: "p-lead",
        body: "Already moved",
        direction: "inbound" as const,
        created_at: new Date(now - 1_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-contacted",
        property_id: "p-contacted",
        body: "Maybe later",
        direction: "inbound" as const,
        created_at: new Date(now - 2_000).toISOString(),
        read_at: null,
      },
    ];
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
        },
      ]),
    );
    const properties = new Map([
      [
        "p-needs",
        {
          id: "p-needs",
          address: "1 Needs Ave",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-lead",
        {
          id: "p-lead",
          address: "2 Lead Ln",
          city: null,
          state: null,
          status: "new_lead",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-contacted",
        {
          id: "p-contacted",
          address: "3 Contacted Ct",
          city: null,
          state: null,
          status: "contacted",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
    ]);

    const { supabase } = makeStub({ messages, contacts, properties });
    const threads = await listThreads(supabase, { needsOutcomeOnly: true });

    expect(threads.map((thread) => thread.propertyId)).toEqual([
      "p-needs",
      "p-lead",
      "p-contacted",
    ]);
    expect(threads.every((thread) => thread.needsOutcome)).toBe(true);
  });
});

describe("countNeedsOutcomeThreads", () => {
  it("counts the same durable Needs Outcome predicate", async () => {
    const now = Date.now();
    const messages = [
      {
        contact_id: "c-needs",
        property_id: "p-needs",
        body: "Yes",
        direction: "inbound" as const,
        created_at: new Date(now).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-followup",
        property_id: "p-followup",
        conversation_id: "conv-followup",
        body: "Checking in",
        direction: "outbound" as const,
        created_at: new Date(now - 1_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-followup",
        property_id: "p-followup",
        conversation_id: "conv-followup",
        body: "Call me tomorrow",
        direction: "inbound" as const,
        created_at: new Date(now - 2_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-lead",
        property_id: "p-lead",
        body: "Yes",
        direction: "inbound" as const,
        created_at: new Date(now - 3_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-contacted",
        property_id: "p-contacted",
        body: "Maybe",
        direction: "inbound" as const,
        created_at: new Date(now - 4_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-dispo",
        property_id: "p-dispo",
        body: "No",
        direction: "inbound" as const,
        created_at: new Date(now - 5_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-opted-out",
        property_id: "p-opted-out",
        body: "Stop",
        direction: "inbound" as const,
        created_at: new Date(now - 6_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-dnc",
        property_id: "p-dnc",
        body: "DNC",
        direction: "inbound" as const,
        created_at: new Date(now - 7_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-sms-opted-out",
        property_id: "p-sms-opted-out",
        body: "Stop texting",
        direction: "inbound" as const,
        created_at: new Date(now - 8_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: null,
        conversation_id: "conv-mixed",
        body: "Yes, maybe",
        direction: "inbound" as const,
        created_at: new Date(now - 9_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-mixed",
        property_id: "p-mixed",
        conversation_id: "conv-mixed",
        body: "We reached out about this property",
        direction: "outbound" as const,
        created_at: new Date(now - 10_000).toISOString(),
        read_at: null,
      },
    ];
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        {
          id: m.contact_id,
          first_name: null,
          last_name: null,
          entity_name: m.contact_id,
          phone_1: null,
          do_not_contact: m.contact_id === "c-dnc",
          sms_opted_out: m.contact_id === "c-sms-opted-out",
        },
      ]),
    );
    const propertySeeds: Array<[string, string, string | null]> = [
      ["p-needs", "prospect", null],
      ["p-followup", "prospect", null],
      ["p-lead", "new_lead", null],
      ["p-contacted", "contacted", null],
      ["p-dispo", "prospect", "not_interested"],
      ["p-opted-out", "prospect", null],
      ["p-dnc", "prospect", null],
      ["p-sms-opted-out", "prospect", null],
      ["p-mixed", "prospect", null],
    ];
    const properties = new Map(
      propertySeeds.map(([id, status, outreachDispo]) => [
        id,
        {
          id,
          address: null,
          city: null,
          state: null,
          status,
          outreach_dispo: outreachDispo,
          assigned_user_id: null,
        },
      ]),
    );

    const { supabase, inCalls } = makeStub({
      messages,
      contacts,
      properties,
      consentEvents: [
        {
          contact_id: "c-opted-out",
          event_type: "opt_out",
          occurred_at: new Date(now).toISOString(),
        },
      ],
    });

    const count = await countNeedsOutcomeThreads(supabase, {
      hideOptedOut: true,
    });
    const { supabase: listSupabase } = makeStub({
      messages,
      contacts,
      properties,
      consentEvents: [
        {
          contact_id: "c-opted-out",
          event_type: "opt_out",
          occurred_at: new Date(now).toISOString(),
        },
      ],
    });
    const listed = await listThreads(listSupabase, { needsOutcomeOnly: true });

    expect(count).toBe(5);
    expect(count).toBe(listed.length);
    expect(listed.map((thread) => thread.propertyId)).toContain("p-mixed");
    expect(inCalls.contacts).toHaveLength(1);
    expect(inCalls.properties).toHaveLength(1);
    expect(inCalls.consent_events).toHaveLength(1);
  });

  it("can exclude Jitter test traffic from the Needs Outcome count", async () => {
    const now = Date.now();
    const messages = [
      {
        contact_id: "c-real",
        property_id: "p-real",
        body: "Yes",
        direction: "inbound" as const,
        created_at: new Date(now).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-canary",
        property_id: "p-canary",
        body: "Canary reply",
        direction: "inbound" as const,
        created_at: new Date(now - 1_000).toISOString(),
        read_at: null,
      },
      {
        contact_id: "c-jitter-address",
        property_id: "p-jitter-address",
        body: "Fixture reply",
        direction: "inbound" as const,
        created_at: new Date(now - 2_000).toISOString(),
        read_at: null,
      },
    ];
    const contacts = new Map([
      [
        "c-real",
        {
          id: "c-real",
          first_name: "Real",
          last_name: "Seller",
          entity_name: null,
          phone_1: null,
        },
      ],
      [
        "c-canary",
        {
          id: "c-canary",
          first_name: "Canary",
          last_name: "CANARY-HAPPY-1777657500276",
          entity_name: null,
          phone_1: null,
        },
      ],
      [
        "c-jitter-address",
        {
          id: "c-jitter-address",
          first_name: "Fixture",
          last_name: "Owner",
          entity_name: null,
          phone_1: null,
        },
      ],
    ]);
    const properties = new Map([
      [
        "p-real",
        {
          id: "p-real",
          address: "1 Real Ave",
          city: "Kansas City",
          state: "MO",
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-canary",
        {
          id: "p-canary",
          address: "2 Test Ave",
          city: "Kansas City",
          state: "MO",
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
      [
        "p-jitter-address",
        {
          id: "p-jitter-address",
          address: "JITTER-SANDRA-V1 writeback proof abc123",
          city: null,
          state: null,
          status: "prospect",
          outreach_dispo: null,
          assigned_user_id: null,
        },
      ],
    ]);

    const { supabase, inCalls } = makeStub({
      messages,
      contacts,
      properties,
    });

    const count = await countNeedsOutcomeThreads(supabase, {
      hideTestTraffic: true,
    });

    expect(count).toBe(1);
    expect(inCalls.contacts).toHaveLength(1);
    expect(inCalls.consent_events).toHaveLength(1);
  });
});
