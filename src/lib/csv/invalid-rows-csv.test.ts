import { describe, expect, it } from "vitest";

import { buildInvalidRowsCsv } from "./invalid-rows-csv";
import { summarize, validateRow, type Mapping, type RowData } from "./validate";

describe("buildInvalidRowsCsv", () => {
  it("emits a row per invalid record with the mapped columns + error", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_phone_1: "Phone",
    };
    const rows: RowData[] = [
      { Address: "1 Main St", State: "MO", Phone: "5551234567" }, // valid
      { Address: "", State: "MO", Phone: "5551234567" }, // missing address
      { Address: "2 Main St", State: "MO", Phone: "not-a-phone" }, // bad phone
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    const lines = csv.split("\n");

    // Header + 2 invalid rows
    expect(lines[0]).toBe("Row,Error,Error detail,Address,State,Phone");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Missing required field");
    expect(lines[2]).toContain("Invalid phone number");
  });

  it("includes only the mapped columns, not the entire raw row", () => {
    const mapping: Mapping = { address: "A", state: "B" };
    const rows: RowData[] = [
      // Many extra columns that should not appear in the output.
      {
        A: "",
        B: "MO",
        C: "junk",
        D: "more junk",
        E: "even more",
      },
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);

    expect(csv.split("\n")[0]).toBe("Row,Error,Error detail,A,B");
    expect(csv).not.toContain("junk");
  });

  it("excludes valid and empty rows", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: "1 Main St", State: "MO" }, // valid
      { Address: "", State: "" }, // empty
      { Address: "", State: "MO" }, // invalid
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    const dataLines = csv.split("\n").slice(1);
    expect(dataLines).toHaveLength(1);
  });

  it("emits a header-only CSV when nothing is invalid", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [{ Address: "1 Main St", State: "MO" }];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    expect(csv).toBe("Row,Error,Error detail,Address,State");
  });

  it("escapes quotes and commas in cell values", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: 'Some "quoted, weird" address', State: "" },
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    expect(csv).toContain('"Some ""quoted, weird"" address"');
  });

  it("uses 1-indexed row numbers that match the source CSV (header counts as row 1)", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: "1 Main", State: "MO" }, // row 2 in CSV
      { Address: "", State: "MO" }, // row 3 in CSV — invalid
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    const dataLine = csv.split("\n")[1];
    expect(dataLine.startsWith("3,")).toBe(true);
  });

  it("integrates with summarize() — invalidRows count matches output line count", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: "1 Main", State: "MO" },
      { Address: "", State: "MO" },
      { Address: "", State: "MO" },
      { Address: "", State: "MO" },
    ];
    const validated = rows.map((r, i) => validateRow(r, mapping, i));
    const summary = summarize(validated);

    const csv = buildInvalidRowsCsv(rows, mapping, validated);
    const dataLines = csv.split("\n").slice(1);

    expect(dataLines).toHaveLength(summary.invalidRows);
    expect(dataLines).toHaveLength(3);
  });
});
