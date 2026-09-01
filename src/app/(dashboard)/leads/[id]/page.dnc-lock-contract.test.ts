import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const lockedBranch = source.slice(
  source.indexOf("if (lead.is_dnc_locked)"),
  source.indexOf("const homeownerSmsPhone"),
);
const lockedView = source.slice(
  source.indexOf("function LockedDncPropertyDetail"),
);
const heroActionsStart = source.indexOf("const heroActions = (");
const normalZillowAction = source.slice(
  source.indexOf("{zillowHref ? (", heroActionsStart),
  source.indexOf("<SendForSignature", heroActionsStart),
);
const lockedZillowAction = lockedView.slice(
  lockedView.indexOf("{zillowHref ? ("),
  lockedView.indexOf("{prevId ? ("),
);

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
    expect(lockedView).toContain(
      'mode === "prospect" ? "/properties" : "/leads"',
    );
    expect(lockedView).not.toContain("DeleteLeadButton");
    expect(lockedView).not.toContain("LeadStatusWidget");
    expect(lockedView).not.toContain("SmsComposer");
    expect(lockedView).not.toContain("InlineReply");
    expect(lockedView).not.toContain("BookAppointmentPopover");
  });

  it("derives locked navigation and breadcrumbs from the record's historical stage", () => {
    expect(lockedBranch).toContain(
      'const lockedMode = lead.status === "prospect" ? "prospect" : "lead"',
    );
    expect(lockedBranch).toContain("getPropertyNeighbors(id, lockedMode)");
    expect(lockedBranch).toContain("mode={lockedMode}");
    expect(lockedView).toContain("collectionHref");
    expect(lockedView).toContain("collectionLabel");
    expect(lockedView).toContain("recordLabel");
  });

  it("keeps locked Back, Zillow, and neighbor controls at least 44px high", () => {
    expect(lockedView).toContain("[&_button]:min-h-11");
    expect(lockedView.match(/className="min-w-11"/g)).toHaveLength(2);
    expect(lockedView).toContain('aria-label="View on Zillow"');
    expect(lockedZillowAction).toContain('className: "min-h-11"');
  });

  it("renders one semantic Zillow link without a nested button in both detail paths", () => {
    for (const action of [normalZillowAction, lockedZillowAction]) {
      expect(action.match(/<a\b/g)).toHaveLength(1);
      expect(action).toContain("buttonVariants({");
      expect(action).toContain('variant: "outline"');
      expect(action).toContain('size: "sm"');
      expect(action).not.toContain("<Button");
    }
    expect(normalZillowAction).toContain(
      '"min-h-9 border-white/80 bg-white/95 text-slate-950 shadow-sm hover:bg-white"',
    );
  });
});
