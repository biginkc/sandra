import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("lead detail v2 layout contract", () => {
  it("renders the final hero-to-workspace order", () => {
    const orderedTokens = [
      "<LeadMediaHero",
      "<DealSnapshotStrip",
      "<LeadIdentityActions",
      'data-testid="lead-save-warning"',
      "<AiAttentionBanner",
      'data-testid="lead-workspace-primary"',
    ];
    const offsets = orderedTokens.map((token) => source.indexOf(token));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("removes the normal Page gutter and uses a 340px container-aware dossier", () => {
    expect(source).toContain('<Page className="gap-0 p-0">');
    expect(source).toContain("@container/lead-workspace");
    expect(source).toContain(
      "@min-[1040px]/lead-workspace:grid-cols-[minmax(0,1fr)_340px]",
    );
    expect(source).toContain('aria-label="Lead dossier"');
  });

  it("places the reply and note composer after the unified timeline", () => {
    const timeline = source.indexOf("<LeadActivityTimeline");
    const composers = source.indexOf('data-testid="lead-activity-composers"');
    const reply = source.indexOf("<InlineReply", composers);
    const note = source.indexOf("<AddNoteComposer", composers);
    expect(timeline).toBeGreaterThan(-1);
    expect(composers).toBeGreaterThan(timeline);
    expect(reply).toBeGreaterThan(composers);
    expect(note).toBeGreaterThan(composers);
  });

  it("promotes the five approved snapshot groups and retains Full record", () => {
    for (const token of [
      "Equity (est.)",
      '"ARV"',
      "Repair est.",
      "Mortgage bal.",
      '"Property"',
      'data-testid="lead-full-record"',
    ]) {
      expect(source).toContain(token);
    }
  });
});
