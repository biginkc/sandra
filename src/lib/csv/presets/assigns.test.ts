import { describe, expect, it } from "vitest";

import { autodetectMapping } from "../aliases";
import { validateRow } from "../validate";
import { assignsPreset } from "./assigns";

const headers = [
  "PropertyAddress", "PropertyCity", "PropertyState", "PropertyPostalCode",
  "AddressHash", "Contact1Name", "Contact1Type", "Contact1Phone_1",
  "Contact1Phone_1_Type", "Contact1Phone_1_DNC", "Contact1Email_1",
  "Contact2Name", "Contact2Phone_1", "Contact2Phone_1_Type",
  "Contact2Phone_1_ActivityScore", "Contact2Phone_1_Litigator",
  "Contact8UsedAlternateSource",
];

const row = {
  PropertyAddress: "123 Main St",
  PropertyCity: "Kansas City",
  PropertyState: "MO",
  PropertyPostalCode: "64108",
  AddressHash: "address-hash",
  Contact1Name: "Jane Smith",
  Contact1Type: "Landlord",
  Contact1Phone_1: "8165551001",
  Contact1Phone_1_Type: "Mobile",
  Contact1Phone_1_DNC: "TRUE",
  Contact1Email_1: "jane@example.com",
  Contact2Name: "John Smith",
  Contact2Phone_1: "8165551002",
  Contact2Phone_1_Type: "Residential",
  Contact2Phone_1_ActivityScore: "87",
  Contact2Phone_1_Litigator: "FALSE",
  Contact8UsedAlternateSource: "TRUE",
};

describe("Assigns preset", () => {
  it("recognizes the exact wide export signature", () => {
    expect(assignsPreset.detect(headers, [row])?.confidence).toBe(1);
  });

  it("keeps every source column and every contact block in lossless envelopes", () => {
    const transformed = assignsPreset.transform([row], headers);
    const source = JSON.parse(transformed.rows[0]["Assigns Source Row"]);
    const contacts = JSON.parse(transformed.rows[0]["Assigns Contact Blocks"]);
    expect(source).toEqual(row);
    expect(contacts).toHaveLength(8);
    expect(contacts[1].phones[0]).toMatchObject({
      value: "8165551002",
      type: "landline",
      sourceType: "Residential",
      activityScore: "87",
      litigator: "FALSE",
    });
    expect(transformed.stats.notes).toContain(
      "No DNC filtering or DNC-to-suppression conversion was applied.",
    );
  });

  it("autodetects a valid fully mapped import row", () => {
    const transformed = assignsPreset.transform([row], headers);
    const mapping = autodetectMapping(transformed.headers);
    expect(Object.values(mapping).filter(Boolean)).toHaveLength(transformed.headers.length);
    expect(validateRow(transformed.rows[0], mapping, 0).errors).toEqual([]);
  });
});
