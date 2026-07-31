import { describe, expect, it } from "vitest";

import {
  computeContactWarningRules,
  mappedSections,
  summarize,
  validateRow,
  type Mapping,
  type RowData,
} from "./validate";

const PROPERTY_MAPPING: Mapping = {
  address: "Address",
  city: "City",
  state: "State",
  zip: "Zip",
};

const FULL_MAPPING: Mapping = {
  ...PROPERTY_MAPPING,
  homeowner_first_name: "Owner First Name",
  homeowner_last_name: "Owner Last Name",
  homeowner_phone_1: "Phone",
  homeowner_email: "Email",
  agent_first_name: "Agent First Name",
  agent_phone: "Agent Phone",
};

describe("validateRow", () => {
  it("marks a fully-valid row as ok", () => {
    const row: RowData = {
      Address: "123 Main St",
      City: "Kansas City",
      State: "MO",
      Zip: "64108",
    };
    const result = validateRow(row, PROPERTY_MAPPING, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.normalized.address).toBe("123 Main St");
    expect(result.normalized.state).toBe("MO");
    expect(result.normalized.zip).toBe("64108");
  });

  it("fails when address is missing", () => {
    const row: RowData = {
      Address: "",
      City: "Kansas City",
      State: "MO",
    };
    const result = validateRow(row, PROPERTY_MAPPING, 0);
    expect(result.ok).toBe(false);
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("required");
  });

  it("fails when state is missing", () => {
    const row: RowData = {
      Address: "123 Main St",
      State: "",
    };
    const result = validateRow(row, PROPERTY_MAPPING, 0);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.fieldId === "state")).toBe(true);
  });

  it("surfaces specific error rules for bad phone values", () => {
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      Phone: "not-a-phone",
    };
    const result = validateRow(row, FULL_MAPPING, 0);
    const phoneError = result.errors.find(
      (e) => e.fieldId === "homeowner_phone_1",
    );
    expect(phoneError).toBeDefined();
    expect(phoneError?.rule).toBe("invalid_phone");
    expect(phoneError?.value).toBe("not-a-phone");
  });

  it("normalizes vendor phone line-type labels before enum validation", () => {
    const mapping: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_phone_1: "Phone 1",
      homeowner_phone_1_type: "Phone 1 Type",
      homeowner_phone_2: "Phone 2",
      homeowner_phone_2_type: "Phone 2 Type",
      agent_phone: "Agent Phone",
      agent_phone_type: "Agent Phone Type",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      "Phone 1": "8165551111",
      "Phone 1 Type": "Wireless",
      "Phone 2": "8165552222",
      "Phone 2 Type": "Land Line",
      "Agent Phone": "8165553333",
      "Agent Phone Type": "Cell",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.normalized.homeowner_phone_1_type).toBe("mobile");
    expect(result.normalized.homeowner_phone_2_type).toBe("landline");
    expect(result.normalized.agent_phone_type).toBe("mobile");
  });

  it("still rejects unrecognized phone line-type labels", () => {
    const mapping: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_phone_1: "Phone",
      homeowner_phone_1_type: "Phone Type",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      Phone: "8165551111",
      "Phone Type": "Satellite",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(false);
    const lineTypeError = result.errors.find(
      (e) => e.fieldId === "homeowner_phone_1_type",
    );
    expect(lineTypeError?.rule).toBe("invalid_enum");
    expect(lineTypeError?.value).toBe("Satellite");
  });

  it("decodes a DealMachine DO NOT CALL line-type into the Do Not Contact flag", () => {
    // DealMachine writes "DO NOT CALL" into the phone's line-type column.
    // The row must stay valid (not fail on invalid_enum), the number must
    // drop (type normalizes to 'unknown' → ingest hard rule), and the
    // protective contact-level flag must be raised.
    const mapping: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_phone_1: "Phone",
      homeowner_phone_1_type: "Phone Type",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      Phone: "8165551111",
      "Phone Type": "DO NOT CALL",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.normalized.homeowner_phone_1_type).toBe("unknown");
    expect(result.normalized.homeowner_do_not_contact).toBe(true);
  });

  it("does not raise Do Not Contact for a DNC marker with no phone in the slot", () => {
    const mapping: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_phone_1: "Phone",
      homeowner_phone_1_type: "Phone Type",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      Phone: "",
      "Phone Type": "DO NOT CALL",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.normalized.homeowner_do_not_contact).not.toBe(true);
  });

  it("lets a per-phone DNC marker override an explicit Do Not Contact = false", () => {
    // Protective one-way OR: if any number says DO NOT CALL, the contact
    // is suppressed even when a row-level column claims otherwise.
    const mapping: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_phone_1: "Phone 1",
      homeowner_phone_1_type: "Phone 1 Type",
      homeowner_phone_2: "Phone 2",
      homeowner_phone_2_type: "Phone 2 Type",
      homeowner_do_not_contact: "DNC",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      "Phone 1": "8165551111",
      "Phone 1 Type": "Mobile",
      "Phone 2": "8165552222",
      "Phone 2 Type": "DO NOT CALL",
      DNC: "false",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.normalized.homeowner_phone_1_type).toBe("mobile");
    expect(result.normalized.homeowner_do_not_contact).toBe(true);
  });

  it("treats a completely blank row as empty (no errors, not ok)", () => {
    const row: RowData = { Address: "", City: "", State: "", Zip: "" };
    const result = validateRow(row, PROPERTY_MAPPING, 0);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(Object.keys(result.normalized)).toHaveLength(0);
  });

  it("blocks when mapping is missing the required section columns", () => {
    const emptyMapping: Mapping = {};
    const row: RowData = { Address: "123 Main St" };
    const result = validateRow(row, emptyMapping, 0);
    expect(result.ok).toBe(false);
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("section_required");
  });

  it("derives address/city/state/zip from a mapped address_full column", () => {
    const mapping: Mapping = {
      address_full: "associated_property_address_full",
    };
    const row: RowData = {
      associated_property_address_full: "123 Main St, Kansas City, MO 64108",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.normalized.address).toBe("123 Main St");
    expect(result.normalized.city).toBe("Kansas City");
    expect(result.normalized.state).toBe("MO");
    expect(result.normalized.zip).toBe("64108");
  });

  it("prefers explicit mappings over parsed address_full components", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      address_full: "Combined",
    };
    const row: RowData = {
      Address: "999 Real St",
      State: "OH",
      Combined: "123 Main St, Kansas City, MO 64108",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.normalized.address).toBe("999 Real St");
    expect(result.normalized.state).toBe("OH");
    // city/zip weren't mapped directly, so they come from the parse
    expect(result.normalized.city).toBe("Kansas City");
    expect(result.normalized.zip).toBe("64108");
  });

  it("flags a row whose address_full has only city+state as no_street (DealMachine skip-trace miss)", () => {
    const mapping: Mapping = { address_full: "Combined" };
    const row: RowData = { Combined: "Weston, Mo 64098" };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(false);
    // Only one error — the specific classification — not duplicate required errors.
    const combinedErrors = result.errors.filter((e) =>
      e.rule.startsWith("address_full_"),
    );
    expect(combinedErrors).toHaveLength(1);
    expect(combinedErrors[0].rule).toBe("address_full_no_street");
  });

  it("classifies an empty address_full row as address_full_empty", () => {
    const mapping: Mapping = { address_full: "Combined" };
    const row: RowData = { Combined: "", SomeOtherField: "not blank" };
    const result = validateRow(row, mapping, 0);
    const rule = result.errors.find((e) => e.rule.startsWith("address_full_"))?.rule;
    expect(rule).toBe("address_full_empty");
  });

  it("validates a reshaped D4D row (address_full + per-field city/state/zip)", () => {
    // After running scripts/reshape-d4d-csv.ts, the combined column is
    // comma-delimited and the per-field columns survive untouched. The
    // mapping below is what autodetectMapping produces for D4D headers.
    const mapping: Mapping = {
      address_full: "PROP: Address Full",
      city: "PROP: City",
      state: "PROP: State",
      zip: "PROP: Zip",
    };
    const row: RowData = {
      "PROP: Address Full": "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222",
      "PROP: City": "ANGELS CAMP",
      "PROP: State": "CA",
      "PROP: Zip": "95222",
    };
    const result = validateRow(row, mapping, 0);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.normalized.address).toBe("807 TRIPLE LODE DR");
    // Per-field values win over parsed values for city/state/zip.
    expect(result.normalized.city).toBe("ANGELS CAMP");
    expect(result.normalized.state).toBe("CA");
    expect(result.normalized.zip).toBe("95222");
  });

  it("rejects an entity contact without entity_name", () => {
    const mappingWithEntity: Mapping = {
      ...PROPERTY_MAPPING,
      homeowner_contact_type: "Owner Type",
      homeowner_entity_name: "Entity Name",
    };
    const row: RowData = {
      Address: "123 Main St",
      State: "MO",
      "Owner Type": "entity",
      "Entity Name": "",
    };
    const result = validateRow(row, mappingWithEntity, 0);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.rule === "entity_requires_name"),
    ).toBe(true);
  });
});

describe("summarize", () => {
  it("counts valid, invalid, and empty rows", () => {
    const rows = [
      validateRow(
        { Address: "1 A St", State: "MO" },
        PROPERTY_MAPPING,
        0,
      ),
      validateRow(
        { Address: "", State: "MO" },
        PROPERTY_MAPPING,
        1,
      ),
      validateRow(
        { Address: "", City: "", State: "", Zip: "" },
        PROPERTY_MAPPING,
        2,
      ),
      validateRow(
        { Address: "2 B St", State: "OH" },
        PROPERTY_MAPPING,
        3,
      ),
    ];
    const summary = summarize(rows);
    expect(summary.totalRows).toBe(4);
    expect(summary.validRows).toBe(2);
    expect(summary.invalidRows).toBe(1);
    expect(summary.emptyRows).toBe(1);
  });

  it("groups error counts by rule", () => {
    const rows = [
      validateRow({ Address: "", State: "MO" }, PROPERTY_MAPPING, 0),
      validateRow({ Address: "", State: "MO" }, PROPERTY_MAPPING, 1),
    ];
    const summary = summarize(rows);
    expect(summary.errorsByRule.required).toBe(2);
  });
});

describe("computeContactWarningRules", () => {
  it("returns no_contact when nothing usable is present", () => {
    expect(computeContactWarningRules({})).toContain("no_contact");
  });

  it("returns no_phone when owner info exists but no phone", () => {
    const rules = computeContactWarningRules({
      homeowner_first_name: "Alex",
      homeowner_email: "a@b.com",
    });
    expect(rules).toContain("no_phone");
    expect(rules).not.toContain("no_contact");
  });

  it("returns no_mailing_address independently of contact coverage", () => {
    const rules = computeContactWarningRules({
      homeowner_phone_1: "+18165551234",
    });
    expect(rules).toContain("no_mailing_address");
    expect(rules).not.toContain("no_phone");
    expect(rules).not.toContain("no_contact");
  });

  it("returns an empty array when everything is filled in", () => {
    expect(
      computeContactWarningRules({
        homeowner_first_name: "Alex",
        homeowner_phone_1: "+18165551234",
        homeowner_email: "a@b.com",
        homeowner_mailing_address: "1 Main St",
      }),
    ).toEqual([]);
  });
});

describe("mappedSections", () => {
  it("detects property section when any property field is mapped", () => {
    expect(mappedSections({ address: "Address" }).property).toBe(true);
    expect(mappedSections({}).property).toBe(false);
  });

  it("detects homeowner section from homeowner_* keys", () => {
    expect(
      mappedSections({ homeowner_first_name: "First Name" }).homeowner,
    ).toBe(true);
    expect(mappedSections({ address: "Address" }).homeowner).toBe(false);
  });

  it("detects agent section from agent_* keys", () => {
    expect(mappedSections({ agent_phone: "Agent Phone" }).agent).toBe(true);
    expect(mappedSections({ address: "Address" }).agent).toBe(false);
  });
});
