import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Lead Detail v2 integration contract", () => {
  it("keeps three independent bounded activity reads", () => {
    expect(source).toContain('.from("messages")');
    expect(source).toContain('.from("lead_notes")');
    expect(source).toContain('.from("call_activities")');
    expect(source.match(/\.limit\(200\)/g)).toHaveLength(2);
    expect(source).toContain(".limit(20)");
    expect(source).toContain("messageError={threadError?.message ?? null}");
    expect(source).toContain("noteError={notesError?.message ?? null}");
    expect(source).toContain("callError={callRollupError?.message ?? null}");
  });

  it("keeps both SMS entry points behind the same consent result", () => {
    expect(source.match(/<SmsEntryPointGate/g)).toHaveLength(2);
    expect(source).toContain('placement="header"');
    expect(source).toContain('placement="inline"');
    expect(
      source.match(/restricted=\{smsPresentation\.smsRestricted\}/g),
    ).toHaveLength(2);
  });

  it("keeps the permanent DNC return ahead of normal-page work", () => {
    expect(source.indexOf("if (lead.is_dnc_locked)")).toBeLessThan(
      source.indexOf("smsConsentEventsPromise"),
    );
    expect(source).toContain('data-testid="permanent-dnc-lock"');
  });

  it("marks lead messages read on open and includes call fallback time", () => {
    expect(source).toContain("void markMessagesReadForProperty(lead.id)");
    expect(source).toContain(
      '"id, created_at, started_at, outcome, disposition',
    );
  });

  it("retains the full PARITY.md control set", () => {
    for (const token of [
      "SoftphoneLeadButton",
      "SmsComposer",
      "BookAppointmentPopover",
      "NextActionCard",
      "LeadStatusWidget",
      "LeadMotivationWidget",
      "LeadAssigneeWidget",
      "LeadActivityTimeline",
      "InlineReply",
      "AddNoteComposer",
      "LeadAppointmentsSection",
      "LeadTaskWidget",
      "TagsSection",
      "AiResponderToggle",
      "SkipTraceToggle",
      "SkipTraceButton",
      "CassWidget",
      "EnrollInSequenceWidget",
      "DeleteLeadButton",
      'data-testid="zillow-link-header"',
      'data-testid="zillow-link-panel"',
      'aria-label="Previous"',
      'aria-label="Next"',
    ]) {
      expect(source).toContain(token);
    }
  });
});
