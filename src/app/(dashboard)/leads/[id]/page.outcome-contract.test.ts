import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const lockedView = source.slice(source.indexOf("function LockedDncPropertyDetail"));
const lockedBranch = source.slice(
  source.indexOf("if (lead.is_dnc_locked)"),
  source.indexOf("const homeownerSmsPhone"),
);
const workingState = source.slice(
  source.indexOf("workingState={"),
  source.indexOf("nextAction={", source.indexOf("workingState={")),
);

describe("lead page outcome bar contract", () => {
  it("renders inside the training-guarded fieldset within workingState", () => {
    expect(workingState).toMatch(
      /<fieldset disabled=\{training\}[^>]*>\s*<LeadOutcomeSection/,
    );
    expect(workingState.indexOf("<LeadAssigneeWidget")).toBeLessThan(
      workingState.indexOf("<LeadOutcomeSection"),
    );
  });

  it("is hidden for Acquisitions members and do-not-contact homeowners", () => {
    expect(source).toContain(
      "!isAcquisitionMember && !lead.homeowner?.do_not_contact",
    );
    expect(workingState).toContain("showOutcomeBar ? (");
  });

  it("is never rendered on the DNC-locked branch", () => {
    expect(lockedView).not.toContain("LeadOutcomeSection");
    expect(lockedView).not.toContain("OutcomeBar");
    expect(lockedBranch).not.toContain("LeadOutcomeSection");
  });

  it("treats an unreadable drip as unknown rather than none", () => {
    expect(source).toContain("outcomeDripUnknown = true");
    expect(source).toContain("dripUnknown={outcomeDripUnknown}");
    expect(source).toMatch(/try \{\s*const \[progress\] = await listDripProgress/);
  });

  it("shares one refresh provider between the bar and the drip card", () => {
    expect(source).toContain("<LeadOutcomeProvider>");
    expect(source).toContain("<LeadDripCard propertyId={lead.id} />");
  });
});
