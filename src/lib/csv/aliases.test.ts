import { describe, expect, it } from "vitest";

import {
  autodetectField,
  autodetectMapping,
  normalizeHeader,
} from "./aliases";

describe("normalizeHeader", () => {
  it("lowercases and trims", () => {
    expect(normalizeHeader("  ADDRESS  ")).toBe("address");
  });

  it("collapses underscores/hyphens/dots to single spaces", () => {
    expect(normalizeHeader("Street_Address")).toBe("street address");
    expect(normalizeHeader("STREET-ADDRESS")).toBe("street address");
    expect(normalizeHeader("street.address")).toBe("street address");
    expect(normalizeHeader("street___address")).toBe("street address");
  });

  it("strips surrounding single and double quotes", () => {
    expect(normalizeHeader('"Address"')).toBe("address");
    expect(normalizeHeader("'Address'")).toBe("address");
  });

  it("collapses repeated whitespace", () => {
    expect(normalizeHeader("street     address")).toBe("street address");
  });
});

describe("autodetectField", () => {
  it("maps common property headers", () => {
    expect(autodetectField("Address")).toBe("address");
    expect(autodetectField("street_address")).toBe("address");
    expect(autodetectField("City")).toBe("city");
    expect(autodetectField("State")).toBe("state");
    expect(autodetectField("Zip")).toBe("zip");
    expect(autodetectField("Postal Code")).toBe("zip");
    expect(autodetectField("County")).toBe("county_name");
    expect(autodetectField("APN")).toBe("apn");
    expect(autodetectField("Parcel ID")).toBe("apn");
    expect(autodetectField("Zillow ID")).toBe("zpid");
    expect(autodetectField("MLS #")).toBe("mls_number");
  });

  it("maps homeowner-specific headers", () => {
    expect(autodetectField("Owner First Name")).toBe("homeowner_first_name");
    expect(autodetectField("Owner Last Name")).toBe("homeowner_last_name");
    expect(autodetectField("Owner Email")).toBe("homeowner_email");
    expect(autodetectField("Phone")).toBe("homeowner_phone_1");
    expect(autodetectField("Phone 2")).toBe("homeowner_phone_2");
    expect(autodetectField("Mailing Address")).toBe("homeowner_mailing_address");
    expect(autodetectField("DNC")).toBe("homeowner_do_not_contact");
  });

  it("maps agent-specific headers", () => {
    expect(autodetectField("Agent First Name")).toBe("agent_first_name");
    expect(autodetectField("Agent Phone")).toBe("agent_phone");
    expect(autodetectField("Brokerage")).toBe("agent_brokerage");
    expect(autodetectField("License Number")).toBe("agent_license_number");
  });

  it("returns null for unknown headers", () => {
    expect(autodetectField("UnrelatedColumn")).toBeNull();
    expect(autodetectField("some_custom_field")).toBeNull();
  });
});

describe("autodetectMapping", () => {
  it("maps every known header in a typical DealMachine row", () => {
    const headers = [
      "Address",
      "City",
      "State",
      "Zip",
      "County",
      "APN",
      "Beds",
      "Baths",
      "SqFt",
      "Year Built",
      "Listing Price",
      "ARV",
      "Owner First Name",
      "Owner Last Name",
      "Phone",
      "Email",
      "Mailing Address",
      "Mailing City",
      "Mailing State",
      "Mailing Zip",
    ];
    const mapping = autodetectMapping(headers);
    expect(mapping.address).toBe("Address");
    expect(mapping.city).toBe("City");
    expect(mapping.state).toBe("State");
    expect(mapping.zip).toBe("Zip");
    expect(mapping.county_name).toBe("County");
    expect(mapping.apn).toBe("APN");
    expect(mapping.beds).toBe("Beds");
    expect(mapping.baths).toBe("Baths");
    expect(mapping.homeowner_first_name).toBe("Owner First Name");
    expect(mapping.homeowner_last_name).toBe("Owner Last Name");
    expect(mapping.homeowner_phone_1).toBe("Phone");
    expect(mapping.homeowner_email).toBe("Email");
    expect(mapping.homeowner_mailing_address).toBe("Mailing Address");
  });

  it("ignores unknown headers", () => {
    const mapping = autodetectMapping([
      "Address",
      "FavoriteColor",
      "NotAField",
    ]);
    expect(mapping.address).toBe("Address");
    // Unknown headers are simply absent — not mapped to anything.
    expect(Object.values(mapping)).not.toContain("FavoriteColor");
    expect(Object.values(mapping)).not.toContain("NotAField");
  });

  it("resolves duplicate-target headers deterministically (first wins)", () => {
    // Both "Address" and "Property Address" alias to the `address` target.
    // The first occurrence should win, the second should be left unmapped.
    const mapping = autodetectMapping(["Address", "Property Address"]);
    expect(mapping.address).toBe("Address");
    // "Property Address" should not appear as a value anywhere.
    expect(Object.values(mapping)).not.toContain("Property Address");
  });

  it("returns an empty mapping when no headers match", () => {
    const mapping = autodetectMapping(["A", "B", "C"]);
    expect(Object.keys(mapping)).toHaveLength(0);
  });

  it("auto-maps the DealMachine Skipped (contact-centric) header set", () => {
    const headers = [
      "contact_id",
      "associated_property_address_full",
      "first_name",
      "last_name",
      "primary_mailing_address",
      "primary_mailing_city",
      "primary_mailing_state",
      "primary_mailing_zip",
      "email_address_1",
      "email_address_2",
      "phone_1",
      "phone_2",
      "phone_3",
    ];
    const mapping = autodetectMapping(headers);
    expect(mapping.address_full).toBe("associated_property_address_full");
    expect(mapping.homeowner_first_name).toBe("first_name");
    expect(mapping.homeowner_last_name).toBe("last_name");
    expect(mapping.homeowner_mailing_address).toBe("primary_mailing_address");
    expect(mapping.homeowner_mailing_city).toBe("primary_mailing_city");
    expect(mapping.homeowner_mailing_state).toBe("primary_mailing_state");
    expect(mapping.homeowner_mailing_zip).toBe("primary_mailing_zip");
    expect(mapping.homeowner_email).toBe("email_address_1");
    expect(mapping.homeowner_phone_1).toBe("phone_1");
    expect(mapping.homeowner_phone_2).toBe("phone_2");
    expect(mapping.homeowner_phone_3).toBe("phone_3");
    // email_address_2 and contact_id are deliberately unmapped.
    expect(Object.values(mapping)).not.toContain("email_address_2");
    expect(Object.values(mapping)).not.toContain("contact_id");
  });
});
