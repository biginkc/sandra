import { describe, expect, it, vi } from "vitest";

import { withConvertedCallbackTime } from "./callback-wiring";
import type { CallbackTimeProvider } from "./callback-time";
import { mapBlandCallToOutcome } from "./outcome";
import { fakeClient } from "./test-helpers";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = Date.parse("2026-10-02T20:30:00Z"); // Friday 15:30 Chicago
const callWith = (variables: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  completed: true, status: "completed", answered_by: "human", summary: "s",
  variables: { call_outcome: "callback_requested - asked", ...variables }, ...extra,
});
const run = (
  call: ReturnType<typeof callWith>,
  opts: { state?: string | null; provider?: CallbackTimeProvider | null; timeoutMs?: number; nowMs?: number; client?: ReturnType<typeof fakeClient>["client"] } = {},
) => {
  const { client } = fakeClient({ properties: [{ id: "p1", state: opts.state === undefined ? "MO" : opts.state }] });
  return withConvertedCallbackTime(mapBlandCallToOutcome(call, NOW), {
    client: opts.client ?? client, propertyId: "p1", call, provider: opts.provider, nowMs: opts.nowMs ?? NOW, timeoutMs: opts.timeoutMs,
  });
};

describe("withConvertedCallbackTime", () => {
  it("sets the converted time and timezone, keeping the seller's raw words", async () => {
    const result = await run(callWith({ follow_up_preference: "Tuesday after 3, Central" }));
    expect(result.outcome).toBe("callback_requested");
    expect(result.payload).toMatchObject({
      callback_requested_for: "2026-10-06T20:00:00.000Z",
      callback_timezone: "America/Chicago",
      callback_raw: "Tuesday after 3, Central",
    });
  });

  it("uses the property state's timezone when the seller names none", async () => {
    const result = await run(callWith({ follow_up_preference: "Tuesday after 3" }), { state: "OH" });
    expect(result.payload).toMatchObject({ callback_requested_for: "2026-10-06T19:00:00.000Z", callback_timezone: "America/New_York" });
  });

  it("prefers an exact callback_time variable", async () => {
    const result = await run(callWith({ callback_time: "2026-10-08T16:00:00-05:00", follow_up_preference: "tomorrow" }));
    expect(result.payload.callback_requested_for).toBe("2026-10-08T21:00:00.000Z");
  });

  it("leaves the mapping untouched (due now) when nothing can be converted", async () => {
    const call = callWith({ follow_up_preference: "whenever" });
    const before = mapBlandCallToOutcome(call, NOW);
    expect(await run(call)).toEqual(before);
    expect(before.payload.callback_requested_for).toBeNull();
  });

  it("does nothing, and reads nothing, for non-callback outcomes", async () => {
    const select = vi.fn();
    const call = callWith({ call_outcome: "not_interested", follow_up_preference: "tomorrow" });
    const mapping = mapBlandCallToOutcome(call, NOW);
    const result = await withConvertedCallbackTime(mapping, {
      client: { from: select } as never, propertyId: "p1", call, nowMs: NOW,
    });
    expect(result).toBe(mapping);
    expect(select).not.toHaveBeenCalled();
  });

  it("dates relative words from the call's completion, not from when it is processed", async () => {
    // Call ended Friday 17:00 Chicago; processed Saturday 09:00 Chicago.
    const call = callWith({ follow_up_preference: "tomorrow at 2pm" }, { end_at: "2026-10-02T22:00:00Z" });
    const result = await run(call, { nowMs: Date.parse("2026-10-03T14:00:00Z") });
    expect(result.payload.callback_requested_for).toBe("2026-10-03T19:00:00.000Z"); // Saturday, not Sunday
  });

  it("ignores a completion time from the future", async () => {
    const call = callWith({ follow_up_preference: "tomorrow morning" }, { end_at: "2030-01-01T00:00:00Z" });
    expect((await run(call)).payload.callback_requested_for).toBe("2026-10-03T14:00:00.000Z");
  });

  it("never fails: an unreadable property or a throwing client leaves the raw words", async () => {
    const call = callWith({ follow_up_preference: "tomorrow morning" });
    const failing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }) };
    expect((await run(call, { client: failing as never })).payload.callback_requested_for).toBeNull();
    const throwing = { from: () => { throw new Error("boom"); } };
    expect((await run(call, { client: throwing as never })).payload.callback_requested_for).toBeNull();
  });

  it("gives up after the timeout when the AI step hangs", async () => {
    const hang: CallbackTimeProvider = () => new Promise(() => {});
    const started = Date.now();
    const result = await run(callWith({ follow_up_preference: "a week from Monday" }), { provider: hang, timeoutMs: 50 });
    expect(result.payload.callback_requested_for).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
