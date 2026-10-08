import { describe, expect, it } from "vitest";

import { APPROVAL_NOTE, APPROVED_REPLY_NAMES, APPROVED_REPLY_TEXTS } from "./approved-reply-texts";

describe("approved reply texts (Jarrad, 2026-10-07)", () => {
  it("pins every text character for character", () => {
    expect(APPROVED_REPLY_TEXTS.not_interested).toBe(
      "Sounds good, thanks for letting me know. If anything changes in the next 6-12 months, mind if I check back?",
    );
    expect(APPROVED_REPLY_TEXTS.hostile).toBe("Terribly sorry for the inconvenience. We've updated our records.");
    expect(APPROVED_REPLY_TEXTS.wrong_number).toBe(
      "Sorry about that, my mistake. I'll take this number off our list. Any chance you know who owns the place?",
    );
    expect(APPROVED_REPLY_TEXTS.nurture).toBe("Fantastic! We will keep in touch.");
    expect(Object.keys(APPROVED_REPLY_TEXTS).sort()).toEqual(["hostile", "not_interested", "nurture", "wrong_number"]);
  });

  it("pins the exact bytes (plain ASCII, straight apostrophes, no trailing space)", () => {
    for (const text of Object.values(APPROVED_REPLY_TEXTS)) {
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text).toBe(text.trim());
    }
    expect(Buffer.from(APPROVED_REPLY_TEXTS.hostile).toString("hex")).toBe(
      Buffer.from("Terribly sorry for the inconvenience. We've updated our records.", "utf8").toString("hex"),
    );
  });

  it("carries the approval note in each library name and fits the name column", () => {
    expect(APPROVAL_NOTE).toBe("Text approved by Jarrad 2026-10-07; click Approve to enable");
    for (const name of Object.values(APPROVED_REPLY_NAMES)) {
      expect(name).toContain(APPROVAL_NOTE);
      expect(name.length).toBeLessThanOrEqual(120);
    }
  });
});
