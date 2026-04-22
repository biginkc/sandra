import { describe, expect, it } from "vitest";

import { computeConsentState } from "./consent";

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
