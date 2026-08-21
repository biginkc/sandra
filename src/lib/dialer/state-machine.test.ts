import { describe, expect, it } from "vitest";

import { transitionSoftphoneState } from "./state-machine";

describe("softphone state machine", () => {
  it("allows only idle to close and keeps live calls mounted", () => {
    expect(transitionSoftphoneState("closed", { type: "open" })).toBe("idle");
    expect(transitionSoftphoneState("idle", { type: "close" })).toBe("closed");
    expect(transitionSoftphoneState("live", { type: "close" })).toBe("live");
    expect(transitionSoftphoneState("wrap", { type: "close" })).toBe("wrap");
  });

  it("models live, held, wrap-up, and completion", () => {
    let state = transitionSoftphoneState("idle", { type: "call_live" });
    state = transitionSoftphoneState(state, { type: "hold" });
    expect(state).toBe("held");
    state = transitionSoftphoneState(state, { type: "resume" });
    state = transitionSoftphoneState(state, { type: "hangup" });
    expect(state).toBe("wrap");
    expect(transitionSoftphoneState(state, { type: "wrap_complete" })).toBe("closed");
  });
});
