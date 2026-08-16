import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import {
  resolveSkipTraceEligibility,
  skipTraceAudienceDescription,
  skipTraceAudienceTitle,
} from "./eligibility";

const supabase = createTestClient();

async function defaultOrgId(): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("name", "BMH Group")
    .single();
  if (error || !data) throw error ?? new Error("default org missing");
  return data.id;
}

describe("resolveSkipTraceEligibility (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("preserves split-job and prior gate context in audience copy", () => {
    expect(
      skipTraceAudienceTitle(
        "Skip trace 500 properties (part 1/3) (2 need CASS verification skipped)",
        499,
        1,
      ),
    ).toBe(
      "Skip trace 499 properties (part 1/3) (2 need CASS verification skipped) · 1 excluded before provider submission",
    );
    expect(
      skipTraceAudienceDescription(
        "Awaiting admin approval (requested by va@example.com)",
        499,
        1,
      ),
    ).toBe(
      "Awaiting admin approval (requested by va@example.com) Provider audience: 499 eligible; 1 excluded before provider submission.",
    );
  });

  it("scopes durable phone suppression by organization and SMS channel", async () => {
    const orgA = await defaultOrgId();
    const { data: orgBRow, error: orgBError } = await supabase
      .from("organizations")
      .insert({ name: `Skip Trace Tenant B ${crypto.randomUUID()}` })
      .select("id")
      .single();
    if (orgBError || !orgBRow) {
      throw orgBError ?? new Error("second org insert failed");
    }

    const sharedPhone = "+18165550144";
    const orgAPhone = "+18165550143";
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .insert([
        {
          org_id: orgA,
          first_name: "Tenant A",
          last_name: "Owner",
          phone_1: "(816) 555-0143",
          phone_1_type: "mobile",
        },
        {
          org_id: orgBRow.id,
          first_name: "Tenant B",
          last_name: "Owner",
          phone_1: sharedPhone,
          phone_1_type: "mobile",
        },
      ])
      .select("id, org_id");
    if (contactsError || !contacts) {
      throw contactsError ?? new Error("contacts insert failed");
    }

    const contactA = contacts.find((row) => row.org_id === orgA)!;
    const contactB = contacts.find((row) => row.org_id === orgBRow.id)!;
    const { data: properties, error: propertiesError } = await supabase
      .from("properties")
      .insert([
        {
          org_id: orgA,
          address: "1 Tenant A Ln",
          state: "MO",
          status: "prospect",
          cass_status: "verified",
          homeowner_contact_id: contactA.id,
        },
        {
          org_id: orgBRow.id,
          address: "1 Tenant B Ln",
          state: "MO",
          status: "prospect",
          cass_status: "verified",
          homeowner_contact_id: contactB.id,
        },
      ])
      .select("id, org_id");
    if (propertiesError || !properties) {
      throw propertiesError ?? new Error("properties insert failed");
    }

    const { error: suppressionError } = await supabase
      .from("sms_phone_suppressions")
      .insert([
        {
          org_id: orgA,
          channel: "sms",
          phone_e164: orgAPhone,
          source: "inbound_stop",
        },
        {
          org_id: orgA,
          channel: "sms",
          phone_e164: sharedPhone,
          source: "inbound_stop",
        },
      ]);
    if (suppressionError) throw suppressionError;

    const propertyA = properties.find((row) => row.org_id === orgA)!;
    const propertyB = properties.find((row) => row.org_id === orgBRow.id)!;
    const resultA = await resolveSkipTraceEligibility(supabase, {
      orgId: orgA,
      propertyIds: [propertyA.id],
    });
    const resultB = await resolveSkipTraceEligibility(supabase, {
      orgId: orgBRow.id,
      propertyIds: [propertyB.id],
    });

    expect(resultA.eligibleIds).toEqual([]);
    expect(resultA.exclusions).toEqual([
      { propertyId: propertyA.id, reason: "dnc" },
    ]);
    expect(resultB.eligibleIds).toEqual([propertyB.id]);
    expect(resultB.exclusions).toEqual([]);

    await supabase.from("organizations").delete().eq("id", orgBRow.id);
  });

  it("excludes current terminal disposition and skip-trace kill-switch states", async () => {
    const organizationId = await defaultOrgId();
    const { data: properties, error } = await supabase
      .from("properties")
      .insert([
        {
          org_id: organizationId,
          address: "10 Terminal Disposition Ln",
          state: "MO",
          status: "prospect",
          cass_status: "verified",
          outreach_dispo: "bad_number",
          skip_trace_disabled: false,
        },
        {
          org_id: organizationId,
          address: "11 Kill Switch Ln",
          state: "MO",
          status: "prospect",
          cass_status: "verified",
          skip_trace_disabled: true,
        },
      ])
      .select("id, outreach_dispo, skip_trace_disabled");
    if (error || !properties) throw error ?? new Error("properties missing");

    const result = await resolveSkipTraceEligibility(supabase, {
      orgId: organizationId,
      propertyIds: properties.map((property) => property.id),
    });

    expect(result.eligibleIds).toEqual([]);
    expect(result.exclusions).toEqual(
      expect.arrayContaining([
        {
          propertyId: properties.find(
            (property) => property.outreach_dispo === "bad_number",
          )!.id,
          reason: "dnc",
        },
        {
          propertyId: properties.find(
            (property) => property.skip_trace_disabled,
          )!.id,
          reason: "skip_trace_disabled",
        },
      ]),
    );
  });
});
