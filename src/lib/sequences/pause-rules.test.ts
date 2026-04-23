import { describe, expect, it } from "vitest";

import { evaluatePause } from "./pause-rules";

describe("evaluatePause", () => {
  it("inbound reply pauses with reason 'inbound_reply' (resumable)", () => {
    expect(evaluatePause({ type: "inbound_reply" })).toEqual({
      shouldPause: true,
      reason: "inbound_reply",
      permanent: false,
    });
  });

  it("status change to 'dead' pauses permanently with 'status_terminal'", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "dead" }),
    ).toEqual({
      shouldPause: true,
      reason: "status_terminal",
      permanent: true,
    });
  });

  it("status change to 'closed' pauses permanently with 'status_terminal'", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "closed" }),
    ).toEqual({
      shouldPause: true,
      reason: "status_terminal",
      permanent: true,
    });
  });

  it("status change to 'offer_sent' pauses with 'status_acquisition_active' (resumable)", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "offer_sent" }),
    ).toEqual({
      shouldPause: true,
      reason: "status_acquisition_active",
      permanent: false,
    });
  });

  it("status change to 'under_contract' pauses with 'status_acquisition_active' (resumable)", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "under_contract" }),
    ).toEqual({
      shouldPause: true,
      reason: "status_acquisition_active",
      permanent: false,
    });
  });

  it("status change to a neutral status (e.g. 'contacted') does NOT pause", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "contacted" }),
    ).toEqual({
      shouldPause: false,
      reason: null,
      permanent: false,
    });
  });

  it("status change to 'new_lead' does NOT pause (initial qualification)", () => {
    expect(
      evaluatePause({ type: "status_change", newStatus: "new_lead" }),
    ).toEqual({
      shouldPause: false,
      reason: null,
      permanent: false,
    });
  });

  it("consent_revoked pauses permanently with 'consent_revoked'", () => {
    expect(evaluatePause({ type: "consent_revoked" })).toEqual({
      shouldPause: true,
      reason: "consent_revoked",
      permanent: true,
    });
  });
});
