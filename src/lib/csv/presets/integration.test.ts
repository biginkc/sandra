/**
 * Validation-passthrough integration tests.
 *
 * For each importable preset: feed a transformed-then-autodetected
 * row through `validateRow` and assert the transform doesn't introduce
 * new validation errors. The promise of the format-helper is "your file
 * comes out cleaner, not more broken" — this test enforces that.
 */
import { describe, expect, it } from "vitest";

import { autodetectMapping } from "../aliases";
import { validateRow } from "../validate";

import { bmhAgentOutreachPreset } from "./bmh-agent-outreach";
import { propstreamPreset } from "./propstream";
import { reisiftPreset } from "./reisift";
import { titleproPreset } from "./titlepro";

describe("PropStream → validateRow passthrough", () => {
  it("a complete input row produces no validation errors after transform", () => {
    const headers = [
      "Address", "City", "State", "Zip",
      "Phone 1", "Phone 1 Type", "Phone 1 DNC",
      "Phone 2", "Phone 2 Type", "Phone 2 DNC",
      "Phone 3", "Phone 3 Type", "Phone 3 DNC",
      "Phone 4", "Phone 4 Type", "Phone 4 DNC",
      "Phone 5", "Phone 5 Type", "Phone 5 DNC",
      "Email 1",
      "Owner 1 First Name", "Owner 1 Last Name",
      "Method of Add",
    ];
    const row = {
      "Address": "123 Main St",
      "City": "Kansas City",
      "State": "MO",
      "Zip": "64108",
      "Phone 1": "8165551001", "Phone 1 Type": "Mobile", "Phone 1 DNC": "",
      "Phone 2": "", "Phone 2 Type": "", "Phone 2 DNC": "",
      "Phone 3": "", "Phone 3 Type": "", "Phone 3 DNC": "",
      "Phone 4": "", "Phone 4 Type": "", "Phone 4 DNC": "",
      "Phone 5": "", "Phone 5 Type": "", "Phone 5 DNC": "",
      "Email 1": "owner@example.com",
      "Owner 1 First Name": "Jane", "Owner 1 Last Name": "Smith",
      "Method of Add": "",
    };
    const out = propstreamPreset.transform([row], headers);
    const mapping = autodetectMapping(out.headers);
    const result = validateRow(out.rows[0], mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("BMH outreach → validateRow passthrough", () => {
  it("a parseable Property Address row passes validation", () => {
    const headers = [
      "Property Address", "First Name", "Last Name", "Phone", "Email",
      "Link", "Status", "Follow Up", "Lead Source", "Date Created", "County",
    ];
    const row = {
      "Property Address": "123 Main St, Kansas City, MO 64108",
      "First Name": "Jane", "Last Name": "Smith",
      "Phone": "816-555-1001", "Email": "jane@example.com",
      "Link": "https://realtor.com/123",
      "Status": "Offer Sent", "Follow Up": "Follow up Needed",
      "Lead Source": "realtor.com", "Date Created": "February 8, 2026",
      "County": "Clay County",
    };
    const out = bmhAgentOutreachPreset.transform([row], headers);
    const mapping = autodetectMapping(out.headers);
    const result = validateRow(out.rows[0], mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("an unparseable Property Address falls through to address_full", () => {
    const headers = [
      "Property Address", "First Name", "Last Name", "Phone", "Email",
      "Link", "Status", "Follow Up", "Lead Source", "Date Created", "County",
    ];
    const row = {
      "Property Address": "123 Main St Apt 4, Kansas City, MO 64108",
      "First Name": "", "Last Name": "",
      "Phone": "", "Email": "",
      "Link": "", "Status": "", "Follow Up": "",
      "Lead Source": "", "Date Created": "",
      "County": "Clay County",
    };
    const out = bmhAgentOutreachPreset.transform([row], headers);
    const mapping = autodetectMapping(out.headers);
    const result = validateRow(out.rows[0], mapping, 0);
    // Either ok directly (full split worked) or address_full path
    // produces a valid mapping. Both are acceptable here.
    expect(result.errors.filter((e) => e.fieldId === "address" || e.fieldId === "state"))
      .toEqual([]);
  });
});

describe("REISift → validateRow passthrough", () => {
  it("a row with DNC sentinel still validates after decode", () => {
    const headers = [
      "contact_id", "associated_property_id",
      "associated_property_address_full",
      "associated_property_address_line_1",
      "associated_property_address_city",
      "associated_property_address_state",
      "associated_property_address_zipcode",
      "first_name", "last_name",
      "phone_1", "phone_2", "phone_3",
    ];
    const row = {
      contact_id: "c1", associated_property_id: "p1",
      associated_property_address_full: "123 Main St, Kansas City, MO 64108",
      associated_property_address_line_1: "123 Main St",
      associated_property_address_city: "Kansas City",
      associated_property_address_state: "MO",
      associated_property_address_zipcode: "64108",
      first_name: "JANE", last_name: "SMITH",
      phone_1: "DNC Excluded",
      phone_2: "8165551002",
      phone_3: "",
    };
    const out = reisiftPreset.transform([row], headers);
    const mapping = autodetectMapping(out.headers);
    const result = validateRow(out.rows[0], mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("TitlePro → validateRow passthrough", () => {
  it("a death-event row with full address validates after dedup", () => {
    const headers = [
      "Site Address", "Site City", "Site State", "Site Zip",
      "APN", "APN (text)",
      "1st Owner's First Name", "1st Owner's Last Name",
      "AD.type", "AD.file_date", "AD.insert_date",
    ];
    const row = {
      "Site Address": "123 Main St",
      "Site City": "Kansas City",
      "Site State": "MO",
      "Site Zip": "64108",
      "APN": "12345",
      "APN (text)": '="12345"',
      "1st Owner's First Name": "Jane",
      "1st Owner's Last Name": "Smith",
      "AD.type": "Death",
      "AD.file_date": "2026-01-15",
      "AD.insert_date": "2026-01-16",
    };
    const out = titleproPreset.transform([row], headers);
    const mapping = autodetectMapping(out.headers);
    const result = validateRow(out.rows[0], mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("transforms never make valid rows invalid", () => {
  it("PropStream — a passing row stays passing", () => {
    const headers = ["Address", "State", "Phone 1", "Phone 1 Type", "Phone 1 DNC", "Method of Add"];
    const row = {
      Address: "123 Main St", State: "MO",
      "Phone 1": "8165551001", "Phone 1 Type": "Mobile", "Phone 1 DNC": "",
      "Method of Add": "",
    };
    const baseMapping = autodetectMapping(headers);
    const baseResult = validateRow(row, baseMapping, 0);

    const out = propstreamPreset.transform([row], headers);
    const newMapping = autodetectMapping(out.headers);
    const newResult = validateRow(out.rows[0], newMapping, 0);

    if (baseResult.ok) expect(newResult.ok).toBe(true);
  });
});
