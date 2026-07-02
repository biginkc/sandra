import { describe, expect, it } from "vitest";

import { computeReplyDelaySeconds } from "./delay";

const IN_WINDOW_MO = new Date("2026-07-01T18:00:00.000Z");

describe("computeReplyDelaySeconds", () => {
  it("returns 0 when max is 0", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 0,
        inboundLength: 80,
        random: () => 1,
      }),
    ).toBe(0);
  });

  it("stays inside the configured bounds", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 0,
        propertyState: "MO",
        now: IN_WINDOW_MO,
        random: () => 0,
      }),
    ).toBe(45);

    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 160,
        propertyState: "MO",
        now: IN_WINDOW_MO,
        random: () => 1,
      }),
    ).toBe(180);
  });

  it("is deterministic when an RNG is injected", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 0,
        propertyState: "MO",
        now: IN_WINDOW_MO,
        random: () => 0.5,
      }),
    ).toBe(99);
  });

  it("adds a monotonic length bonus", () => {
    const short = computeReplyDelaySeconds({
      minSeconds: 45,
      maxSeconds: 180,
      inboundLength: 0,
      propertyState: "MO",
      now: IN_WINDOW_MO,
      random: () => 0.25,
    });
    const long = computeReplyDelaySeconds({
      minSeconds: 45,
      maxSeconds: 180,
      inboundLength: 160,
      propertyState: "MO",
      now: IN_WINDOW_MO,
      random: () => 0.25,
    });

    expect(long).toBeGreaterThan(short);
  });

  it("returns 0 when the property state is missing", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 160,
        propertyState: null,
        now: IN_WINDOW_MO,
        random: () => 1,
      }),
    ).toBe(0);
  });

  it("clamps near quiet-hours window close with a 120-second buffer", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 0,
        propertyState: "MO",
        now: new Date("2026-07-02T01:57:30.000Z"),
        random: () => 1,
      }),
    ).toBe(30);
  });

  it("returns 0 outside the local send window", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 160,
        propertyState: "MO",
        now: new Date("2026-07-02T03:00:00.000Z"),
        random: () => 1,
      }),
    ).toBe(0);
  });
});
