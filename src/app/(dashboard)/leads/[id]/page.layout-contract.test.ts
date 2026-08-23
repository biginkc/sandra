import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("lead detail record summary layout", () => {
  it("places the four compact record panels before Working state", () => {
    const summaryTestIdStart = source.indexOf(
      'data-testid="lead-record-summary"',
    );
    const summaryStart = source.lastIndexOf("<div", summaryTestIdStart);
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const summarySource = source.slice(summaryStart, workingStateStart);

    expect(summaryStart).toBeGreaterThan(-1);
    expect(workingStateStart).toBeGreaterThan(summaryStart);
    expect(summarySource).toMatch(
      /className=["'][^"']*\bgrid-cols-1\b[^"']*\bmd:grid-cols-2\b[^"']*\bmin-\[1440px\]:grid-cols-4\b[^"']*["']/,
    );
    expect(summarySource.match(/<Section title=/g)).toHaveLength(4);
    const orderedTitles = [
      '<Section title="Property">',
      '<Section title="Address quality (USPS)">',
      '<Section title="Homeowner">',
      '<Section title="Listing agent">',
    ];
    const titleOffsets = orderedTitles.map((title) =>
      summarySource.indexOf(title),
    );
    expect(titleOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(titleOffsets).toEqual([...titleOffsets].sort((a, b) => a - b));
    expect(summarySource).toMatch(
      /<SoftphoneLeadButton\s+lead=\{detailSoftphoneLead\}\s*\/>/,
    );
  });

  it("keeps imported notes out of the four-column summary", () => {
    const summaryTestIdStart = source.indexOf(
      'data-testid="lead-record-summary"',
    );
    const summaryStart = source.lastIndexOf("<div", summaryTestIdStart);
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const importedNotesStart = source.indexOf(
      '<Section title="Imported notes (legacy)">',
    );

    expect(summaryStart).toBeGreaterThan(-1);
    expect(workingStateStart).toBeGreaterThan(summaryStart);
    expect(importedNotesStart).toBeGreaterThan(workingStateStart);
    expect(source.slice(summaryStart, workingStateStart)).not.toContain(
      "Imported notes (legacy)",
    );
  });
});
