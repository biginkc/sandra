import { describe, expect, it, vi } from "vitest";

import { computeConsentState, recordConsentEvent } from "./consent";

function ev(event_type: string, occurred_at: string) {
  return { event_type, occurred_at };
}

describe("computeConsentState", () => {
  it("returns no_consent when the event log is empty", () => {
    expect(computeConsentState([])).toBe("no_consent");
  });

  it("returns can_send_marketing on a written opt-in", () => {
    expect(
      computeConsentState([ev("opt_in_marketing_written", "2026-04-20T10:00:00Z")]),
    ).toBe("can_send_marketing");
  });

  it("returns can_send_informational_only on plain opt_in_informational", () => {
    expect(
      computeConsentState([ev("opt_in_informational", "2026-04-20T10:00:00Z")]),
    ).toBe("can_send_informational_only");
  });

  it("picks the most recent event when multiple states exist", () => {
    const events = [
      ev("opt_in_marketing_written", "2026-04-20T10:00:00Z"),
      ev("opt_out", "2026-04-21T10:00:00Z"),
    ];
    expect(computeConsentState(events)).toBe("opted_out");
  });

  it("opt-in after opt-out restores sending", () => {
    const events = [
      ev("opt_out", "2026-04-20T10:00:00Z"),
      ev("opt_in_marketing_written", "2026-04-21T10:00:00Z"),
    ];
    expect(computeConsentState(events)).toBe("can_send_marketing");
  });

  it("help_request is ignored — doesn't mutate state", () => {
    const events = [
      ev("opt_in_marketing_written", "2026-04-20T10:00:00Z"),
      ev("help_request", "2026-04-21T10:00:00Z"),
    ];
    expect(computeConsentState(events)).toBe("can_send_marketing");
  });

  it("provider_auto_opt_out also counts as opted_out", () => {
    expect(
      computeConsentState([
        ev("opt_in_marketing_written", "2026-04-20T10:00:00Z"),
        ev("provider_auto_opt_out", "2026-04-22T10:00:00Z"),
      ]),
    ).toBe("opted_out");
  });

  it("opt_in_confirmed grants marketing send", () => {
    expect(
      computeConsentState([ev("opt_in_confirmed", "2026-04-20T10:00:00Z")]),
    ).toBe("can_send_marketing");
  });

  it("order-insensitive — unsorted input still yields the right state", () => {
    const events = [
      ev("opt_out", "2026-04-20T10:00:00Z"),
      ev("opt_in_marketing_written", "2026-04-21T10:00:00Z"),
      ev("help_request", "2026-04-22T10:00:00Z"),
    ];
    // Latest non-help event is opt_in_marketing_written.
    expect(computeConsentState(events)).toBe("can_send_marketing");
  });
});

describe("recordConsentEvent", () => {
  it("does not treat a reused external id from a different source as a duplicate", async () => {
    const filters: Array<[string, unknown]> = [];
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe("consent_events");
        return {
          select: vi.fn(() => ({
            eq: (column: string, value: unknown) => {
              filters.push([column, value]);
              return {
                eq: (column2: string, value2: unknown) => {
                  filters.push([column2, value2]);
                  return {
                    eq: (column3: string, value3: unknown) => {
                      filters.push([column3, value3]);
                      return {
                        eq: (column4: string, value4: unknown) => {
                          filters.push([column4, value4]);
                          return {
                            contains: (_column5: string, value5: unknown) => {
                              filters.push(["source_detail", value5]);
                              return {
                                limit: vi.fn().mockResolvedValue({
                                  data: [],
                                  error: null,
                                }),
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          })),
          insert,
        };
      }),
    };

    await expect(
      recordConsentEvent(supabase as never, {
        contactId: "contact-1",
        channel: "sms",
        eventType: "opt_out",
        source: "sendillo_inbound_webhook",
        sourceDetail: { externalId: "shared-id" },
        idempotencyKey: "shared-id",
      }),
    ).resolves.toBeUndefined();

    expect(filters).toContainEqual(["source", "sendillo_inbound_webhook"]);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
