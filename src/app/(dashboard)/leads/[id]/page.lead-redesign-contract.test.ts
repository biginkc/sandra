import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Lead Detail v2 integration contract", () => {
  it("keeps three isolated logical activity sources with bounded reads", () => {
    expect(source).toContain('.from("messages")');
    expect(source).toContain('.from("lead_notes")');
    expect(source).toContain('.from("call_activities")');
    expect(source.match(/\.limit\(200\)/g)).toHaveLength(2);
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
  });

  it("excludes cross-org and inactive auth users from note author payloads", () => {
    for (const token of [
      '.from("memberships")',
      '.eq("org_id", lead.org_id)',
      '.eq("access_status", "active")',
      '.is("deletion_prepared_at", null)',
      "access_expires_at.is.null,access_expires_at.gt.${activeMembershipAt}",
      ".limit(orgAuthorCap + 1)",
      "membershipResult.data.length > orgAuthorCap",
      "const authUsersPerPage = 200",
      "const maxAuthUserPages = 25",
      "page <= maxAuthUserPages",
      "page += 1",
      "admin.auth.admin.listUsers",
      "perPage: authUsersPerPage",
      "authUsersById.size >= orgMemberIds.size",
      "authUsers.length < authUsersPerPage",
      "orgMemberIds.has(user.id)",
    ]) {
      expect(source).toContain(token);
    }
    expect(source).not.toContain("data.nextPage");
    const authError = source.indexOf("if (authUsersResult.error)");
    expect(authError).toBeGreaterThan(-1);
    expect(source.indexOf("return []", authError)).toBeGreaterThan(authError);
    const orgFilter = source.indexOf("orgMemberIds.has(user.id)");
    const clientAuthorMap = source.indexOf(
      "if (u.email) authorEmails[u.id] = u.email",
    );
    expect(orgFilter).toBeGreaterThan(-1);
    expect(clientAuthorMap).toBeGreaterThan(orgFilter);
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
});
