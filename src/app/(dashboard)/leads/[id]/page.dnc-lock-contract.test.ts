import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const lockedBranch = source.slice(
  source.indexOf("if (lead.is_dnc_locked)"),
  source.indexOf("const homeownerSmsPhone"),
);
const lockedView = source.slice(source.indexOf("function LockedDncPropertyDetail"));

describe("locked property detail", () => {
  it("returns the read-only view before any message acknowledgement or contact setup", () => {
    expect(lockedBranch).toContain("return (");
    expect(lockedBranch).toContain("LockedDncPropertyDetail");
    expect(source.indexOf("if (lead.is_dnc_locked)")).toBeLessThan(
      source.indexOf("markMessagesReadForProperty(lead.id)"),
    );
  });

  it("contains no mutation or contact controls", () => {
    expect(lockedView).toContain("PERMANENT DO NOT CONTACT");
    expect(lockedView).toContain('href="/properties"');
    expect(lockedView).not.toContain("DeleteLeadButton");
    expect(lockedView).not.toContain("LeadStatusWidget");
    expect(lockedView).not.toContain("SmsComposer");
    expect(lockedView).not.toContain("InlineReply");
    expect(lockedView).not.toContain("BookAppointmentPopover");
  });
});
