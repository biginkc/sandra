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

  it("sets find_owner=false when first/last name supplied", async () => {
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
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.find_owner).toBe(false);
    expect(body.first_name).toBe("Jane");
    expect(body.last_name).toBe("Doe");
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
});

describe("TracerfyProvider — submitBatch", () => {
  it("sends a JSON batch with external_id round-trip and trace_type=normal", async () => {
    mockFetch({
      status: 200,
      body: {
        message: "Queue created",
        queue_id: 42,
        status: "pending",
        rows_uploaded: 2,
        trace_type: "normal",
        credits_per_lead: 1,
        estimated_wait_seconds: 30,
      },
    });
    const p = new TracerfyProvider("k");
    const ticket = await p.submitBatch([
      { propertyId: "prop-A", address: "1 Main", city: "KC", state: "MO" },
      { propertyId: "prop-B", address: "2 Main", city: "KC", state: "MO" },
    ]);
    expect(ticket.queueId).toBe("42");
    expect(ticket.creditsPerLead).toBe(1);
    expect(ticket.estimatedWaitSeconds).toBe(30);

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.json_data).toHaveLength(2);
    expect(body.json_data[0].external_id).toBe("prop-A");
    expect(body.json_data[1].external_id).toBe("prop-B");
    expect(body.trace_type).toBe("normal");
  });
});

describe("TracerfyProvider — pollBatch", () => {
  it("returns null when queue is still pending (object response)", async () => {
    mockFetch({ status: 200, body: { pending: true } });
    const p = new TracerfyProvider("k");
    const result = await p.pollBatch("42");
    expect(result).toBeNull();
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
});

describe("TracerfyProvider — getBalance", () => {
  it("returns balance from /analytics/", async () => {
    mockFetch({ status: 200, body: { balance: 1234 } });
    const p = new TracerfyProvider("k");
    const balance = await p.getBalance();
    expect(balance).toBe(1234);
  });
});
