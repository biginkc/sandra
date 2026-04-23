import { describe, expect, it } from "vitest";

import { delayToDate } from "./delays";

describe("delayToDate", () => {
  it("0 minutes returns the same instant (for immediate steps)", () => {
    const from = new Date("2026-04-23T18:00:00Z");
    expect(delayToDate(0, from).toISOString()).toBe(from.toISOString());
  });

  it("1440 (24h) returns +24 hours", () => {
    const from = new Date("2026-04-23T18:00:00Z");
    expect(delayToDate(1440, from).toISOString()).toBe(
      "2026-04-24T18:00:00.000Z",
    );
  });

  it("43200 returns +30 days", () => {
    const from = new Date("2026-04-23T18:00:00Z");
    expect(delayToDate(43200, from).toISOString()).toBe(
      "2026-05-23T18:00:00.000Z",
    );
  });

  it("129600 returns +90 days", () => {
    const from = new Date("2026-04-23T18:00:00Z");
    expect(delayToDate(129600, from).toISOString()).toBe(
      "2026-07-22T18:00:00.000Z",
    );
  });

  it("rejects a negative delay", () => {
    expect(() => delayToDate(-1, new Date())).toThrow(/non-negative/);
  });
});
