import { describe, expect, it, vi } from "vitest";

import { resolveProspectEligibility } from "./eligibility";

function builder(data: unknown) {
  const result = Promise.resolve({ data, error: null });
  const query = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    is: vi.fn(),
    then: result.then.bind(result),
  };
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

describe("Prospects server-owned eligibility", () => {
  it("excludes only the permanent property lock and keeps channel restrictions eligible", async () => {
    const properties = [
      { id: "contact-dnc", status: "prospect", is_dnc_locked: true, skip_trace_disabled: false },
      { id: "disposition-dnc", status: "interested", is_dnc_locked: true, skip_trace_disabled: false },
      { id: "sms-opted-out", status: "prospect", is_dnc_locked: false, skip_trace_disabled: false },
      { id: "wrong-number", status: "prospect", is_dnc_locked: false, skip_trace_disabled: false },
      { id: "bad-number", status: "prospect", is_dnc_locked: false, skip_trace_disabled: false },
      { id: "eligible", status: "prospect", is_dnc_locked: false, skip_trace_disabled: false },
    ];
    const supabase = { from: vi.fn(() => builder(properties)) };

    const result = await resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      properties.map((row) => row.id),
      "selection",
    );

    expect(result.eligibleIds).toEqual([
      "sms-opted-out",
      "wrong-number",
      "bad-number",
      "eligible",
    ]);
    expect(result.dncLockedCount).toBe(2);
    expect(result.exclusions).toEqual([
      { propertyId: "contact-dnc", reason: "dnc" },
      { propertyId: "disposition-dnc", reason: "dnc" },
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("applies skip_trace_disabled only to skip-trace purpose", async () => {
    const properties = [{
      id: "kill-switch",
      status: "prospect",
      is_dnc_locked: false,
      skip_trace_disabled: true,
    }];
    const supabase = { from: vi.fn(() => builder(properties)) };

    await expect(resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["kill-switch"],
      "dialer",
    )).resolves.toMatchObject({ eligibleIds: ["kill-switch"] });
    await expect(resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["kill-switch"],
      "skip_trace",
    )).resolves.toMatchObject({
      eligibleIds: [],
      skipTraceDisabledCount: 1,
    });
  });

  it("does not require prospect status when an advanced property is locked", async () => {
    const properties = [{
      id: "advanced-locked",
      status: "under_contract",
      is_dnc_locked: true,
      skip_trace_disabled: false,
    }];
    const supabase = { from: vi.fn(() => builder(properties)) };

    const result = await resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["advanced-locked"],
      "selection",
    );

    expect(result.eligibleIds).toEqual([]);
    expect(result.exclusions).toEqual([
      { propertyId: "advanced-locked", reason: "dnc" },
    ]);
  });
});
