import { describe, expect, it } from "vitest";

import { parseSelectedLeadParam, selectedLeadUnavailableMessage } from "./deep-link";

const UPPERCASE = "AABBCCDD-EEFF-4011-8223-445566778899";
const LOWERCASE = UPPERCASE.toLowerCase();

describe("My Leads selected lead links", () => {
  it("accepts one UUID and canonicalizes it to lower case", () => {
    expect(parseSelectedLeadParam({ lead: UPPERCASE })).toEqual({
      status: "requested",
      propertyId: LOWERCASE,
    });
  });

  it.each(["", "not-a-uuid", `${LOWERCASE}/extra`, "00000000-0000-0000-0000-00000000000g"])(
    "rejects malformed lead parameter %s",
    (lead) => {
      expect(parseSelectedLeadParam({ lead })).toEqual({ status: "invalid", reason: "malformed" });
    },
  );

  it("rejects duplicate lead parameters instead of choosing one", () => {
    expect(parseSelectedLeadParam({ lead: [LOWERCASE, UPPERCASE] })).toEqual({
      status: "invalid",
      reason: "duplicate",
    });
  });

  it("does not treat an absent lead parameter as a selection", () => {
    expect(parseSelectedLeadParam({})).toEqual({ status: "none" });
  });

  it("keeps access-denial reasons explicit", () => {
    expect(selectedLeadUnavailableMessage("other_rep")).toContain("will not switch queues");
    expect(selectedLeadUnavailableMessage("closed_dead_dnc")).toContain("DNC-locked");
    expect(selectedLeadUnavailableMessage("archived")).toContain("archived");
  });
});
