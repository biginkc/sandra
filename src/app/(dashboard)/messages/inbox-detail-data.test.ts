import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";

import { DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS, fetchInboxDetail } from "./inbox-detail-data";

const dripScopeMigration = resolve(process.cwd(), "supabase/migrations/20260929235000_my_leads_drip_scope.sql");

it.skipIf(!existsSync(dripScopeMigration))("matches the drip scope SQL workflow operations", () => {
  const sql = readFileSync(dripScopeMigration, "utf8");
  const operations = sql.match(/payload->>'operation'\s+in\s*\(([^)]+)\)/)?.[1];
  expect(operations).toBeDefined();
  expect(operations?.match(/'[^']+'/g)?.map((operation) => operation.slice(1, -1)))
    .toEqual([...DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS]);
});

vi.mock("@/lib/messaging/opt-out-phone", () => ({
  isSmsPhoneSuppressed: vi.fn(async () => false),
}));

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const RECENT_PROPERTY_ID = "33333333-3333-4333-8333-333333333333";
const OLDER_PROPERTY_ID = "44444444-4444-4444-8444-444444444444";

function makeMessage(
  overrides: Partial<MessageRow> & {
    id: string;
    contact_id: string;
    property_id: string | null;
  },
): MessageRow {
  return {
    id: overrides.id,
    channel: "sms",
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    contact_id: overrides.contact_id,
    property_id: overrides.property_id,
    conversation_id: overrides.conversation_id ?? null,
    campaign_id: overrides.campaign_id ?? null,
    body: overrides.body ?? "hello",
    from_address: overrides.from_address ?? "+15551234567",
    to_address: overrides.to_address ?? "+18165550000",
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
    org_id: overrides.org_id ?? "org-1",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
  } as MessageRow;
}

function makeContact(
  overrides: Partial<ContactRow> & { id: string },
): ContactRow {
  return {
    id: overrides.id,
    contact_type: overrides.contact_type ?? "homeowner",
    org_id: overrides.org_id ?? "org-1",
    first_name: overrides.first_name ?? "Casey",
    last_name: overrides.last_name ?? "Contact",
    entity_name: overrides.entity_name ?? null,
    phone_1: overrides.phone_1 ?? "+15551234567",
    phone_1_type: overrides.phone_1_type ?? null,
    phone_2: overrides.phone_2 ?? null,
    phone_2_type: overrides.phone_2_type ?? null,
    phone_3: overrides.phone_3 ?? null,
    phone_3_type: overrides.phone_3_type ?? null,
    email: overrides.email ?? null,
    notes: overrides.notes ?? null,
    do_not_contact: overrides.do_not_contact ?? false,
    email_opted_out: overrides.email_opted_out ?? false,
    email_opted_out_at: overrides.email_opted_out_at ?? null,
    sms_opted_out: overrides.sms_opted_out ?? false,
    sms_opted_out_at: overrides.sms_opted_out_at ?? null,
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
  } as ContactRow;
}

function makeProperty(
  overrides: Partial<PropertyRow> & { id: string },
): PropertyRow {
  return {
    id: overrides.id,
    org_id: overrides.org_id ?? "org-1",
    address: overrides.address ?? "123 Main St",
    address_normalized: overrides.address_normalized ?? null,
    city: overrides.city ?? "Albany",
    state: overrides.state ?? "NY",
    zip: overrides.zip ?? "12207",
    county_id: overrides.county_id ?? null,
    market: overrides.market ?? null,
    status: overrides.status ?? "prospect",
    motivation_level: overrides.motivation_level ?? null,
    ai_responder_disabled: overrides.ai_responder_disabled ?? false,
    apn: overrides.apn ?? null,
    apn_normalized: overrides.apn_normalized ?? null,
    arv: overrides.arv ?? null,
    attom_id: overrides.attom_id ?? null,
    baths: overrides.baths ?? null,
    beds: overrides.beds ?? null,
    cass_raw_response: overrides.cass_raw_response ?? null,
    cass_status: overrides.cass_status ?? "unverified",
    cass_verified_at: overrides.cass_verified_at ?? null,
    assigned_user_id: overrides.assigned_user_id ?? null,
    absentee_flag: overrides.absentee_flag ?? null,
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-09T12:00:00.000Z",
    homeowner_contact_id: overrides.homeowner_contact_id ?? null,
    agent_contact_id: overrides.agent_contact_id ?? null,
    distress_flags: overrides.distress_flags ?? [],
    equity_estimate: overrides.equity_estimate ?? null,
    equity_pct: overrides.equity_pct ?? null,
    fips_code: overrides.fips_code ?? null,
    follow_up_at: overrides.follow_up_at ?? null,
    is_residential: overrides.is_residential ?? null,
    is_seasonal: overrides.is_seasonal ?? null,
    is_vacant: overrides.is_vacant ?? null,
    is_dnc_locked: overrides.is_dnc_locked ?? false,
    last_ai_escalation_at: overrides.last_ai_escalation_at ?? null,
    last_ai_escalation_reason: overrides.last_ai_escalation_reason ?? null,
    lat: overrides.lat ?? null,
    listing_price: overrides.listing_price ?? null,
    lon: overrides.lon ?? null,
    mortgage_balance: overrides.mortgage_balance ?? null,
    ncoa_verified_at: overrides.ncoa_verified_at ?? null,
    needs_human_attention: overrides.needs_human_attention ?? false,
    notes: overrides.notes ?? null,
    outreach_dispo: overrides.outreach_dispo ?? null,
    owner_moved_at: overrides.owner_moved_at ?? null,
    qualified_at: overrides.qualified_at ?? null,
    qualified_by: overrides.qualified_by ?? null,
    regrid_id: overrides.regrid_id ?? null,
    repair_estimate: overrides.repair_estimate ?? null,
    source: overrides.source ?? null,
    sqft: overrides.sqft ?? null,
    deleted_at: overrides.deleted_at ?? null,
    skip_trace_disabled: overrides.skip_trace_disabled ?? false,
    vacant_since: overrides.vacant_since ?? null,
    year_built: overrides.year_built ?? null,
    zpid: overrides.zpid ?? null,
  } as PropertyRow;
}

type SeedData = {
  messages: MessageRow[];
  contacts: ContactRow[];
  properties: PropertyRow[];
  ai_disposition_reviews?: Array<{
    id: string;
    org_id: string;
    property_id: string;
    conversation_id: string;
    source_inbound_message_id: string;
    disposition: string;
    ai_reason: string;
    status: string;
    created_at: string;
  }>;
  consent_events?: Array<{
    contact_id: string;
    channel: string;
    event_type: string;
    occurred_at: string;
  }>;
  sequence_enrollments?: Array<Record<string, unknown>>;
  sequence_step_runs?: Array<Record<string, unknown>>;
  sequences?: Array<Record<string, unknown>>;
  sequence_steps?: Array<Record<string, unknown>>;
  lead_events?: Array<Record<string, unknown>>;
  call_activities?: Array<Record<string, unknown>>;
  acquisition_attempts?: Array<{ recorded_at: string; occurred_at?: string }>;
};

function makeSupabaseStub(seed: SeedData) {
  function makeBuilder(table: keyof SeedData) {
    const filters: Array<{ kind: "eq" | "is" | "in" | "gt"; key: string; value: unknown }> =
      [];
    const negativeFilters: Array<{ key: string; value: unknown }> = [];
    let orderBy: { key: string; ascending: boolean } | null = null;
    let maxRows: number | null = null;
    let wantSingle = false;

    const builder = {
      select() {
        return builder;
      },
      eq(key: string, value: unknown) {
        filters.push({ kind: "eq", key, value });
        return builder;
      },
      in(key: string, values: unknown[]) {
        filters.push({ kind: "in", key, value: values });
        return builder;
      },
      gt(key: string, value: string) {
        filters.push({ kind: "gt", key, value });
        return builder;
      },
      is(key: string, value: unknown) {
        filters.push({ kind: "is", key, value });
        return builder;
      },
      neq(key: string, value: unknown) {
        negativeFilters.push({ key, value });
        return builder;
      },
      not(key: string, operator: "in", value: string) {
        if (operator !== "in") {
          throw new Error(
            "inbox detail test mock only supports not(..., 'in', value)",
          );
        }
        const values = value
          .replace(/^\(|\)$/g, "")
          .split(",")
          .map((item) => item.trim());
        for (const item of values) {
          negativeFilters.push({ key, value: item });
        }
        return builder;
      },
      order(key: string, options: { ascending: boolean }) {
        orderBy = { key, ascending: options.ascending };
        return builder;
      },
      limit(count: number) {
        maxRows = count;
        return builder;
      },
      maybeSingle() {
        wantSingle = true;
        return builder;
      },
      then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
        onfulfilled?:
          | ((value: {
              data: unknown;
              error: null;
            }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
    };

    function execute() {
      let rows = [...(seed[table] ?? [])];
      for (const filter of filters) {
        rows = rows.filter((row) => {
          const value = filter.key === "payload->>operation"
            ? ("payload" in row ? (row.payload as { operation?: string } | undefined)?.operation : undefined)
            : row[filter.key as keyof typeof row];
          if (filter.kind === "in") return (filter.value as unknown[]).includes(value);
          if (filter.kind === "gt") return String(value) > String(filter.value);
          return filter.kind === "eq"
            ? value === filter.value
            : value === null && filter.value === null;
        });
      }
      for (const filter of negativeFilters) {
        rows = rows.filter(
          (row) => row[filter.key as keyof typeof row] !== filter.value,
        );
      }

      if (orderBy) {
        rows.sort((left, right) => {
          const leftValue = left[orderBy!.key as keyof typeof left];
          const rightValue = right[orderBy!.key as keyof typeof right];
          const comparison = String(leftValue).localeCompare(
            String(rightValue),
          );
          return orderBy!.ascending ? comparison : -comparison;
        });
      }

      if (typeof maxRows === "number") {
        rows = rows.slice(0, maxRows);
      }

      return {
        data: wantSingle ? (rows[0] ?? null) : rows,
        error: null,
      };
    }

    return builder;
  }

  return {
    rpc(_name: string, args: { p_conversation_id?: string; p_after?: string }) {
      if (_name === "fn_has_acquisition_attempt_recorded_after") {
        return Promise.resolve({
          data: seed.acquisition_attempts?.some((attempt) => attempt.recorded_at > (args.p_after ?? "")) ?? false,
          error: null,
        });
      }
      const orgIds = [
        ...new Set(
          seed.messages
            .filter(
              (message) =>
                message.channel === "sms" &&
                message.conversation_id === args.p_conversation_id,
            )
            .map((message) => message.org_id),
        ),
      ];
      return Promise.resolve(
        orgIds.length > 1
          ? {
              data: null,
              error: { message: "SMS_CONVERSATION_ORG_AMBIGUOUS" },
            }
          : { data: orgIds[0] ?? null, error: null },
      );
    },
    from(table: keyof SeedData) {
      return makeBuilder(table);
    },
  };
}

describe("fetchInboxDetail", () => {
  // Stale URL formats (legacy keys, bare contact ids) are translated by
  // canonicalizeThreadId at the page boundary — see threading.test.ts.
  // fetchInboxDetail's contract is conversation-UUID-only.

  it.each(["received", "queued", "paused"] as const)(
    "fails closed when an older %s row for the conversation belongs to another organization",
    async (status) => {
      const supabase = makeSupabaseStub({
        messages: [
          makeMessage({
            id: "current-org-latest",
            contact_id: CONTACT_ID,
            property_id: RECENT_PROPERTY_ID,
            conversation_id: CONVERSATION_ID,
            org_id: "org-1",
            created_at: "2026-06-09T12:00:00.000Z",
          }),
          makeMessage({
            id: `other-org-old-${status}`,
            contact_id: CONTACT_ID,
            property_id: RECENT_PROPERTY_ID,
            conversation_id: CONVERSATION_ID,
            org_id: "org-2",
            status,
            created_at: "2026-06-08T12:00:00.000Z",
          }),
        ],
        contacts: [],
        properties: [],
      });

      await expect(
        fetchInboxDetail(supabase as never, CONVERSATION_ID),
      ).rejects.toThrow("SMS_CONVERSATION_ORG_AMBIGUOUS");
    },
  );

  it("detects an old cross-org row beyond the 100-message detail window", async () => {
    const recent = Array.from({ length: 100 }, (_, index) =>
      makeMessage({
        id: `recent-${index}`,
        contact_id: CONTACT_ID,
        property_id: RECENT_PROPERTY_ID,
        conversation_id: CONVERSATION_ID,
        org_id: "org-1",
        created_at: `2026-06-09T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }),
    );
    const supabase = makeSupabaseStub({
      messages: [
        ...recent,
        makeMessage({
          id: "old-contactless-paused-other-org",
          contact_id: CONTACT_ID,
          property_id: null,
          conversation_id: CONVERSATION_ID,
          org_id: "org-2",
          status: "paused",
          created_at: "2020-01-01T00:00:00.000Z",
        }),
      ],
      contacts: [],
      properties: [],
    });

    await expect(
      fetchInboxDetail(supabase as never, CONVERSATION_ID),
    ).rejects.toThrow("SMS_CONVERSATION_ORG_AMBIGUOUS");
  });

  it("hydrates a pending Sandra review whose property message is outside the 100-message window", async () => {
    const recentPropertyless = Array.from({ length: 100 }, (_, index) =>
      makeMessage({
        id: `recent-propertyless-${index}`,
        contact_id: CONTACT_ID,
        property_id: null,
        conversation_id: CONVERSATION_ID,
        created_at: new Date(
          Date.UTC(2026, 7, 27, 18, 0, 0) - index * 1_000,
        ).toISOString(),
      }),
    );
    const sourceMessage = makeMessage({
      id: "older-reviewed-source",
      contact_id: CONTACT_ID,
      property_id: OLDER_PROPERTY_ID,
      conversation_id: CONVERSATION_ID,
      created_at: "2026-08-26T18:00:00.000Z",
    });
    const supabase = makeSupabaseStub({
      messages: [...recentPropertyless, sourceMessage],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [
        makeProperty({ id: OLDER_PROPERTY_ID, outreach_dispo: "nurture" }),
      ],
      ai_disposition_reviews: [
        {
          id: "review-outside-window",
          org_id: "org-1",
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          source_inbound_message_id: sourceMessage.id,
          disposition: "nurture",
          ai_reason: "Homeowner asked to talk next month",
          status: "pending",
          created_at: "2026-08-26T18:00:01.000Z",
        },
      ],
    });

    const detail = await fetchInboxDetail(
      supabase as never,
      CONVERSATION_ID,
    );

    expect(detail?.initialMessages).toHaveLength(100);
    expect(detail?.propertyId).toBe(OLDER_PROPERTY_ID);
    expect(detail?.propertyAddress).toBe("123 Main St, Albany, NY");
    expect(detail?.aiDispositionReview).toMatchObject({
      id: "review-outside-window",
      disposition: "nurture",
      sourceInboundMessageId: "older-reviewed-source",
      sourceMessageBody: "hello",
    });
  });

  it("returns null when the conversation has no messages", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "other-conversation",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: "99999999-9999-4999-8999-999999999999",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    expect(
      await fetchInboxDetail(supabase as never, CONVERSATION_ID),
    ).toBeNull();
  });

  it("still resolves bare conversation UUID links directly", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "message-conversation",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          body: "conversation scoped message",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.threadId).toBe(CONVERSATION_ID);
    expect(detail?.conversationId).toBe(CONVERSATION_ID);
    expect(detail?.contactId).toBe(CONTACT_ID);
    expect(detail?.homeownerContactId).toBeNull();
    expect(detail?.agentContactId).toBeNull();
    expect(detail?.contactDoNotContact).toBe(false);
    expect(detail?.contactSmsOptedOut).toBe(false);
    expect(detail?.smsConsentState).toBe("no_consent");
    expect(detail?.phoneSuppressed).toBe(false);
    expect(detail?.smsSafetyReadFailed).toBe(false);
    expect(detail?.isDncLocked).toBe(false);
  });

  it("hydrates only the pending Sandra AI review for the exact conversation and property", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "message-with-review",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
      ai_disposition_reviews: [
        {
          id: "review-exact",
          org_id: "org-1",
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          source_inbound_message_id: "message-with-review",
          disposition: "not_interested",
          ai_reason: "Homeowner said no",
          status: "pending",
          created_at: "2026-08-27T14:00:00.000Z",
        },
        {
          id: "review-confirmed",
          org_id: "org-1",
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          source_inbound_message_id: "older-message",
          disposition: "wrong_number",
          ai_reason: "Historical",
          status: "confirmed",
          created_at: "2026-08-26T14:00:00.000Z",
        },
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.aiDispositionReview).toEqual({
      id: "review-exact",
      status: "pending",
      disposition: "not_interested",
      reason: "Homeowner said no",
      sourceInboundMessageId: "message-with-review",
      sourceMessageBody: "hello",
      createdAt: "2026-08-27T14:00:00.000Z",
    });
  });

  it("surfaces an authoritative phone-suppression read failure", async () => {
    vi.mocked(isSmsPhoneSuppressed).mockRejectedValueOnce(
      new Error("suppression unavailable"),
    );
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "safety-read-failure",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.phoneSuppressed).toBeNull();
    expect(detail?.smsSafetyReadFailed).toBe(true);
  });

  it("fails closed when the message contact metadata is missing", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "missing-contact-metadata",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
        }),
      ],
      contacts: [],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).toMatchObject({
      contactId: CONTACT_ID,
      smsConsentState: null,
      phoneSuppressed: null,
      smsSafetyReadFailed: true,
    });
  });

  it("returns existing contact restrictions and the permanent property lock", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "restricted-conversation",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          do_not_contact: true,
          sms_opted_out: true,
        }),
      ],
      properties: [
        makeProperty({
          id: RECENT_PROPERTY_ID,
          is_dnc_locked: true,
          homeowner_contact_id: CONTACT_ID,
        }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).toMatchObject({
      contactDoNotContact: true,
      contactSmsOptedOut: true,
      isDncLocked: true,
    });
  });

  it("retains queued and paused Outbox rows in the conversation after reload", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "queued-draft",
          contact_id: CONTACT_ID,
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          status: "queued",
          body: "queued draft waiting for release",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
        makeMessage({
          id: "paused-draft",
          contact_id: CONTACT_ID,
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          status: "paused",
          body: "paused draft waiting for resume",
          created_at: "2026-06-09T12:01:00.000Z",
        }),
        makeMessage({
          id: "live-thread",
          contact_id: CONTACT_ID,
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          status: "received",
          body: "live inbound thread",
          created_at: "2026-06-08T12:00:00.000Z",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [
        makeProperty({
          id: OLDER_PROPERTY_ID,
          address: "100 Live Ave",
          homeowner_contact_id: CONTACT_ID,
        }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.threadId).toBe(CONVERSATION_ID);
    expect(detail?.initialMessages.map((message) => message.id)).toEqual([
      "live-thread",
      "queued-draft",
      "paused-draft",
    ]);
    expect(detail?.propertyAddress).toContain("100 Live Ave");
    expect(detail?.homeownerContactId).toBe(CONTACT_ID);
  });

  it("uses the first non-null property in a mixed conversation, even when the latest row is propertyless", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "older-linked",
          contact_id: CONTACT_ID,
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          body: "linked context",
          created_at: "2026-06-08T12:00:00.000Z",
        }),
        makeMessage({
          id: "latest-propertyless",
          contact_id: CONTACT_ID,
          property_id: null,
          conversation_id: CONVERSATION_ID,
          body: "latest reply without property",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [
        makeProperty({
          id: OLDER_PROPERTY_ID,
          address: "200 Mixed Row Ave",
          agent_contact_id: CONTACT_ID,
        }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.propertyId).toBe(OLDER_PROPERTY_ID);
    expect(detail?.propertyAddress).toContain("200 Mixed Row Ave");
    expect(detail?.agentContactId).toBe(CONTACT_ID);
  });

  it("uses the newest non-null property when a malformed conversation has two linked properties", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "older-linked",
          contact_id: CONTACT_ID,
          property_id: OLDER_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          body: "older linked context",
          created_at: "2026-06-08T12:00:00.000Z",
        }),
        makeMessage({
          id: "newer-linked",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          body: "newer linked context",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [
        makeProperty({ id: OLDER_PROPERTY_ID, address: "100 Older Ave" }),
        makeProperty({ id: RECENT_PROPERTY_ID, address: "200 Newer Ave" }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.propertyId).toBe(RECENT_PROPERTY_ID);
    expect(detail?.propertyAddress).toContain("200 Newer Ave");
  });

  it("derives the displayed phone from the latest inbound address pair", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "secondary-inbound",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          from_address: "+15550000002",
          to_address: "+18162804181",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          phone_1: "+15550000001",
          phone_2: "+15550000002",
        }),
      ],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.contactPhone).toBe("+15550000002");
    expect(detail?.threadCustomerPhone).toBe("+15550000002");
    expect(detail?.threadBusinessPhone).toBe("+18162804181");
    expect(detail?.replyToPhone).toBe("+15550000002");
  });

  it("derives the displayed phone from the latest outbound address pair", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "latest-outbound",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          direction: "outbound",
          status: "sent",
          from_address: "+18162804182",
          to_address: "+15550000003",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          phone_1: "+15550000001",
          phone_3: "+15550000003",
        }),
      ],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.threadCustomerPhone).toBe("+15550000003");
    expect(detail?.threadBusinessPhone).toBe("+18162804182");
    expect(detail?.replyToPhone).toBe("+15550000003");
  });

  it("uses the newest message for phone routing even when the conversation has more than 100 rows", async () => {
    const olderMessages = Array.from({ length: 100 }, (_, index) =>
      makeMessage({
        id: `older-${index}`,
        contact_id: CONTACT_ID,
        property_id: RECENT_PROPERTY_ID,
        conversation_id: CONVERSATION_ID,
        from_address: "+15550000001",
        to_address: "+18162804181",
        created_at: new Date(Date.UTC(2026, 5, 9, 10, index, 0)).toISOString(),
      }),
    );
    const supabase = makeSupabaseStub({
      messages: [
        ...olderMessages,
        makeMessage({
          id: "actual-latest",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          from_address: "+15550000003",
          to_address: "+18162804182",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          phone_1: "+15550000001",
          phone_3: "+15550000003",
        }),
      ],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.initialMessages).toHaveLength(100);
    expect(detail?.initialMessages.at(-1)?.id).toBe("actual-latest");
    expect(detail?.threadCustomerPhone).toBe("+15550000003");
    expect(detail?.threadBusinessPhone).toBe("+18162804182");
    expect(detail?.replyToPhone).toBe("+15550000003");
  });

  it("ignores newer queued and failed rows when deriving the reply route", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "authoritative-inbound",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          direction: "inbound",
          status: "received",
          from_address: "+15550000001",
          to_address: "+18162804181",
          created_at: "2026-06-09T12:00:00.000Z",
        }),
        makeMessage({
          id: "newer-failed",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          direction: "outbound",
          status: "failed",
          from_address: "+18162804182",
          to_address: "+15550000002",
          created_at: "2026-06-09T12:01:00.000Z",
        }),
        makeMessage({
          id: "newest-queued",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          direction: "outbound",
          status: "queued",
          from_address: "+18162804183",
          to_address: "+15550000003",
          created_at: "2026-06-09T12:02:00.000Z",
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          phone_1: "+15550000001",
          phone_2: "+15550000002",
          phone_3: "+15550000003",
        }),
      ],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.initialMessages).toHaveLength(3);
    expect(detail?.threadCustomerPhone).toBe("+15550000001");
    expect(detail?.threadBusinessPhone).toBe("+18162804181");
    expect(detail?.replyToPhone).toBe("+15550000001");
  });

  it("classifies the exact saved thread phone as a landline", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "landline-inbound",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          direction: "inbound",
          status: "received",
          from_address: "+15550000002",
          to_address: "+18162804181",
        }),
      ],
      contacts: [
        makeContact({
          id: CONTACT_ID,
          phone_1: "+15550000001",
          phone_1_type: "mobile",
          phone_2: "+15550000002",
          phone_2_type: "landline",
        }),
      ],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.threadCustomerPhone).toBe("+15550000002");
    expect(detail?.replyToPhone).toBeNull();
    expect(detail?.replyToPhoneLineType).toBe("landline");
  });

  it("keeps contact-only ambiguous threads propertyless while showing the sender number", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "ambiguous-propertyless",
          contact_id: CONTACT_ID,
          property_id: null,
          conversation_id: CONVERSATION_ID,
          from_address: "+15550000004",
          to_address: "+18162804181",
          metadata: { routing: "ambiguous_recipient_number" },
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID, phone_2: "+15550000004" })],
      properties: [],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail?.propertyId).toBeNull();
    expect(detail?.propertyAddress).toBeNull();
    expect(detail?.threadCustomerPhone).toBe("+15550000004");
    expect(detail?.threadBusinessPhone).toBe("+18162804181");
    expect(detail?.replyToPhone).toBe("+15550000004");
  });

  it("attributes only step-run messages and marks the reply to the paused drip", async () => {
    const seed: SeedData = {
      messages: [
        makeMessage({ id: "drip-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:00:00Z" }),
        makeMessage({ id: "manual-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T11:59:00Z" }),
        makeMessage({ id: "reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "inbound", created_at: "2026-06-09T12:02:00Z" }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
      sequence_enrollments: [{ id: "enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, contact_id: CONTACT_ID, sequence_id: "drip", status: "paused", pause_reason: "inbound_reply", current_step_index: 1, enrolled_at: "2026-06-09T11:00:00Z", updated_at: "2026-06-09T12:02:00Z" }],
      sequence_step_runs: [{ message_id: "drip-text", enrollment_id: "enrollment", sequence_enrollments: { org_id: "org-1", sequence_id: "drip" }, sequence_steps: { sequence_id: "drip", step_index: 0 } }],
      sequences: [{ id: "drip", org_id: "org-1", name: "Seller follow-up" }],
      sequence_steps: [{ id: "step-1", sequence_id: "drip" }, { id: "step-2", sequence_id: "drip" }],
    };
    const supabase = makeSupabaseStub(seed);
    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);
    expect(detail?.drip).toMatchObject({ name: "Seller follow-up", step: 2, total: 2, replied: true, stoppedAt: "2026-06-09T12:02:00Z", timeZone: "America/Chicago" });
    expect(detail?.dripMessageLabels).toEqual({ "drip-text": "Drip · Seller follow-up · text 1 of 2" });
    expect(detail?.dripReplyMessageIds).toEqual(["reply"]);
    expect(detail?.dripReplyLabels).toEqual({ reply: "Reply to drip text 1" });
    seed.messages.push(makeMessage({ id: "rep-reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:03:00Z" }));
    const afterRepAction = await fetchInboxDetail(supabase as never, CONVERSATION_ID);
    expect(afterRepAction?.drip?.replied).toBe(false);
    expect(afterRepAction?.dripReplyMessageIds).toEqual(["reply"]);
    seed.sequence_enrollments![0].pause_reason = "rep_sms_human_takeover";
    const takeover = await fetchInboxDetail(supabase as never, CONVERSATION_ID);
    expect(takeover?.drip?.replied).toBe(false);
    seed.sequence_enrollments![0].pause_reason = "manual";
    const manuallyPaused = await fetchInboxDetail(supabase as never, CONVERSATION_ID);
    expect(manuallyPaused?.drip).toMatchObject({ status: "paused", replied: false });
  });

  it.each(["dispo", "logged attempt", ...DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS])(
    "clears outstanding reply after %s", async (action) => {
    const seed: SeedData = {
      messages: [
        makeMessage({ id: "drip-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:00:00Z" }),
        makeMessage({ id: "reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "inbound", created_at: "2026-06-09T12:02:00Z" }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })], properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
      sequence_enrollments: [{ id: "enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, sequence_id: "drip", status: "paused", pause_reason: "inbound_reply", current_step_index: 0, enrolled_at: "2026-06-09T11:00:00Z" }],
      sequence_step_runs: [{ message_id: "drip-text", enrollment_id: "enrollment", sequence_enrollments: { org_id: "org-1" }, sequence_steps: { sequence_id: "drip", step_index: 0 } }],
      sequences: [{ id: "drip", org_id: "org-1", name: "Seller follow-up" }],
      sequence_steps: [{ id: "step-1", sequence_id: "drip" }],
      lead_events: action === "dispo" ? [{ id: "event", org_id: "org-1", property_id: RECENT_PROPERTY_ID, event_type: "dispo_set", actor_type: "user", created_at: "2026-06-09T12:03:00Z" }] :
        DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS.some((operation) => operation === action)
          ? [{ id: "event", org_id: "org-1", property_id: RECENT_PROPERTY_ID, event_type: "my_leads_workflow", actor_type: "user", payload: { operation: action }, created_at: "2026-06-09T12:03:00Z" }] : [],
      acquisition_attempts: action === "logged attempt" ? [{ recorded_at: "2026-06-09T12:03:00Z", occurred_at: "2026-06-09T11:00:00Z" }] : [],
    };
    const detail = await fetchInboxDetail(makeSupabaseStub(seed) as never, CONVERSATION_ID);
    expect(detail?.drip?.replied).toBe(false);
    expect(detail?.dripReplyLabels).toEqual({ reply: "Reply to drip text 1" });
  });

  it.each(["call", "campaign", "ai", "step-run", "other workflow", "old attempt"])(
    "keeps the reply outstanding after %s", async (action) => {
      const seed: SeedData = {
        messages: [
          makeMessage({ id: "drip-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:00:00Z" }),
          makeMessage({ id: "reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "inbound", created_at: "2026-06-09T12:02:00Z" }),
        ],
        contacts: [makeContact({ id: CONTACT_ID })], properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
        sequence_enrollments: [{ id: "enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, sequence_id: "drip", status: "paused", pause_reason: "inbound_reply", current_step_index: 0, enrolled_at: "2026-06-09T11:00:00Z" }],
        sequence_step_runs: [{ message_id: "drip-text", enrollment_id: "enrollment", sequence_enrollments: { org_id: "org-1" }, sequence_steps: { sequence_id: "drip", step_index: 0 } }],
        sequences: [{ id: "drip", org_id: "org-1", name: "Seller follow-up" }],
        sequence_steps: [{ id: "step-1", sequence_id: "drip" }],
        call_activities: action === "call" ? [{ id: "call", org_id: "org-1", property_id: RECENT_PROPERTY_ID, call_purpose: "customer", created_at: "2026-06-09T12:03:00Z" }] : [],
        lead_events: action === "other workflow" ? [{ id: "event", org_id: "org-1", property_id: RECENT_PROPERTY_ID, event_type: "my_leads_workflow", actor_type: "user", payload: { operation: "unrelated" }, created_at: "2026-06-09T12:03:00Z" }] : [],
        acquisition_attempts: action === "old attempt" ? [{ recorded_at: "2026-06-09T12:01:00Z", occurred_at: "2026-06-09T12:03:00Z" }] : [],
      };
      if (["campaign", "ai", "step-run"].includes(action)) {
        seed.messages.push(makeMessage({ id: "later-outbound", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:03:00Z", campaign_id: action === "campaign" ? "campaign" : null, metadata: action === "ai" ? { generated_by: "another_generator" } : null }));
        if (action === "step-run") seed.sequence_step_runs!.push({ message_id: "later-outbound", enrollment_id: "enrollment", sequence_enrollments: { org_id: "org-1" }, sequence_steps: { sequence_id: "drip", step_index: 0 } });
      }
      const detail = await fetchInboxDetail(makeSupabaseStub(seed) as never, CONVERSATION_ID);
      expect(detail?.drip?.replied).toBe(true);
    });

  it("keeps attribution after a drip completed before the inbound reply", async () => {
    const seed: SeedData = {
      messages: [
        makeMessage({ id: "drip-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:00:00Z" }),
        makeMessage({ id: "reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "inbound", created_at: "2026-06-09T12:02:00Z" }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })], properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
      sequence_enrollments: [{ id: "enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, sequence_id: "drip", status: "completed", pause_reason: null, current_step_index: 0, enrolled_at: "2026-06-09T11:00:00Z" }],
      sequence_step_runs: [{ message_id: "drip-text", enrollment_id: "enrollment", sequence_enrollments: { org_id: "org-1" }, sequence_steps: { sequence_id: "drip", step_index: 0 } }],
      sequences: [{ id: "drip", org_id: "org-1", name: "Seller follow-up" }],
      sequence_steps: [{ id: "step-1", sequence_id: "drip" }],
    };
    const detail = await fetchInboxDetail(makeSupabaseStub(seed) as never, CONVERSATION_ID);
    expect(detail?.drip).toMatchObject({ name: "Seller follow-up", status: "completed", replied: true });
    expect(detail?.dripReplyLabels).toEqual({ reply: "Reply to drip text 1" });
  });

  it("keeps an old drip reply marker without stopping a newer active enrollment", async () => {
    const seed: SeedData = {
      messages: [
        makeMessage({ id: "a-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:00:00Z" }),
        makeMessage({ id: "a-reply", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "inbound", created_at: "2026-06-09T12:02:00Z" }),
        makeMessage({ id: "rep-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T12:03:00Z" }),
        makeMessage({ id: "b-text", contact_id: CONTACT_ID, property_id: RECENT_PROPERTY_ID, conversation_id: CONVERSATION_ID, direction: "outbound", created_at: "2026-06-09T13:00:00Z" }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [makeProperty({ id: RECENT_PROPERTY_ID })],
      sequence_enrollments: [
        { id: "a-enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, sequence_id: "a", status: "completed", pause_reason: null, current_step_index: 0, enrolled_at: "2026-06-09T11:00:00Z" },
        { id: "b-enrollment", org_id: "org-1", property_id: RECENT_PROPERTY_ID, sequence_id: "b", status: "active", pause_reason: null, current_step_index: 0, enrolled_at: "2026-06-09T12:30:00Z" },
      ],
      sequence_step_runs: [
        { message_id: "a-text", enrollment_id: "a-enrollment", sequence_enrollments: { org_id: "org-1", sequence_id: "a" }, sequence_steps: { sequence_id: "a", step_index: 0 } },
        { message_id: "b-text", enrollment_id: "b-enrollment", sequence_enrollments: { org_id: "org-1", sequence_id: "b" }, sequence_steps: { sequence_id: "b", step_index: 0 } },
      ],
      sequences: [{ id: "a", org_id: "org-1", name: "A" }, { id: "b", org_id: "org-1", name: "B" }],
      sequence_steps: [{ id: "a-step", sequence_id: "a" }, { id: "b-step", sequence_id: "b" }, { id: "b-step-2", sequence_id: "b" }],
    };
    const detail = await fetchInboxDetail(makeSupabaseStub(seed) as never, CONVERSATION_ID);
    expect(detail?.drip).toMatchObject({ enrollmentId: "b-enrollment", name: "B", status: "active", step: 1, total: 2, replied: false, stoppedAt: null });
    expect(detail?.dripReplyLabels).toEqual({ "a-reply": "Reply to drip text 1" });
    expect(detail?.dripReplyMessageIds).toEqual(["a-reply"]);
  });
});
