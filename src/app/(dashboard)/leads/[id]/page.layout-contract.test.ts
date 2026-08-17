import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("lead detail record summary layout", () => {
  it("places the four compact record panels before Working state", () => {
    const summaryClass =
      'className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"';
    const summaryStart = source.indexOf(summaryClass);
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const summarySource = source.slice(summaryStart, workingStateStart);

    expect(summaryStart).toBeGreaterThan(-1);
    expect(workingStateStart).toBeGreaterThan(summaryStart);
    expect(summarySource).toContain(summaryClass);
    expect(summarySource).toContain('data-testid="lead-record-summary"');
    expect(summarySource.match(/<Section title=/g)).toHaveLength(4);
    expect(summarySource).toContain('<Section title="Property">');
    expect(summarySource).toContain('<Section title="Address quality (USPS)">');
    expect(summarySource).toContain('<Section title="Homeowner">');
    expect(summarySource).toContain('<Section title="Listing agent">');
  });

  it("keeps imported notes out of the four-column summary", () => {
    const summaryStart = source.indexOf(
      'className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"',
    );
    const workingStateStart = source.indexOf("<LeadIdentityActions");
    const importedNotesStart = source.indexOf(
      '<Section title="Imported notes (legacy)">',
    );

    expect(importedNotesStart).toBeGreaterThan(workingStateStart);
    expect(source.slice(summaryStart, workingStateStart)).not.toContain(
      "Imported notes (legacy)",
    );
  });
});
