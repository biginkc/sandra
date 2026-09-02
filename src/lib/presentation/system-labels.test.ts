import { describe, expect, it } from "vitest";

import {
  LEAD_SOURCE_LABELS,
  MEMBERSHIP_ROLE_LABELS,
  PROPERTY_STATUS_LABELS,
  SEQUENCE_ACTION_LABELS,
  systemLabel,
} from "./system-labels";

describe("system value labels", () => {
  it("presents known machine values as human-readable text", () => {
    expect(systemLabel(SEQUENCE_ACTION_LABELS, "send_sms")).toBe("Send SMS");
    expect(systemLabel(PROPERTY_STATUS_LABELS, "under_contract")).toBe(
      "Under contract",
    );
    expect(systemLabel(LEAD_SOURCE_LABELS, "cold_call")).toBe("Cold call");
    expect(systemLabel(MEMBERSHIP_ROLE_LABELS, "owner")).toBe("Owner");
  });

  it("returns an unknown stored value unchanged", () => {
    expect(systemLabel(LEAD_SOURCE_LABELS, "future_source")).toBe(
      "future_source",
    );
  });
});
