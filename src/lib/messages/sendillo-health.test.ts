import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadSendilloSmsHealth,
  summarizeSendilloSmsHealth,
  type SendilloSmsHealth,
  type SendilloSmsHealthMessageRow,
  type SendilloSmsHealthPropertyRow,
} from "./sendillo-health";
import type { Database } from "@/lib/supabase/types";

function msg(
  overrides: Partial<SendilloSmsHealthMessageRow> & { id: string; created_at: string },
): SendilloSmsHealthMessageRow {
  const base: SendilloSmsHealthMessageRow = {
    id: overrides.id,
    channel: "sms",
    provider: "sendillo",
    direction: "outbound",
    status: "sent",
    contact_id: "contact-1",
    property_id: "property-1",
    conversation_id: "conversation-1",
    created_at: overrides.created_at,
    read_at: "2026-06-18T10:00:00Z",
  };
  return { ...base, ...overrides };
}

function property(
  overrides: Partial<SendilloSmsHealthPropertyRow> & { id: string },
): SendilloSmsHealthPropertyRow {
  return {
    id: overrides.id,
    outreach_dispo: overrides.outreach_dispo ?? null,
    needs_human_attention: overrides.needs_human_attention ?? false,
  };
}

describe("summarizeSendilloSmsHealth", () => {
  it("counts only Sendillo SMS rows and groups non-queued rows into conversations", () => {
    const rows: SendilloSmsHealthMessageRow[] = [
      msg({
        id: "a-out",
        conversation_id: "conversation-a",
        property_id: "property-a",
        direction: "outbound",
        created_at: "2026-06-18T10:00:00Z",
      }),
      msg({
        id: "a-in",
        conversation_id: "conversation-a",
        property_id: "property-a",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T10:05:00Z",
      }),
      msg({
        id: "b-in",
        conversation_id: "conversation-b",
        property_id: "property-b",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T11:00:00Z",
      }),
      msg({
        id: "b-out",
        conversation_id: "conversation-b",
        property_id: "property-b",
        direction: "outbound",
        created_at: "2026-06-18T11:05:00Z",
      }),
      msg({
        id: "c-in",
        conversation_id: "conversation-c",
        property_id: "property-c",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T12:00:00Z",
      }),
      msg({
        id: "legacy-in",
        conversation_id: null,
        contact_id: "legacy-contact",
        property_id: "legacy-property",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T13:00:00Z",
      }),
      msg({
        id: "queued",
        conversation_id: "conversation-q",
        property_id: "property-a",
        direction: "outbound",
        status: "queued",
        created_at: "2026-06-18T14:00:00Z",
      }),
      msg({
        id: "dialpad",
        provider: "dialpad",
        conversation_id: "conversation-dialpad",
        property_id: "property-a",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T15:00:00Z",
      }),
      msg({
        id: "email",
        channel: "email",
        conversation_id: "conversation-email",
        property_id: "property-a",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T16:00:00Z",
      }),
    ];
    const properties = new Map(
      [
        property({
          id: "property-a",
          needs_human_attention: true,
        }),
        property({ id: "property-b" }),
        property({
          id: "property-c",
          outreach_dispo: "callback_requested",
        }),
        property({ id: "legacy-property" }),
      ].map((row) => [row.id, row]),
    );

    const summary = summarizeSendilloSmsHealth(rows, properties);

    expect(summary).toMatchObject({
      smsRows: 7,
      outboundMessages: 2,
      inboundMessages: 4,
      conversations: 4,
      latestInboundMissingDisposition: 2,
      unreadMissingDisposition: 3,
      humanAttentionMissingDisposition: 1,
      anyInboundMissingDisposition: 3,
      firstMessageAt: "2026-06-18T10:00:00Z",
      latestMessageAt: "2026-06-18T14:00:00Z",
    });
  });

  it("does not count unlinked latest threads as missing disposition", () => {
    const rows = [
      msg({
        id: "linked",
        conversation_id: "conversation-unknown",
        contact_id: "contact-unknown",
        property_id: "property-linked",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T09:00:00Z",
      }),
      msg({
        id: "unknown",
        conversation_id: "conversation-unknown",
        contact_id: null,
        property_id: null,
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T10:00:00Z",
      }),
    ];

    const summary = summarizeWithProperties(rows, [
      property({ id: "property-linked", needs_human_attention: true }),
    ]);

    expect(summary.conversations).toBe(1);
    expectNoDispositionGaps(summary);
  });

  it("uses the latest message property when a conversation changes linked properties", () => {
    const rows = [
      msg({
        id: "old-property",
        conversation_id: "conversation-change",
        property_id: "property-old",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T09:00:00Z",
      }),
      msg({
        id: "latest-property",
        conversation_id: "conversation-change",
        property_id: "property-latest",
        direction: "inbound",
        read_at: null,
        created_at: "2026-06-18T10:00:00Z",
      }),
    ];
    const summary = summarizeWithProperties(rows, [
      property({ id: "property-old", needs_human_attention: true }),
      property({ id: "property-latest", outreach_dispo: "not_interested" }),
    ]);

    expect(summary.conversations).toBe(1);
    expectNoDispositionGaps(summary);
  });
});

function expectNoDispositionGaps(summary: SendilloSmsHealth) {
  expect(summary.latestInboundMissingDisposition).toBe(0);
  expect(summary.unreadMissingDisposition).toBe(0);
  expect(summary.humanAttentionMissingDisposition).toBe(0);
  expect(summary.anyInboundMissingDisposition).toBe(0);
}

function summarizeWithProperties(
  rows: SendilloSmsHealthMessageRow[],
  properties: SendilloSmsHealthPropertyRow[],
) {
  return summarizeSendilloSmsHealth(
    rows,
    new Map(properties.map((row) => [row.id, row])),
  );
}

describe("loadSendilloSmsHealth", () => {
  it("keyset-paginates Sendillo message reads and chunks property lookups", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) =>
      msg({
        id: `page-${index.toString().padStart(4, "0")}`,
        conversation_id: `conversation-${index}`,
        property_id: `property-${index.toString().padStart(4, "0")}`,
        direction: "outbound",
        created_at: `2026-06-18T10:${(index % 60)
          .toString()
          .padStart(2, "0")}:00Z`,
      }),
    );
    const properties = rows.map((row) => property({ id: row.property_id! }));
    const supabase = new FakeSupabase(rows, properties);

    const summary = await loadSendilloSmsHealth(
      supabase as unknown as SupabaseClient<Database>,
    );

    expect(summary.smsRows).toBe(1001);
    expect(summary.conversations).toBe(1001);
    expect(supabase.messageFilters).toMatchObject({
      channel: "sms",
      provider: "sendillo",
    });
    expect(supabase.messageOrders).toEqual([
      ["created_at", false],
      ["id", false],
      ["created_at", false],
      ["id", false],
    ]);
    expect(supabase.messageLimits).toEqual([1000, 1000]);
    expect(supabase.messageCursors).toHaveLength(2);
    expect(supabase.messageCursors[0]).toBeNull();
    expect(supabase.messageCursors[1]).not.toBeNull();
    expect(supabase.propertyInCalls.map(([column]) => column)).toEqual([
      "id",
      "id",
      "id",
      "id",
      "id",
    ]);
    expect(supabase.propertyInCalls.map(([, ids]) => ids.length)).toEqual([
      250,
      250,
      250,
      250,
      1,
    ]);
    expect(new Set(supabase.propertyInCalls.flatMap(([, ids]) => ids))).toEqual(
      new Set(properties.map((row) => row.id)),
    );
  });
});

class FakeSupabase {
  messageLimits: number[] = [];
  messageCursors: Array<{ created_at: string; id: string } | null> = [];
  messageFilters: Record<string, string> = {};
  messageOrders: Array<[string, boolean]> = [];
  propertyInCalls: Array<[string, string[]]> = [];

  constructor(
    private readonly messages: SendilloSmsHealthMessageRow[],
    private readonly properties: SendilloSmsHealthPropertyRow[],
  ) {}

  from(table: string) {
    if (table === "messages") return new FakeMessagesQuery(this);
    if (table === "properties") return new FakePropertiesQuery(this, this.properties);
    throw new Error(`Unexpected table ${table}`);
  }

  getMessagesPage(limit: number, cursor: { created_at: string; id: string } | null) {
    this.messageLimits.push(limit);
    this.messageCursors.push(cursor);
    const sorted = [...this.messages].sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return b.id.localeCompare(a.id);
    });
    const filtered = cursor
      ? sorted.filter(
          (row) =>
            row.created_at < cursor.created_at ||
            (row.created_at === cursor.created_at && row.id < cursor.id),
        )
      : sorted;
    return filtered.slice(0, limit);
  }

  setMessageFilter(column: string, value: string) {
    this.messageFilters[column] = value;
  }

  addMessageOrder(column: string, ascending: boolean) {
    this.messageOrders.push([column, ascending]);
  }

  addPropertyInCall(column: string, ids: string[]) {
    this.propertyInCalls.push([column, ids]);
  }
}

class FakeMessagesQuery {
  private pageLimit = 1000;
  private cursor: { created_at: string; id: string } | null = null;

  constructor(private readonly supabase: FakeSupabase) {}
  select() {
    return this;
  }
  eq(column: string, value: string) {
    this.supabase.setMessageFilter(column, value);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.supabase.addMessageOrder(column, options?.ascending ?? true);
    return this;
  }
  limit(limit: number) {
    this.pageLimit = limit;
    return this;
  }
  or(condition: string) {
    const match = condition.match(
      /^created_at\.lt\.(.*),and\(created_at\.eq\.(.*),id\.lt\.(.*)\)$/,
    );
    if (!match) throw new Error(`Unexpected keyset condition ${condition}`);
    this.cursor = {
      created_at: match[1],
      id: match[3],
    };
    return this;
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: SendilloSmsHealthMessageRow[]; error: null }) => TResult1) | null,
    onrejected?: ((reason: unknown) => TResult2) | null,
  ) {
    return Promise.resolve({
      data: this.supabase.getMessagesPage(this.pageLimit, this.cursor),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

class FakePropertiesQuery {
  constructor(
    private readonly supabase: FakeSupabase,
    private readonly rows: SendilloSmsHealthPropertyRow[],
  ) {}
  select() {
    return this;
  }
  async in(column: string, ids: string[]) {
    this.supabase.addPropertyInCall(column, ids);
    return {
      data: this.rows.filter((row) => ids.includes(row.id)),
      error: null,
    };
  }
}
