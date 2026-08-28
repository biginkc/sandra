import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

import { TracerfyProvider, tracerfyFromEnv } from "./tracerfy";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function mockFetch(response: { status: number; body: unknown }) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  } as unknown as Response);
}

describe("TracerfyProvider — constructor", () => {
  it("throws ConfigurationError when key is empty", () => {
    expect(() => new TracerfyProvider("")).toThrow(ConfigurationError);
  });
});

describe("TracerfyProvider — cached projection repair", () => {
  it("rehydrates a legacy primary-phone row without carrying historical credits", () => {
    const p = new TracerfyProvider("k");
    const repaired = p.normalizeCachedResult({
      propertyId: "prop-1",
      hit: true,
      persons: [
        {
          firstName: "Jane",
          lastName: "Doe",
          phones: [],
          emails: [],
        },
      ],
      creditsDeducted: 2,
      raw: {
        address: "1 Main",
        city: "KC",
        state: "MO",
        first_name: "Jane",
        last_name: "Doe",
        primary_phone: "8165550100",
        primary_phone_type: "Mobile",
      },
    });
    expect(repaired).toMatchObject({
      propertyId: "prop-1",
      hit: true,
      creditsDeducted: 0,
    });
    expect(repaired?.persons[0].phones[0]).toMatchObject({
      number: "8165550100",
      type: "Mobile",
    });
  });

  it("preserves an explicit provider-no-data cache row as a free miss", () => {
    const p = new TracerfyProvider("k");
    expect(
      p.normalizeCachedResult({
        propertyId: "prop-1",
        hit: false,
        persons: [],
        creditsDeducted: 0,
        raw: { provider_no_data: true },
      }),
    ).toMatchObject({ hit: false, persons: [], creditsDeducted: 0 });
  });

  it("rejects an unrecoverable legacy positive instead of turning it into a miss", () => {
    const p = new TracerfyProvider("k");
    expect(
      p.normalizeCachedResult({
        propertyId: "prop-1",
        hit: true,
        persons: [],
        creditsDeducted: 2,
        raw: {},
      }),
    ).toBeNull();
    expect(
      p.normalizeCachedResult({
        propertyId: "prop-1",
        hit: true,
        persons: [],
        creditsDeducted: 2,
        raw: { persons: { malformed: true } },
      }),
    ).toBeNull();
  });
});

describe("tracerfyFromEnv", () => {
  it("throws ConfigurationError when TRACERFY_API_KEY is unset", () => {
    const prev = process.env.TRACERFY_API_KEY;
    delete process.env.TRACERFY_API_KEY;
    expect(() => tracerfyFromEnv()).toThrow(ConfigurationError);
    if (prev !== undefined) process.env.TRACERFY_API_KEY = prev;
  });
});

describe("TracerfyProvider — lookupSingle", () => {
  it("sends Bearer auth header to /trace/lookup/", async () => {
    mockFetch({
      status: 200,
      body: { hit: false, persons_count: 0, credits_deducted: 0, persons: [] },
    });
    const p = new TracerfyProvider("test-token");
    await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
    });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://tracerfy.com/v1/api/trace/lookup/");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.address).toBe("1 Main");
    expect(body.find_owner).toBe(true);
  });

  it("keeps address-owned lookup when first/last name are supplied", async () => {
    mockFetch({
      status: 200,
      body: { hit: false, persons_count: 0, credits_deducted: 0, persons: [] },
    });
    const p = new TracerfyProvider("k");
    await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
      firstName: "Jane",
      lastName: "Doe",
    });
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.find_owner).toBe(true);
    expect(body.first_name).toBeUndefined();
    expect(body.last_name).toBeUndefined();
  });

  it("maps a hit response into SkipTraceResult shape", async () => {
    mockFetch({
      status: 200,
      body: {
        address: "1 Main",
        city: "KC",
        state: "MO",
        hit: true,
        persons_count: 1,
        credits_deducted: 5,
        persons: [
          {
            first_name: "Jane",
            last_name: "Doe",
            property_owner: true,
            phones: [
              { number: "+18165550100", type: "Mobile", dnc: false, rank: 1 },
            ],
            emails: [{ email: "jane@example.com", rank: 1 }],
          },
        ],
      },
    });
    const p = new TracerfyProvider("k");
    const result = await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
    });
    expect(result.hit).toBe(true);
    expect(result.creditsDeducted).toBe(5);
    expect(result.persons).toHaveLength(1);
    expect(result.persons[0].firstName).toBe("Jane");
    expect(result.persons[0].isOwner).toBe(true);
    expect(result.persons[0].phones[0]).toMatchObject({
      number: "+18165550100",
      type: "Mobile",
      dnc: false,
    });
    expect(result.persons[0].emails[0].email).toBe("jane@example.com");
  });

  it("treats nested TCPA and person-litigator flags as suppressed", async () => {
    mockFetch({
      status: 200,
      body: {
        hit: true,
        persons_count: 1,
        credits_deducted: 5,
        persons: [
          {
            first_name: "Risk",
            last_name: "Flag",
            litigator: true,
            phones: [
              {
                number: "+18165550100",
                type: "Mobile",
                dnc: false,
                tcpa: false,
                rank: 1,
              },
              {
                number: "+18165550101",
                type: "Mobile",
                dnc: false,
                tcpa: true,
                rank: 2,
              },
            ],
            emails: [],
          },
        ],
      },
    });
    const p = new TracerfyProvider("k");
    const result = await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
    });
    expect(result.persons[0].phones.every((phone) => phone.dnc)).toBe(true);
  });

  it("throws ProviderError on non-2xx", async () => {
    mockFetch({ status: 500, body: { error: "boom" } });
    const p = new TracerfyProvider("k");
    await expect(
      p.lookupSingle({
        propertyId: "prop-1",
        address: "1 Main",
        city: "KC",
        state: "MO",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError on 429 rate limit", async () => {
    mockFetch({ status: 429, body: { error: "rate limited" } });
    const p = new TracerfyProvider("k");
    await expect(
      p.lookupSingle({
        propertyId: "prop-1",
        address: "1 Main",
        city: "KC",
        state: "MO",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("parses persons[].mailing_address into SkipTracePerson.mailingAddress", async () => {
    mockFetch({
      status: 200,
      body: {
        address: "1 Main",
        city: "KC",
        state: "MO",
        hit: true,
        persons_count: 1,
        credits_deducted: 5,
        persons: [
          {
            first_name: "Jane",
            last_name: "Doe",
            property_owner: true,
            mailing_address: {
              street: "PO Box 111",
              city: "Austin",
              state: "TX",
              zip: "78702",
            },
            phones: [],
            emails: [],
          },
        ],
      },
    });
    const p = new TracerfyProvider("k");
    const result = await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
    });
    expect(result.persons[0].mailingAddress).toEqual({
      street: "PO Box 111",
      city: "Austin",
      state: "TX",
      zip: "78702",
    });
    // Result-level mailingAddress mirrors the owner's mailing
    expect(result.mailingAddress).toEqual({
      street: "PO Box 111",
      city: "Austin",
      state: "TX",
      zip: "78702",
    });
  });

  it("returns mailingAddress=null when no person has one", async () => {
    mockFetch({
      status: 200,
      body: {
        address: "1 Main",
        city: "KC",
        state: "MO",
        hit: true,
        persons_count: 1,
        credits_deducted: 5,
        persons: [{ first_name: "Jane", phones: [], emails: [] }],
      },
    });
    const p = new TracerfyProvider("k");
    const result = await p.lookupSingle({
      propertyId: "prop-1",
      address: "1 Main",
      city: "KC",
      state: "MO",
    });
    expect(result.persons[0].mailingAddress).toBeNull();
    expect(result.mailingAddress).toBeNull();
  });
});

describe("TracerfyProvider — submitBatch mailing address", () => {
  it("sends real homeowner mailing address when provided", async () => {
    mockFetch({
      status: 200,
      body: { queue_id: 1, credits_per_lead: 1, estimated_wait_seconds: 0 },
    });
    const p = new TracerfyProvider("k");
    await p.submitBatch([
      {
        propertyId: "prop-A",
        address: "1 Main St",
        city: "KC",
        state: "MO",
        // Owner is absentee — real mailing address differs from property
        mailingAddress: "PO Box 9000",
        mailingCity: "Springfield",
        mailingState: "MO",
        mailingZip: "65801",
      },
    ]);
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    const form = init.body as FormData;
    const rows = JSON.parse(form.get("json_data") as string);
    expect(rows[0].mail_address).toBe("PO Box 9000");
    expect(rows[0].mail_city).toBe("Springfield");
    expect(rows[0].mail_state).toBe("MO");
    expect(rows[0].mail_zip).toBe("65801");
  });

  it("falls back to property address when no mailing supplied", async () => {
    mockFetch({
      status: 200,
      body: { queue_id: 1, credits_per_lead: 1, estimated_wait_seconds: 0 },
    });
    const p = new TracerfyProvider("k");
    await p.submitBatch([
      { propertyId: "prop-A", address: "1 Main St", city: "KC", state: "MO" },
    ]);
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    const form = init.body as FormData;
    const rows = JSON.parse(form.get("json_data") as string);
    expect(rows[0].mail_address).toBe("1 Main St");
    expect(rows[0].mail_city).toBe("KC");
    expect(rows[0].mail_state).toBe("MO");
    // mail_address_column is required for normal/custom traces
    expect(form.get("mail_address_column")).toBe("mail_address");
    expect(form.get("mail_city_column")).toBe("mail_city");
    expect(form.get("mail_state_column")).toBe("mail_state");
  });
});

describe("TracerfyProvider — submitBatch", () => {
  it("posts multipart/form-data with json_data as a stringified-JSON form field", async () => {
    // Tracerfy's batch endpoint expects multipart/form-data — `json_data`
    // is a form field carrying a stringified JSON array. The previous
    // JSON-body shape returned HTTP 415 in production.
    mockFetch({
      status: 200,
      body: {
        message: "Queue created",
        queue_id: 42,
        status: "pending",
        rows_uploaded: 2,
        trace_type: "advanced",
        credits_per_lead: 2,
        estimated_wait_seconds: 30,
      },
    });
    const p = new TracerfyProvider("k");
    const ticket = await p.submitBatch([
      { propertyId: "prop-A", address: "1 Main", city: "KC", state: "MO" },
      { propertyId: "prop-B", address: "2 Main", city: "KC", state: "MO" },
    ]);
    expect(ticket.queueId).toBe("42");
    expect(ticket.creditsPerLead).toBe(2);
    expect(ticket.traceType).toBe("advanced");
    expect(ticket.estimatedWaitSeconds).toBe(30);

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;

    // json_data is a stringified array of row objects
    const jsonData = form.get("json_data");
    expect(typeof jsonData).toBe("string");
    const rows = JSON.parse(jsonData as string);
    expect(rows).toHaveLength(2);
    expect(rows[0].external_id).toBe("prop-A");
    expect(rows[1].external_id).toBe("prop-B");

    // Column-mapping fields ride alongside as separate form values.
    // Batch uses `advanced` (address-only owner resolution) so bulk
    // skip-trace works on records without owner names.
    expect(form.get("trace_type")).toBe("advanced");
    expect(form.get("address_column")).toBe("address");
    expect(form.get("city_column")).toBe("city");
    expect(form.get("state_column")).toBe("state");

    // Critical: no manual Content-Type — fetch must set it with the
    // boundary or the server can't parse the multipart body.
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("keeps the proven advanced mode when every row has a full owner name", async () => {
    mockFetch({
      status: 200,
      body: {
        queue_id: 43,
        trace_type: "advanced",
        credits_per_lead: 2,
        estimated_wait_seconds: 30,
      },
    });
    const p = new TracerfyProvider("k");
    const ticket = await p.submitBatch([
      {
        propertyId: "prop-A",
        address: "1 Main",
        city: "KC",
        state: "MO",
        firstName: "Jane",
        lastName: "Doe",
      },
      {
        propertyId: "prop-B",
        address: "2 Main",
        city: "KC",
        state: "MO",
        firstName: "John",
        lastName: "Smith",
      },
    ]);
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("trace_type")).toBe("advanced");
    expect(ticket.creditsPerLead).toBe(2);
    expect(ticket.traceType).toBe("advanced");
  });
});

describe("TracerfyProvider — pollBatch", () => {
  it("returns null when queue is still pending (object response)", async () => {
    mockFetch({ status: 200, body: { pending: true } });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result).toBeNull();
  });

  it("returns null for an EMPTY array — no rows yet, not zero-row completion", async () => {
    // 2026-06-12: empty-array polls were treated as completed batches,
    // which finalized jobs with blanket error items for every property.
    mockFetch({ status: 200, body: [] });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result).toBeNull();
  });

  it("parses the FLAT advanced-mode row shape (no persons array, no hit field)", async () => {
    // Live advanced-batch shape, first observed 2026-06-12: owner data
    // arrives as flat row-level fields. The previous parser looked only
    // for `persons`/`hit` and silently dropped every returned owner
    // across a 12,282-row production run.
    mockFetch({
      status: 200,
      body: [
        {
          id: 34477211,
          address: "7412 E 110th ST",
          city: "Kansas City",
          state: "MO",
          zip: "64134",
          first_name: "Julia",
          last_name: "Eichler",
          mobile_1: "8102802114",
          mobile_2: "8102802195",
          mobile_3: "",
          landline_1: "8107975891",
          landline_2: "",
          email_1: "julialynn2013@gmail.com",
          email_2: "",
          mail_address: "7412 E 110th ST",
          mail_city: "Kansas City",
          mail_state: "MO",
          mail_zip: "64134",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result).not.toBeNull();
    const row = result![0];
    expect(row.hit).toBe(true);
    expect(row.persons).toHaveLength(1);
    const person = row.persons[0];
    expect(person.firstName).toBe("Julia");
    expect(person.lastName).toBe("Eichler");
    expect(person.isOwner).toBe(true);
    // Mobiles rank ahead of landlines (phone_1 feeds SMS), empties dropped.
    expect(person.phones.map((ph) => ph.number)).toEqual([
      "8102802114",
      "8102802195",
      "8107975891",
    ]);
    expect(person.phones[0].type).toBe("Mobile");
    expect(person.phones[2].type).toBe("Landline");
    expect(person.phones.map((ph) => ph.rank)).toEqual([1, 2, 3]);
    expect(person.emails).toEqual([
      { email: "julialynn2013@gmail.com", rank: 1 },
    ]);
    expect(row.mailingAddress).toEqual({
      street: "7412 E 110th ST",
      city: "Kansas City",
      state: "MO",
      zip: "64134",
    });
    expect(row.matchedAddress).toEqual({
      address: "7412 E 110th ST",
      city: "Kansas City",
      state: "MO",
    });
  });

  it("keeps a paid name-only advanced row as an owner-resolution hit", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          address: "9 Name Only Rd",
          city: "KC",
          state: "MO",
          first_name: "Pat",
          last_name: "Owner",
          mobile_1: "",
          landline_1: "",
          email_1: "",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].hit).toBe(true);
    expect(result![0].persons).toHaveLength(1);
    expect(result![0].persons[0].lastName).toBe("Owner");
    expect(result![0].persons[0].phones).toHaveLength(0);
  });

  it("recovers and deduplicates primary_phone from the documented flat row", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          address: "8 Primary Phone Rd",
          city: "KC",
          state: "MO",
          first_name: "Primary",
          last_name: "Owner",
          primary_phone: "(816) 555-0100",
          primary_phone_type: "",
          mobile_1: "8165550100",
          landline_1: "8165550101",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].hit).toBe(true);
    expect(result![0].persons[0].phones).toEqual([
      {
        number: "(816) 555-0100",
        type: "Mobile",
        dnc: false,
        carrier: null,
        rank: 1,
      },
      {
        number: "8165550101",
        type: "Landline",
        dnc: false,
        carrier: null,
        rank: 2,
      },
    ]);
  });

  it("fails closed on flat DNC and TCPA flags when the provider supplies them", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          address: "7 Suppressed Rd",
          city: "KC",
          state: "MO",
          first_name: "Suppressed",
          last_name: "Owner",
          primary_phone: "8165550100",
          primary_phone_type: "mobile",
          primary_phone_tcpa: true,
          mobile_1: "8165550101",
          mobile_1_dnc: "yes",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].persons[0].phones).toEqual([
      expect.objectContaining({ number: "8165550100", dnc: true }),
      expect.objectContaining({ number: "8165550101", dnc: true }),
    ]);
  });

  it("respects provider-declared hit=false on nested-persons rows", async () => {
    // The persons-derived hit fallback applies ONLY when the row carries
    // no `hit` field (flat shape). An explicit provider hit:false must
    // not be promoted to a match (Codex re-review finding on PR #252).
    mockFetch({
      status: 200,
      body: [
        {
          address: "3 Declared Miss Ln",
          city: "KC",
          state: "MO",
          hit: false,
          credits_deducted: 0,
          persons: [
            {
              first_name: "Ghost",
              last_name: "Record",
              phones: [],
              emails: [],
            },
          ],
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].hit).toBe(false);
  });

  it("flat row with no owner data at all maps to hit=false, no persons", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          address: "1 Empty St",
          city: "KC",
          state: "MO",
          first_name: "",
          last_name: "",
          mobile_1: "",
          landline_1: "",
          email_1: "",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].hit).toBe(false);
    expect(result![0].persons).toHaveLength(0);
  });

  it("returns mapped results when complete (array response)", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          external_id: "prop-A",
          address: "1 Main",
          city: "KC",
          state: "MO",
          hit: true,
          persons_count: 1,
          credits_deducted: 1,
          persons: [
            {
              first_name: "A",
              last_name: "B",
              phones: [
                { number: "+18165550100", type: "Mobile", dnc: false, rank: 1 },
              ],
              emails: [],
            },
          ],
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result).not.toBeNull();
    expect(result![0].propertyId).toBe("prop-A");
    expect(result![0].hit).toBe(true);
  });

  it("parses row-level mail_address fields into result.mailingAddress", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          external_id: "prop-A",
          address: "1 Main",
          city: "KC",
          state: "MO",
          hit: true,
          credits_deducted: 1,
          persons: [],
          // Tracerfy's batch shape surfaces mailing fields at the row
          // level (no zip in batch responses per their docs).
          mail_address: "PO Box 222",
          mail_city: "Springfield",
          mail_state: "MO",
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].mailingAddress).toEqual({
      street: "PO Box 222",
      city: "Springfield",
      state: "MO",
      zip: null,
    });
  });

  it("populates matchedAddress from row.address/city/state (used by finalize fan-out)", async () => {
    // Tracerfy doesn't reliably round-trip external_id, so finalize
    // matches batch results back to our properties by address. The
    // adapter must echo the input address fields through every row.
    mockFetch({
      status: 200,
      body: [
        {
          // No external_id on the row — common in production payloads.
          address: "1 Main",
          city: "Kansas City",
          state: "MO",
          hit: true,
          credits_deducted: 1,
          persons: [],
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].matchedAddress).toEqual({
      address: "1 Main",
      city: "Kansas City",
      state: "MO",
    });
    expect(result![0].propertyId).toBe(""); // expected — see comment.
  });

  it("leaves mailingAddress null when no mail_* fields are present", async () => {
    mockFetch({
      status: 200,
      body: [
        {
          external_id: "prop-A",
          address: "1 Main",
          city: "KC",
          state: "MO",
          hit: false,
          credits_deducted: 0,
          persons: [],
        },
      ],
    });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result![0].mailingAddress).toBeNull();
  });
});

describe("TracerfyProvider — getBalance", () => {
  it("returns balance from /analytics/", async () => {
    mockFetch({ status: 200, body: { balance: 1234 } });
    const p = new TracerfyProvider("k");
    const balance = await p.getBalance();
    expect(balance).toBe(1234);
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a bounded timeout as a provider failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const p = new TracerfyProvider("k");
    await expect(p.getBalance()).rejects.toThrow(
      "Tracerfy balance request timed out",
    );
  });
});
