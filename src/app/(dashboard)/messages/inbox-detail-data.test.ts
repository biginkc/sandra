import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { fetchInboxDetail } from "./inbox-detail-data";

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
    body: overrides.body ?? "hello",
    from_address: overrides.from_address ?? "+15551234567",
    to_address: overrides.to_address ?? "+18165550000",
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
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
    phone_2: overrides.phone_2 ?? null,
    phone_3: overrides.phone_3 ?? null,
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
};

function makeSupabaseStub(seed: SeedData) {
  function makeBuilder(table: keyof SeedData) {
    const filters: Array<{ kind: "eq" | "is"; key: string; value: unknown }> = [];
    const negativeFilters: Array<{ key: string; value: unknown }> = [];
    let orderBy: { key: string; ascending: boolean } | null = null;
    let maxRows: number | null = null;
    let wantSingle = false;

    const builder = {
      select(_columns?: string) {
        return builder;
      },
      eq(key: string, value: unknown) {
        filters.push({ kind: "eq", key, value });
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
          | ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
    };

    function execute() {
      let rows = [...seed[table]];
      for (const filter of filters) {
        rows = rows.filter((row) => {
          const value = row[filter.key as keyof typeof row];
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
          const comparison = String(leftValue).localeCompare(String(rightValue));
          return orderBy!.ascending ? comparison : -comparison;
        });
      }

      if (typeof maxRows === "number") {
        rows = rows.slice(0, maxRows);
      }

      return {
        data: wantSingle ? rows[0] ?? null : rows,
        error: null,
      };
    }

    return builder;
  }

  return {
    from(table: keyof SeedData) {
      return makeBuilder(table);
    },
  };
}

describe("fetchInboxDetail", () => {
  // Stale URL formats (legacy keys, bare contact ids) are translated by
  // canonicalizeThreadId at the page boundary — see threading.test.ts.
  // fetchInboxDetail's contract is conversation-UUID-only.

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

    expect(await fetchInboxDetail(supabase as never, CONVERSATION_ID)).toBeNull();
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
  });

  it("ignores queued rows in the conversation", async () => {
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
        makeProperty({ id: OLDER_PROPERTY_ID, address: "100 Live Ave" }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.threadId).toBe(CONVERSATION_ID);
    expect(detail?.initialMessages.map((message) => message.id)).toEqual([
      "live-thread",
    ]);
    expect(detail?.propertyAddress).toContain("100 Live Ave");
  });

  it("hides property metadata when the linked property was soft-deleted", async () => {
    const supabase = makeSupabaseStub({
      messages: [
        makeMessage({
          id: "deleted-property-thread",
          contact_id: CONTACT_ID,
          property_id: RECENT_PROPERTY_ID,
          conversation_id: CONVERSATION_ID,
          body: "thread survives but property is deleted",
        }),
      ],
      contacts: [makeContact({ id: CONTACT_ID })],
      properties: [
        makeProperty({
          id: RECENT_PROPERTY_ID,
          address: "404 Archived Ln",
          deleted_at: "2026-06-17T12:00:00.000Z",
        }),
      ],
    });

    const detail = await fetchInboxDetail(supabase as never, CONVERSATION_ID);

    expect(detail).not.toBeNull();
    expect(detail?.propertyId).toBeNull();
    expect(detail?.propertyAddress).toBeNull();
    expect(detail?.propertyStatus).toBeNull();
    expect(detail?.outreachDispo).toBeNull();
  });
});
