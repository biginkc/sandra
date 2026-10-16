import { describe, expect, it } from "vitest";

import { SOLD_NEEDS_HUMAN_REASON, SOLD_PHRASES, isSoldInbound } from "./sold";

describe("sold wording", () => {
  it("is the RULES-PROPOSAL NI-1 'Must NOT fire' sold list plus the two build-brief additions, pinned", () => {
    expect([...SOLD_PHRASES]).toEqual(["sold", "just sold", "already sold", "been sold", "it is sold"]);
    expect(SOLD_NEEDS_HUMAN_REASON).toBe("sold_needs_human");
  });

  it.each(["sold", "Just sold!", "it's already sold", "it has been sold", "It is sold", "SOLD last week"])(
    "matches %j",
    (body) => {
      expect(isSoldInbound(body)).toBe(true);
    },
  );

  it("does not match unrelated wording", () => {
    for (const body of ["not interested", "I sell houses", "unsold", "soldier", "no thanks", "", "resold it"]) {
      expect(isSoldInbound(body)).toBe(false);
    }
    expect(isSoldInbound(null)).toBe(false);
  });
});
