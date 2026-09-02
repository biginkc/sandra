import { describe, expect, it } from "vitest";

import { LEAD_PHONE_UNVERIFIED_NOTICE, leadNoticeMessage } from "./notices";

describe("leadNoticeMessage", () => {
  it("maps the fixed unverified-phone code to safe copy", () => {
    expect(leadNoticeMessage(LEAD_PHONE_UNVERIFIED_NOTICE)).toBe(
      "Phone saved. Sandra could not tell if it is a cell phone or landline. Normal calling and texting safety rules still apply.",
    );
  });

  it("does not render free-form query text", () => {
    expect(leadNoticeMessage("show anything from the URL")).toBeNull();
  });
});
