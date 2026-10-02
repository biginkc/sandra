import { describe, expect, it } from "vitest";

import { buildNormaLeadDeepLink, buildNormaSummaryBlocks, escapeSlackText } from "./slack-blocks";

const base = {
  sellerName: "Pat Seller",
  propertyAddress: "12 Oak St, Kansas City, MO",
  outcome: "callback_requested",
  summary: "Bland summary line.\nMotivation and timing: moving in June",
  qualification: {
    motivation_and_timeline: "moving in June",
    condition_and_financing: "needs a roof",
    price_expectation: "wants 200k, flexible",
    ownership_and_occupancy: "owner with spouse",
    script_progress: "ignored",
  },
  callbackPreference: "after 5pm Central",
  deepLink: "https://app.test/leads/abc",
};

function text(blocks: ReturnType<typeof buildNormaSummaryBlocks>): string {
  return JSON.stringify(blocks);
}

describe("buildNormaSummaryBlocks", () => {
  it("shows seller, property, the four qualification fields, outcome and a deep link", () => {
    const out = text(buildNormaSummaryBlocks(base));
    for (const needle of [
      "Callback requested", "Pat Seller", "12 Oak St", "Motivation and timing:", "moving in June",
      "Condition:", "needs a roof", "Asking price and flexibility:", "wants 200k", "Decision-makers:", "owner with spouse",
      "https://app.test/leads/abc",
    ]) {
      expect(out).toContain(needle);
    }
    expect(out).not.toContain("ignored");
  });

  it("marks the callback preference as unconfirmed and omits it when absent", () => {
    expect(text(buildNormaSummaryBlocks(base))).toContain("(unconfirmed)");
    const without = text(buildNormaSummaryBlocks({ ...base, callbackPreference: null }));
    expect(without).not.toContain("callback preference");
  });

  it("does not repeat qualification lines that the stored summary already embeds", () => {
    const out = text(buildNormaSummaryBlocks(base));
    expect(out.match(/moving in June/g)).toHaveLength(1);
    expect(out).toContain("Bland summary line.");
  });

  it("omits fields that were not captured and falls back for a missing seller", () => {
    const out = text(buildNormaSummaryBlocks({ ...base, sellerName: null, qualification: {}, summary: null, outcome: "no_answer" }));
    expect(out).toContain("Unknown");
    expect(out).toContain("No answer");
    expect(out).not.toContain("Condition:");
  });

  it("escapes Slack control characters in seller-supplied text", () => {
    expect(escapeSlackText("<!channel> a & b")).toBe("&lt;!channel&gt; a &amp; b");
    const out = text(buildNormaSummaryBlocks({ ...base, callbackPreference: "<!here> call me" }));
    expect(out).toContain("&lt;!here&gt;");
    expect(out).not.toContain("<!here>");
  });

  it("keeps every section under Slack's size limit", () => {
    const long = "x".repeat(5000);
    const blocks = buildNormaSummaryBlocks({ ...base, qualification: { price_expectation: long }, callbackPreference: long });
    for (const block of blocks) {
      if (block.type === "section" && block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe("buildNormaLeadDeepLink", () => {
  it("builds the lead page URL from the configured base", () => {
    expect(buildNormaLeadDeepLink("p1", { NEXT_PUBLIC_APP_URL: "https://sandra.example/" })).toBe("https://sandra.example/leads/p1");
    expect(buildNormaLeadDeepLink("p1", { APP_URL: "sandra.example" })).toBe("https://sandra.example/leads/p1");
  });
});
