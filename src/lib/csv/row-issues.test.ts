import { describe, expect, it } from "vitest";

import { groupRowIssues, rowIdentifier } from "./row-issues";
import { validateRow, type Mapping, type RowData } from "./validate";

describe("rowIdentifier", () => {
  it("prefers normalized address when present", () => {
    expect(
      rowIdentifier({
        address: "123 Main St",
        homeowner_first_name: "Alice",
      }),
    ).toBe("123 Main St");
  });

  it("falls back to homeowner first + last name", () => {
    expect(
      rowIdentifier({
        homeowner_first_name: "Alice",
        homeowner_last_name: "Johnson",
      }),
    ).toBe("Alice Johnson");
  });

  it("uses just first name when last name missing", () => {
    expect(
      rowIdentifier({
        homeowner_first_name: "Alice",
      }),
    ).toBe("Alice");
  });

  it("uses entity name when no individual name", () => {
    expect(
      rowIdentifier({
        homeowner_entity_name: "Acme Holdings LLC",
      }),
    ).toBe("Acme Holdings LLC");
  });

  it("returns null when nothing identifying is present", () => {
    expect(rowIdentifier({})).toBeNull();
    expect(rowIdentifier({ state: "MO" })).toBeNull();
  });
});

describe("groupRowIssues", () => {
  it("returns empty groups for an empty input", () => {
    const result = groupRowIssues([]);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns empty blockers for all-valid rows", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const validated = [
      { Address: "1 Main St", State: "MO" },
      { Address: "2 Oak Rd", State: "MO" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toEqual([]);
  });

  it("groups a single missing-Address blocker as 1 row", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const validated = [
      { Address: "", State: "MO" }, // missing address
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].ruleLabel).toBe("Address missing");
    expect(result.blockers[0].totalCount).toBe(1);
    expect(result.blockers[0].rows).toHaveLength(1);
    expect(result.blockers[0].rows[0].rowIndex).toBe(0);
  });

  it("splits one row's two missing fields into separate blocker entries", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_first_name: "First",
    };
    // Row has SOMETHING (a name) so the validator doesn't treat it as a
    // blank row, but Address + State (the two required fields) are empty.
    const validated = [
      { Address: "", State: "", First: "Alice" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toHaveLength(2);
    const labels = result.blockers.map((b) => b.ruleLabel).sort();
    expect(labels).toEqual(["Address missing", "State missing"]);
    expect(result.blockers[0].totalCount).toBe(1);
    expect(result.blockers[1].totalCount).toBe(1);
  });

  it("merges multiple rows with the same blocker into one group", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const validated = [
      { Address: "", State: "MO" },
      { Address: "", State: "MO" },
      { Address: "", State: "MO" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].ruleLabel).toBe("Address missing");
    expect(result.blockers[0].totalCount).toBe(3);
    expect(result.blockers[0].rows.map((r) => r.rowIndex).sort()).toEqual([
      0, 1, 2,
    ]);
  });

  it("sorts blockers by count descending", () => {
    const mapping: Mapping = { address: "Address", state: "State" };
    const validated = [
      { Address: "", State: "MO" }, // address only
      { Address: "1 Main", State: "" }, // state only
      { Address: "2 Oak", State: "" }, // state only
      { Address: "3 Pine", State: "" }, // state only
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0].ruleLabel).toBe("State missing");
    expect(result.blockers[0].totalCount).toBe(3);
    expect(result.blockers[1].ruleLabel).toBe("Address missing");
    expect(result.blockers[1].totalCount).toBe(1);
  });

  it("populates warnings only for valid rows", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_first_name: "First",
    };
    const validated = [
      // valid row, no phone → warning
      { Address: "1 Main", State: "MO", First: "Alice" },
      // invalid row, no phone — should NOT generate a warning (it's blocked)
      { Address: "", State: "MO", First: "Bob" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    const warningLabels = result.warnings.map((w) => w.ruleLabel);
    expect(warningLabels).toContain("No phone");
    // Only the valid row contributed
    const noPhone = result.warnings.find((w) => w.ruleLabel === "No phone");
    expect(noPhone?.totalCount).toBe(1);
    expect(noPhone?.rows[0].rowIndex).toBe(0);
  });

  it("excludes empty rows entirely from both buckets", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_first_name: "First",
    };
    const validated = [
      // Row 0 has a name so it's not blank — Address+State error
      { Address: "", State: "", First: "Alice" },
      // Row 1 is fully blank — validator skips it, no errors no warnings
      {},
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    expect(result.blockers).toHaveLength(2); // Address + State for row 0
    // The empty row (rowIndex 1) is in no group anywhere
    for (const group of result.blockers) {
      expect(group.rows.find((r) => r.rowIndex === 1)).toBeUndefined();
    }
  });

  it("identifies rows by address > name > 'Row N' fallback", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_first_name: "First",
      homeowner_last_name: "Last",
      homeowner_phone_1: "Phone",
    };
    const validated = [
      // Row 0: state missing, address present → identifier = address
      { Address: "1 Main", State: "", First: "X" },
      // Row 1: state missing, no address but name present → identifier = name
      { Address: "", State: "", First: "Alice", Last: "Johnson" },
      // Row 2: state missing, no address, no name → identifier = "Row 4".
      //   Has a phone so the row isn't blank, but no usable identifier
      //   (phone alone isn't an identifier we offer).
      { Address: "", State: "", Phone: "5551234567" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    // Find the State-missing group (which all 3 rows trigger)
    const stateGroup = result.blockers.find((b) =>
      b.ruleLabel.startsWith("State"),
    );
    expect(stateGroup).toBeDefined();
    const identifiers = stateGroup!.rows
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map((r) => r.identifier);
    expect(identifiers[0]).toBe("1 Main");
    expect(identifiers[1]).toBe("Alice Johnson");
    expect(identifiers[2]).toBe("Row 4"); // header=row 1, data row 0 = Row 2, etc.
  });

  it("uses the 'invalid_phone' label for bad phone values", () => {
    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_phone_1: "Phone",
    };
    const validated = [
      { Address: "1 Main", State: "MO", Phone: "not-a-phone" },
    ].map((row, i) => validateRow(row, mapping, i));

    const result = groupRowIssues(validated);
    const labels = result.blockers.map((b) => b.ruleLabel);
    expect(labels).toContain("Invalid phone number");
  });
});
