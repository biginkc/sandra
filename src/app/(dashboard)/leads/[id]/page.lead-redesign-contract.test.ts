import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Lead Detail v2 integration contract", () => {
  it("keeps four isolated logical activity sources with bounded reads", () => {
    expect(source).toContain('.from("messages")');
    expect(source).toContain('.from("lead_notes")');
    expect(source).toContain('.from("call_activities")');
    expect(source).toContain('.from("lead_events")');
    expect(source.match(/\.limit\(200\)/g)).toHaveLength(3);
    const callWindowSource = source.slice(
      source.indexOf("const callSelection"),
      source.indexOf("const { data: openWorkRaw"),
    );
    expect(callWindowSource.match(/\.limit\(20\)/g)).toHaveLength(2);
    expect(source).toContain('.not("started_at", "is", null)');
    expect(source).toContain('.is("started_at", null)');
    expect(source).toContain("selectLatestCallActivityRows");
    expect(source).toContain(
      "and(contact_id.eq.${homeownerContactId},property_id.is.null)",
    );
    expect(source).toContain("messageError={threadError?.message ?? null}");
    expect(source).toContain("noteError={notesError?.message ?? null}");
    expect(source).toContain("callError={callRollupError?.message ?? null}");
    expect(source).toContain("eventError={leadEventsError?.message ?? null}");
    expect(source).toContain("initialEvents={initialLeadEvents}");
    expect(source).toContain("key={lead.id}");
  });

  it("uses the shared org-scoped roster and keeps former authors readable", () => {
    expect(source).toContain("loadOrgTeamMembers(lead.org_id");
    expect(source).toContain("includeInactiveMembers: true");
    expect(source).toContain("allowMissingIdentityLabels: true");
    expect(source).toContain("teamMemberPrimaryLabel(member");
    expect(source).not.toContain("admin.auth.admin.listUsers");
  });

  it("shares consent state while restricting each SMS entry point by its exact phone", () => {
    expect(source.match(/<SmsEntryPointGate/g)).toHaveLength(2);
    expect(source).toContain('placement="header"');
    expect(source).toContain('placement="inline"');

    const headerGateStart = source.indexOf("<SmsEntryPointGate");
    const inlineGateStart = source.indexOf(
      "<SmsEntryPointGate",
      headerGateStart + 1,
    );
    const headerGate = source.slice(headerGateStart, inlineGateStart);
    const inlineGate = source.slice(
      inlineGateStart,
      source.indexOf("</SmsEntryPointGate>", inlineGateStart),
    );
    expect(headerGate).toContain("restricted={smsPresentation.smsRestricted}");
    expect(inlineGate).toContain(
      "restricted={inlineSmsPresentation.smsRestricted}",
    );

    const headerPresentationStart = source.indexOf("const smsPresentation =");
    const inlinePresentationStart = source.indexOf(
      "const inlineSmsPresentation =",
    );
    const headerPresentation = source.slice(
      headerPresentationStart,
      inlinePresentationStart,
    );
    const inlinePresentation = source.slice(
      inlinePresentationStart,
      source.indexOf("// Tags attached", inlinePresentationStart),
    );
    expect(headerPresentation).toContain("consentState,");
    expect(inlinePresentation).toContain("consentState,");
    expect(headerPresentation).toContain("phoneSuppressionResult");
    expect(inlinePresentation).toContain("inlinePhoneSuppressionResult");
    expect(inlinePresentation).toContain("latestHomeownerSmsRoute");
    expect(inlinePresentation).toContain(": smsPresentation");
  });

  it("keeps the permanent DNC return ahead of normal-page work", () => {
    expect(source.indexOf("if (lead.is_dnc_locked)")).toBeLessThan(
      source.indexOf("smsConsentEventsPromise"),
    );
    expect(source).toContain('data-testid="permanent-dnc-lock"');
  });

  it("marks lead messages read on open and includes call fallback time", () => {
    expect(source).toContain("await markMessagesReadForProperty(lead.id)");
    expect(
      source.indexOf("await markMessagesReadForProperty(lead.id)"),
    ).toBeLessThan(source.indexOf('.from("messages")'));
    expect(source).toContain(
      '"id, created_at, started_at, outcome, disposition',
    );
  });

  it("orders working state as status, motivation, then assignee", () => {
    const workingState = source.indexOf("workingState={");
    const status = source.indexOf("<LeadStatusWidget", workingState);
    const motivation = source.indexOf("<LeadMotivationWidget", workingState);
    const assignee = source.indexOf("<LeadAssigneeWidget", workingState);
    expect([status, motivation, assignee]).toEqual(
      [...[status, motivation, assignee]].sort((a, b) => a - b),
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
    expect(source.match(/<BookAppointmentPopover/g)).toHaveLength(2);
    for (const label of [
      "SMS consent",
      "SMS restriction",
      "Contact DNC flag",
    ]) {
      expect(
        source.match(new RegExp(label, "g"))?.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("offers Skip Trace only when the homeowner or primary phone is missing", () => {
    expect(source).toContain("!lead.homeowner || !lead.homeowner.phone_1 ? (");
    expect(source).not.toContain(
      "<SkipTraceButton propertyId={lead.id} />\n      <span",
    );
  });
});
