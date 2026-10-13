import { describe, expect, it } from "vitest";

import type { ClassificationBridgeResult } from "../dispatch-bridge";
import { jevOutcomeForLunaHold } from "./hold";

const route = (action: string, eligibleForAutoAccept: boolean) =>
  ({ kind: "jev_route", assembled: { action }, eligibleForAutoAccept }) as unknown as ClassificationBridgeResult;

describe("jevOutcomeForLunaHold", () => {
  it("maps below-threshold routes to the Jev outcome", () => {
    expect(jevOutcomeForLunaHold(route("close_not_interested", false))).toBe("not_interested");
    expect(jevOutcomeForLunaHold(route("close_wrong_number", false))).toBe("wrong_number");
    expect(jevOutcomeForLunaHold(route("escalate", false))).toBe("new_lead");
  });
  it("uses the needs-decision outcome", () => {
    expect(jevOutcomeForLunaHold({ kind: "jev_needs_decision", outcome: "nurture" } as ClassificationBridgeResult)).toBe("nurture");
  });
  it("is null for opt-out / dnc, auto-accepted and non-hold results", () => {
    expect(jevOutcomeForLunaHold(route("opt_out", false))).toBeNull();
    expect(jevOutcomeForLunaHold(route("close_dnc", false))).toBeNull();
    expect(jevOutcomeForLunaHold(route("close_not_interested", true))).toBeNull();
    for (const kind of ["use_legacy", "jev_nurture", "jev_no_action", "jev_automatic_failed", "jev_promote_new_lead"]) {
      expect(jevOutcomeForLunaHold({ kind } as unknown as ClassificationBridgeResult)).toBeNull();
    }
  });
});
