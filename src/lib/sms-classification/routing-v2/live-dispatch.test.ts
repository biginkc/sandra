import { describe, expect, it } from "vitest";

import { liveHoldReason, liveStepFor, storedFinalDecision, storedV2Decision, type StoredLiveEvidence } from "./live-dispatch";

const base: StoredLiveEvidence = {
  status: "decided", org_id: "o", property_id: "p", road: "who_reply_drip", jev_road: "who_reply_drip",
  provenance: { by: "jev", row: "15", step: "asked_who", signal: "asked_who", probability: 0.9 } as StoredLiveEvidence["provenance"],
  haiku_eligibility: null, haiku: null, opportunity_alert: false,
  action: { road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] }, expected_revision: 1, failure_reason: null,
};
const withAction = (road: string, steps: unknown[]) => ({ ...base, road, action: { road, steps } } as StoredLiveEvidence);

describe("live v2 step selection from stored evidence", () => {
  it.each([
    [{ ...base, status: "failed", action: null, failure_reason: "jev_incomplete" } as StoredLiveEvidence, { kind: "failed", reason: "jev_incomplete" }],
    [withAction("stop", [{ kind: "hold", reason: "asked_stop" }]), { kind: "stop" }],
    [withAction("wrong_number_close", [{ kind: "wrong_number_close" }]), { kind: "wrong_number" }],
    [withAction("bad_number", [{ kind: "hold", reason: "bad_number" }]), { kind: "bad_number" }],
    [withAction("possible_stop", [{ kind: "hold", reason: "asked_stop" }, { kind: "alert", reason: "possible_stop" }]), { kind: "hold", reason: "asked_stop" }],
    [withAction("haiku_error", [{ kind: "hold", reason: "needs_person" }, { kind: "alert", reason: "haiku_error" }]), { kind: "hold", reason: "needs_person" }],
    [base, { kind: "transition" }],
  ])("%#", (e, step) => {
    expect(liveStepFor(e)).toEqual(step);
  });
  it("holds only with registered reasons", () => {
    expect(liveHoldReason("asked_stop")).toBe("nine_asked_stop");
    expect(liveHoldReason("needs_person")).toBe("nine_needs_person");
    expect(liveHoldReason("bad_number")).toBe("nine_needs_person");
  });
  it("rebuilds Jev's original decision (not the post-Haiku road) and the recorded final", () => {
    const e = { ...base, road: "haiku_unsure", jev_road: "stop", haiku_eligibility: "decider_band", haiku: { final_road: "stop", final_by: "jev_haiku_unsure", hold: true, alert: "x", failure_reason: null } } as StoredLiveEvidence;
    expect(storedV2Decision(e)).toMatchObject({ road: "stop", haiku: "decider_band" });
    expect(storedFinalDecision(e)).toEqual({ road: "stop", by: "jev_haiku_unsure", hold: true, alert: "x", failureReason: null });
    expect(storedV2Decision({ ...base, status: "failed" })).toBeNull();
  });
});
