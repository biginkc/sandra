import { describe, expect, it } from "vitest";

import { computeReplyDelaySeconds } from "./delay";

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
        random: () => 0,
      }),
    ).toBe(45);

    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 160,
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
        random: () => 0.5,
      }),
    ).toBe(99);
  });

  it("adds a monotonic length bonus", () => {
    const short = computeReplyDelaySeconds({
      minSeconds: 45,
      maxSeconds: 180,
      inboundLength: 0,
      random: () => 0.25,
    });
    const long = computeReplyDelaySeconds({
      minSeconds: 45,
      maxSeconds: 180,
      inboundLength: 160,
      random: () => 0.25,
    });

    expect(long).toBeGreaterThan(short);
  });

  it("clamps near quiet-hours window close with a 60-second buffer", () => {
    expect(
      computeReplyDelaySeconds({
        minSeconds: 45,
        maxSeconds: 180,
        inboundLength: 0,
        propertyState: "MO",
        now: new Date("2026-07-02T01:58:30.000Z"),
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
