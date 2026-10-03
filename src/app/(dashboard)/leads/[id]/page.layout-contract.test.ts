import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const tagsSource = fs.readFileSync(
  path.join(__dirname, "tags-section.tsx"),
  "utf8",
);

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

  it("removes the normal Page gutter and uses the 1280px two-column boundary", () => {
    expect(source).toContain('<Page className="gap-0 p-0">');
    expect(source).toContain("@container/lead-workspace");
    expect(source).toContain("xl:grid-cols-[minmax(0,1fr)_340px]");
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
    expect(source).toContain("inlineReplyUnavailable");
    expect(source).toContain(
      "restricted={inlineSmsPresentation.smsRestricted}",
    );
    expect(source).toContain("!inlineSmsPresentation.smsRestricted");
    expect(source).toMatch(
      /inlineSmsPresentation\.smsRestricted\s*\|\|\s*inlineReplyUnavailable/,
    );
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

  it("keeps the expanded custom-tag input at the 36px route target", () => {
    expect(tagsSource).toContain('className="h-9 w-48 max-w-full text-xs"');
  });

  it("composes Log follow-up: the provider wraps the hero and the trigger appears only inside the hero actions", () => {
    const provider = source.indexOf("<LogFollowUpProvider");
    const hero = source.indexOf("<LeadMediaHero");
    const providerEnd = source.indexOf("</LogFollowUpProvider>");
    expect(provider).toBeGreaterThan(-1);
    expect(hero).toBeGreaterThan(provider);
    expect(providerEnd).toBeGreaterThan(hero);
    // Exactly one trigger, and it lives in the heroActions fragment.
    expect(source.match(/<LogFollowUpTrigger/g)).toHaveLength(1);
    const actionsStart = source.indexOf("const heroActions = (");
    const actionsEnd = source.indexOf("\n  );", actionsStart);
    const trigger = source.indexOf("<LogFollowUpTrigger");
    expect(actionsStart).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(actionsStart);
    expect(trigger).toBeLessThan(actionsEnd);
    // heroActions reaches the page only through the hero, which sits inside the provider.
    expect(source.match(/\{heroActions\}/g)).toHaveLength(1);
    const heroProps = source.slice(hero, source.indexOf("/>", hero));
    expect(heroProps).toContain("actions={heroActions}");
    // Training leads cannot reach the trigger, and the provider is scoped to the viewer.
    expect(source).toMatch(/<fieldset disabled=\{training\} inert=\{training \|\| undefined\} className="contents"><LogFollowUpTrigger \/><\/fieldset>/);
    expect(source).toContain("viewer={{ userId: sessionUser?.id ?? \"\", orgId: lead.org_id }}");
  });
});
