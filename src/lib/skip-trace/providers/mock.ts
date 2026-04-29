import type {
  SkipTraceBatchTicket,
  SkipTraceInput,
  SkipTraceProvider,
  SkipTraceResult,
} from "../types";

/**
 * Deterministic in-process skip-trace provider for tests + local dev.
 *
 * Behavior is keyed off `address` so test cases can assert specific
 * shapes without a fixture layer:
 *
 *   - address starts with "MISS"     → hit=false, no persons, 0 credits
 *   - address starts with "DNC"      → hit=true, single phone with dnc=true
 *   - address starts with "EMAIL"    → hit=true, email-only (no phones)
 *   - address starts with "MULTI"    → hit=true, two persons, two phones each
 *   - address starts with "RAW"      → hit=true, phone returned as bare
 *                                       10 digits (Tracerfy's actual format)
 *   - otherwise                       → hit=true, one person, one mobile phone
 *
 * Batch submissions are queued in-memory and "complete" on the next
 * `pollBatch` call (or when `flushBatch(queueId)` is called manually).
 */
export class MockSkipTraceProvider implements SkipTraceProvider {
  readonly providerId = "mock";

  // queueId → snapshot of inputs. `pollBatch` consumes + returns results.
  private static queues = new Map<string, SkipTraceInput[]>();
  private static queueCounter = 0;
  private static balance = 10_000;

  // eslint-disable-next-line @typescript-eslint/require-await
  async lookupSingle(input: SkipTraceInput): Promise<SkipTraceResult> {
    return synthesize(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async submitBatch(inputs: SkipTraceInput[]): Promise<SkipTraceBatchTicket> {
    MockSkipTraceProvider.queueCounter += 1;
    const queueId = `mock-queue-${MockSkipTraceProvider.queueCounter}`;
    MockSkipTraceProvider.queues.set(queueId, inputs);
    return {
      queueId,
      estimatedWaitSeconds: 0,
      creditsPerLead: 1,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async pollBatch(queueId: string): Promise<SkipTraceResult[] | null> {
    const inputs = MockSkipTraceProvider.queues.get(queueId);
    if (!inputs) return null;
    MockSkipTraceProvider.queues.delete(queueId);
    // Batch results echo the input address (mirrors Tracerfy's row
    // shape) so the finalize step can match results back by address
    // even when external_id round-trip is missing.
    return inputs.map((input) => ({
      ...synthesize(input),
      matchedAddress: {
        address: input.address,
        city: input.city,
        state: input.state,
      },
    }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBalance(): Promise<number> {
    return MockSkipTraceProvider.balance;
  }

  /** Test helper — reset between tests. */
  static reset(): void {
    MockSkipTraceProvider.queues.clear();
    MockSkipTraceProvider.queueCounter = 0;
    MockSkipTraceProvider.balance = 10_000;
  }
}

function synthesize(input: SkipTraceInput): SkipTraceResult {
  const upper = input.address.toUpperCase();

  if (upper.startsWith("MISS")) {
    return {
      propertyId: input.propertyId,
      hit: false,
      persons: [],
      creditsDeducted: 0,
      raw: { mock: true, miss: true },
    };
  }

  if (upper.startsWith("DNC")) {
    return {
      propertyId: input.propertyId,
      hit: true,
      persons: [
        {
          firstName: input.firstName ?? "Mock",
          lastName: input.lastName ?? "Owner",
          phones: [{ number: "+18165550100", type: "Mobile", dnc: true, rank: 1 }],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 5,
      raw: { mock: true, dnc: true },
    };
  }

  if (upper.startsWith("EMAIL")) {
    return {
      propertyId: input.propertyId,
      hit: true,
      persons: [
        {
          firstName: input.firstName ?? "Mock",
          lastName: input.lastName ?? "Owner",
          phones: [],
          emails: [{ email: "owner@example.com", rank: 1 }],
          isOwner: true,
        },
      ],
      creditsDeducted: 5,
      raw: { mock: true, email: true },
    };
  }

  if (upper.startsWith("RAW")) {
    return {
      propertyId: input.propertyId,
      hit: true,
      persons: [
        {
          firstName: input.firstName ?? "Raw",
          lastName: input.lastName ?? "Owner",
          phones: [{ number: "8167416576", type: "Mobile", dnc: false, rank: 1 }],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 5,
      raw: { mock: true, raw_phone: true },
    };
  }

  if (upper.startsWith("MULTI")) {
    return {
      propertyId: input.propertyId,
      hit: true,
      persons: [
        {
          firstName: "Owner",
          lastName: "One",
          phones: [
            { number: "+18165550101", type: "Mobile", dnc: false, rank: 1 },
            { number: "+18165550102", type: "Landline", dnc: false, rank: 2 },
          ],
          emails: [{ email: "one@example.com", rank: 1 }],
          isOwner: true,
        },
        {
          firstName: "Owner",
          lastName: "Two",
          phones: [
            { number: "+18165550103", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
        },
      ],
      creditsDeducted: 5,
      raw: { mock: true, multi: true },
    };
  }

  return {
    propertyId: input.propertyId,
    hit: true,
    persons: [
      {
        firstName: input.firstName ?? "Mock",
        lastName: input.lastName ?? "Owner",
        phones: [{ number: "+18165550199", type: "Mobile", dnc: false, rank: 1 }],
        emails: [{ email: "mock@example.com", rank: 1 }],
        isOwner: true,
      },
    ],
    creditsDeducted: 5,
    raw: { mock: true, default: true },
  };
}
