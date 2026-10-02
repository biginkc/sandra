import { describe, expect, it, vi } from "vitest";

import { callEndedAtMs, withConvertedCallbackTime } from "./callback-wiring";
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

  describe("the call's end time (reference for relative words)", () => {
    // Call 17:00 Chicago Friday 2026-10-02; processed Saturday 09:00 Chicago. "tomorrow at 2pm" from the
    // Friday call is Saturday 14:00 (19:00Z); from Saturday processing time it would be Sunday.
    const LATE = Date.parse("2026-10-03T14:00:00Z");
    const SATURDAY_2PM = "2026-10-03T19:00:00.000Z";
    const tomorrow = (extra: Record<string, unknown>) => callWith({ follow_up_preference: "tomorrow at 2pm" }, extra);

    it("started_at + corrected_duration (seconds) is the end", async () => {
      const call = tomorrow({ started_at: "2026-10-02T21:50:00Z", corrected_duration: 540 }); // ends 21:59Z Friday
      expect((await run(call, { nowMs: LATE })).payload.callback_requested_for).toBe(SATURDAY_2PM);
    });

    it("corrected_duration wins over call_length when both are present and valid", async () => {
      const call = tomorrow({ started_at: "2026-10-02T21:50:00Z", corrected_duration: 540, call_length: 30000 });
      expect((await run(call, { nowMs: LATE })).payload.callback_requested_for).toBe(SATURDAY_2PM);
      expect(callEndedAtMs(call, LATE)).toBe(Date.parse("2026-10-02T21:59:00Z"));
    });

    it("falls back to started_at + call_length (minutes x 60)", async () => {
      const call = tomorrow({ started_at: "2026-10-02T21:50:00Z", call_length: 9 });
      expect(callEndedAtMs(call, LATE)).toBe(Date.parse("2026-10-02T21:59:00Z"));
      expect((await run(call, { nowMs: LATE })).payload.callback_requested_for).toBe(SATURDAY_2PM);
    });

    it("an invalid corrected_duration falls through to call_length", () => {
      for (const bad of [0, -5, "abc", null, Number.NaN, ""]) {
        const call = tomorrow({ started_at: "2026-10-02T21:50:00Z", corrected_duration: bad, call_length: 9 });
        expect(callEndedAtMs(call, LATE)).toBe(Date.parse("2026-10-02T21:59:00Z"));
      }
      // Numeric strings are what Bland sometimes sends.
      expect(callEndedAtMs(tomorrow({ started_at: "2026-10-02T21:50:00Z", corrected_duration: "540" }), LATE)).toBe(Date.parse("2026-10-02T21:59:00Z"));
    });

    it("a started_at older than 7 days is ignored (falls through to now); just inside 7 days still counts", () => {
      const stale = tomorrow({ started_at: "2026-09-20T21:50:00Z", corrected_duration: 540 });
      expect(callEndedAtMs(stale, LATE)).toBe(LATE);
      const justInside = new Date(LATE - 7 * 24 * 60 * 60_000 + 60_000).toISOString();
      expect(callEndedAtMs(tomorrow({ started_at: justInside, corrected_duration: 540 }), LATE)).toBe(Date.parse(justInside) + 540_000);
    });

    it("missing or malformed inputs mean now", () => {
      expect(callEndedAtMs(tomorrow({}), LATE)).toBe(LATE);
      expect(callEndedAtMs(tomorrow({ started_at: "2026-10-02T21:50:00Z" }), LATE)).toBe(LATE);
      expect(callEndedAtMs(tomorrow({ corrected_duration: 540 }), LATE)).toBe(LATE);
      expect(callEndedAtMs(tomorrow({ started_at: "not a date", corrected_duration: 540, call_length: 9 }), LATE)).toBe(LATE);
      expect(callEndedAtMs(tomorrow({ started_at: "2026-10-02T21:50:00Z", corrected_duration: 0, call_length: "x" }), LATE)).toBe(LATE);
    });

    it("an end in the future is not trusted", () => {
      expect(callEndedAtMs(tomorrow({ started_at: "2030-01-01T00:00:00Z", corrected_duration: 60 }), LATE)).toBe(LATE);
      expect(callEndedAtMs(tomorrow({ started_at: "2026-10-03T13:59:00Z", corrected_duration: 3600 }), LATE)).toBe(LATE);
      // An absurd duration (over a day) is dropped, not added.
      expect(callEndedAtMs(tomorrow({ started_at: "2026-10-01T00:00:00Z", corrected_duration: 999_999 }), LATE)).toBe(LATE);
    });

    it("end_at is NOT used (it is the max-duration cutoff, not the real end)", async () => {
      const call = tomorrow({ end_at: "2026-10-02T22:00:00Z" });
      expect(callEndedAtMs(call, LATE)).toBe(LATE);
      expect((await run(call, { nowMs: LATE })).payload.callback_requested_for).toBe("2026-10-04T19:00:00.000Z"); // from "now" (Saturday): Sunday
    });
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
