import { describe, expect, it, vi } from "vitest";

import { resolveProspectEligibility } from "./eligibility";

function builder(data: unknown) {
  const result = Promise.resolve({ data, error: null });
  const query = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    then: result.then.bind(result),
  };
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

const homeowner = (overrides: Record<string, unknown> = {}) => [{
  phone_1: null,
  phone_2: null,
  phone_3: null,
  do_not_contact: false,
  sms_opted_out: false,
  ...overrides,
}];

describe("Prospects server-owned eligibility", () => {
  it("excludes every suppression source and keeps an ordinary prospect", async () => {
    const properties = [
      { id: "contact-dnc", org_id: "org-a", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner({ do_not_contact: true }) },
      { id: "opted-out", org_id: "org-a", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner({ sms_opted_out: true }) },
      { id: "disposition", org_id: "org-a", outreach_dispo: "wrong_number", skip_trace_disabled: false, homeowner: homeowner() },
      { id: "durable", org_id: "org-a", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner({ phone_1: "+18165550100" }) },
      { id: "eligible", org_id: "org-a", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner() },
    ];
    const supabase = {
      from: vi.fn((table: string) =>
        table === "properties"
          ? builder(properties)
          : builder([{ org_id: "org-a", phone_e164: "+18165550100" }]),
      ),
    };

    const result = await resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      properties.map((row) => row.id),
      "selection",
    );

    expect(result.eligibleIds).toEqual(["eligible"]);
    expect(result.dncLockedCount).toBe(4);
  });

  it("applies skip_trace_disabled only to skip-trace purpose", async () => {
    const properties = [{
      id: "kill-switch",
      org_id: "org-a",
      outreach_dispo: null,
      skip_trace_disabled: true,
      homeowner: homeowner(),
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

  it("does not leak a durable phone suppression across organizations", async () => {
    const properties = [
      { id: "org-a-row", org_id: "org-a", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner({ phone_1: "+18165550101" }) },
      { id: "org-b-row", org_id: "org-b", outreach_dispo: null, skip_trace_disabled: false, homeowner: homeowner({ phone_1: "+18165550101" }) },
    ];
    const supabase = {
      from: vi.fn((table: string) =>
        table === "properties"
          ? builder(properties)
          : builder([{ org_id: "org-a", phone_e164: "+18165550101" }]),
      ),
    };

    const result = await resolveProspectEligibility(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["org-a-row", "org-b-row"],
      "selection",
    );

    expect(result.eligibleIds).toEqual(["org-b-row"]);
    expect(result.exclusions).toContainEqual({ propertyId: "org-a-row", reason: "dnc" });
  });
});
