import { describe, expect, it } from "vitest";

import { SOFTPHONE_DISPOSITIONS } from "./dispositions";

describe("softphone disposition mapping", () => {
  it("uses the Messages vocabulary and excludes prototype-only outcomes", () => {
    expect(SOFTPHONE_DISPOSITIONS.map((item) => item.value)).toEqual([
      "nurture",
      "wrong_number",
      "bad_number",
      "not_interested",
      "needs_sequence",
      "opted_out",
      "dnc",
    ]);
    expect(SOFTPHONE_DISPOSITIONS.map((item) => item.label)).not.toContain("Offer discussed");
    expect(SOFTPHONE_DISPOSITIONS.map((item) => item.label)).not.toContain("Voicemail");
  });
});
