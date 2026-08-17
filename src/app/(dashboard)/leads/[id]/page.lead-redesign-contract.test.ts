import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Lead Detail redesign integration contract", () => {
  it("loads the lead's open dated work and does not call a query failure empty", () => {
    expect(source).toContain('.from("tasks")');
    expect(source).toContain('.eq("related_property_id", lead.id)');
    expect(source).toContain('.eq("status", "open")');
    expect(source).toContain('.order("due_at", { ascending: true })');
    expect(source).toContain("lead-next-action-load-failure");
    expect(source).toContain("This is not the same as having no next action");
  });

  it("gates the header and inline SMS entry points from the same actual opt-out state", () => {
    expect(source.match(/<SmsEntryPointGate/g)).toHaveLength(2);
    expect(source).toContain('placement="header"');
    expect(source).toContain('placement="inline"');
    expect(
      source.match(/restricted=\{smsPresentation\.smsRestricted\}/g),
    ).toHaveLength(2);
  });

  it("loads the newest 200 messages, then restores chronological rendering", () => {
    const queryStart = source.indexOf("const { data: threadRaw");
    const queryEnd = source.indexOf("let latestInboundSenderQuery", queryStart);
    const query = source.slice(queryStart, queryEnd);
    expect(query).toContain('.order("created_at", { ascending: false })');
    expect(query).toContain(".limit(200)");
    expect(query).toContain("].reverse()");
    expect(query.indexOf("ascending: false")).toBeLessThan(
      query.indexOf(".limit(200)"),
    );
  });

  it("keeps permanent DNC on its earlier, separate read-only return path", () => {
    expect(source.indexOf("if (lead.is_dnc_locked)")).toBeLessThan(
      source.indexOf("smsConsentEventsPromise"),
    );
    expect(source).toContain('data-testid="permanent-dnc-lock"');
  });

  it("preserves secondary capabilities and navigation selectors", () => {
    for (const token of [
      "EnrollInSequenceWidget",
      "CassWidget",
      "SkipTraceToggle",
      "SkipTraceButton",
      "TagsSection",
      "NotesFeed",
      "LeadCallSummary",
      'data-testid="zillow-link-header"',
      'data-testid="zillow-link-panel"',
      'aria-label="Previous"',
      'aria-label="Next"',
      "DeleteLeadButton",
    ]) {
      expect(source).toContain(token);
    }
  });
});
