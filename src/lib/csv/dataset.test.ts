import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { autodetectMapping } from "./aliases";
import {
  buildReviewedDatasetFile,
  buildReviewContractSha256,
  serializeReviewedDataset,
  withGeneratedDncLocks,
} from "./dataset";
import { buildLocalPreflight, mergeServerPreflight } from "./preflight";
import { propstreamPreset } from "./presets/propstream";
import { validateRow } from "./validate";

describe("reviewed import dataset identity", () => {
  it("uploads the transformed rows the operator reviewed, including DNC, instead of the original vendor bytes", async () => {
    const original = [{
      Address: "123 Main St",
      State: "MO",
      "Phone 1": "8165551001",
      "Phone 1 Type": "Mobile",
      "Phone 1 DNC": "Yes",
      "Owner 1 First Name": "Jane",
      "Owner 1 Last Name": "Smith",
    }];
    const originalHeaders = Object.keys(original[0]);
    const transformed = propstreamPreset.transform(original, originalHeaders);
    const mapping = autodetectMapping(transformed.headers);
    const local = buildLocalPreflight(transformed.rows, mapping);
    const locked = withGeneratedDncLocks({
      rows: transformed.rows,
      headers: transformed.headers,
      mapping,
      dncRowIndexes: local.preflight.groups.dnc,
    });

    const reviewed = await buildReviewedDatasetFile({
      rows: locked.rows,
      headers: locked.headers,
      filename: "propstream.csv",
    });
    const uploadedBytes = await reviewed.file.text();
    expect(uploadedBytes).toBe(serializeReviewedDataset(locked.rows, locked.headers));
    expect(uploadedBytes).not.toBe(serializeReviewedDataset(original, originalHeaders));

    const parsed = Papa.parse<Record<string, string>>(uploadedBytes, { header: true });
    const ingested = validateRow(parsed.data[0], locked.mapping, 0);
    expect(ingested.normalized.homeowner_do_not_contact).toBe(true);
    expect(ingested.normalized.homeowner_first_name).toBe("Jane");
    expect(reviewed.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("conserves file and server DNC rows through the generated lock column", () => {
    const rows = [
      { Address: "1 Main St", State: "MO", DNC: "true" },
      { Address: "2 Main St", State: "MO", DNC: "" },
    ];
    const mapping = { address: "Address", state: "State", homeowner_do_not_contact: "DNC" };
    const local = buildLocalPreflight(rows, mapping);
    const merged = mergeServerPreflight(local.preflight, {
      existingRowIndexes: [],
      dncRows: [{ rowIndex: 1, reasons: ["Existing contact opted out of SMS"] }],
    });
    const locked = withGeneratedDncLocks({
      rows,
      headers: ["Address", "State", "DNC"],
      mapping,
      dncRowIndexes: merged.groups.dnc,
    });

    expect(local.preflight.dnc).toBe(1);
    expect(merged.dnc).toBe(2);
    expect(locked.rows.map((row) => row.__sandra_dnc_locked)).toEqual(["true", "true"]);
    expect(locked.rows.filter((row, index) =>
      validateRow(row, locked.mapping, index).normalized.homeowner_do_not_contact === true,
    )).toHaveLength(2);
  });

  it("changes the review contract when the same CSV is mapped differently", async () => {
    const common = {
      datasetSha256: "a".repeat(64),
      source: "dealmachine",
      countyId: "county-1",
      totalRows: 1,
      dncRows: 0,
      smsConsent: false,
      sequenceId: null,
      classifyLineTypes: false,
      requestCass: false,
      requestSkipTrace: false,
    };
    const reviewed = await buildReviewContractSha256({
      ...common,
      mapping: { address: "Address", state: "State" },
    });
    const changed = await buildReviewContractSha256({
      ...common,
      mapping: { address: "Property Address", state: "State" },
    });

    expect(reviewed).toMatch(/^[a-f0-9]{64}$/);
    expect(changed).not.toBe(reviewed);
  });
});
