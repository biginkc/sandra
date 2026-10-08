import { describe, expect, it } from "vitest";

import { MAX_QUEUE_ATTEMPTS, nextAttemptSlot } from "./scheduler";
import { SCHEDULER_FIXTURES } from "./scheduler.fixtures";

// The oracle lives in scheduler.fixtures.ts (pure data, shared with the SQL suite).
describe("nextAttemptSlot", () => {
  it.each(SCHEDULER_FIXTURES.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    const result = nextAttemptSlot({ state: fixture.state, sends: fixture.sends.map((s) => new Date(s)), now: new Date(fixture.now) });
    const expected = fixture.expected;
    expect(result).toEqual(expected.kind === "slot" ? { ...expected, at: new Date(expected.at) } : expected);
  });

  it("has a fixture for every outcome kind", () => {
    const kinds = new Set(SCHEDULER_FIXTURES.map((f) => f.expected.kind));
    expect([...kinds].sort()).toEqual(["exhausted", "slot", "unknown_state"]);
  });

  it("caps total attempts at 24", () => {
    expect(MAX_QUEUE_ATTEMPTS).toBe(24);
  });
});
