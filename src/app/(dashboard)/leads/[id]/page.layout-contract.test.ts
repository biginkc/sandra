import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

function locateLeadRecordSummary() {
  const testIdStart = source.indexOf('data-testid="lead-record-summary"');
  const openingTagStart = source.lastIndexOf("<div", testIdStart);
  const openingTagEnd = source.indexOf(">", openingTagStart);

  return { testIdStart, openingTagStart, openingTagEnd };
}

describe("lead detail record summary layout", () => {
  it("places the four compact record panels before Working state", () => {
    const {
      testIdStart: summaryTestIdStart,
      openingTagStart: summaryStart,
      openingTagEnd: summaryOpeningTagEnd,
    } = locateLeadRecordSummary();
    const summaryOpeningTag = source.slice(summaryStart, summaryOpeningTagEnd);
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const summarySource = source.slice(summaryStart, workingStateStart);

    expect(summaryTestIdStart).toBeGreaterThan(-1);
    expect(summaryStart).toBeGreaterThan(-1);
    expect(summaryOpeningTagEnd).toBeGreaterThan(summaryStart);
    expect(summaryTestIdStart).toBeLessThan(summaryOpeningTagEnd);
    expect(workingStateStart).toBeGreaterThan(summaryStart);
    const className = summaryOpeningTag.match(
      /className=["']([^"']*)["']/,
    )?.[1];
    expect(className).toBeDefined();
    const classTokens = new Set(className?.split(/\s+/).filter(Boolean));
    expect(classTokens.has("grid")).toBe(true);
    expect(classTokens.has("grid-cols-1")).toBe(true);
    expect(classTokens.has("md:grid-cols-2")).toBe(true);
    expect(classTokens.has("min-[1440px]:grid-cols-4")).toBe(true);
    expect(summarySource.match(/<Section\s+title=/g)).toHaveLength(4);
    const orderedTitlePatterns = [
      /<Section\s+title=["']Property["']/,
      /<Section\s+title=["']Address quality \(USPS\)["']/,
      /<Section\s+title=["']Homeowner["']/,
      /<Section\s+title=["']Listing agent["']/,
    ];
    const titleOffsets = orderedTitlePatterns.map(
      (pattern) => summarySource.match(pattern)?.index ?? -1,
    );
    expect(titleOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(titleOffsets).toEqual([...titleOffsets].sort((a, b) => a - b));
    expect(summarySource).toMatch(
      /<SoftphoneLeadButton\s+lead=\{detailSoftphoneLead\}\s*\/>/,
    );
  });

  it("keeps imported notes out of the four-column summary", () => {
    const {
      testIdStart: summaryTestIdStart,
      openingTagStart: summaryStart,
      openingTagEnd: summaryOpeningTagEnd,
    } = locateLeadRecordSummary();
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const importedNotesStart =
      source.match(/<Section\s+title=["']Imported notes \(legacy\)["']/)
        ?.index ?? -1;

    expect(summaryTestIdStart).toBeGreaterThan(-1);
    expect(summaryStart).toBeGreaterThan(-1);
    expect(summaryOpeningTagEnd).toBeGreaterThan(summaryStart);
    expect(summaryTestIdStart).toBeLessThan(summaryOpeningTagEnd);
    expect(workingStateStart).toBeGreaterThan(summaryStart);
    expect(importedNotesStart).toBeGreaterThan(workingStateStart);
    expect(source.slice(summaryStart, workingStateStart)).not.toContain(
      "Imported notes (legacy)",
    );
  });
});
