import { describe, expect, it } from "vitest";

import { buildQueuedCursorFilter } from "./queued-cursor";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const TS = "2026-06-12T18:00:00+00:00";

describe("buildQueuedCursorFilter — validation before raw .or() interpolation", () => {
  it("builds the exact PostgREST or-expression for a valid (timestamp, id) cursor", () => {
    const f = buildQueuedCursorFilter({ scheduledFor: TS, id: ID });
    expect(f).toEqual({
      kind: "or",
      expr:
        `scheduled_for.gt."${TS}",` +
        `and(scheduled_for.eq."${TS}",id.gt.${ID}),` +
        `scheduled_for.is.null`,
    });
  });

  it("accepts Z-suffixed and fractional-second timestamps", () => {
    expect(
      buildQueuedCursorFilter({
        scheduledFor: "2026-06-13T00:04:00.123456Z",
        id: ID,
      }).kind,
    ).toBe("or");
  });

  it("routes a null scheduledFor to the null-tail branch (no raw grammar)", () => {
    expect(buildQueuedCursorFilter({ scheduledFor: null, id: ID })).toEqual({
      kind: "nullTail",
      id: ID,
    });
  });

  it("rejects grammar injection via scheduledFor (the review finding's exact payload)", () => {
    const f = buildQueuedCursorFilter({
      scheduledFor: '2026-06-12T18:00:00+00:00",scheduled_for.is.null',
      id: ID,
    });
    expect(f.kind).toBe("invalid");
  });

  it("rejects grammar injection via id (the review finding's exact payload)", () => {
    const f = buildQueuedCursorFilter({
      scheduledFor: TS,
      id: `${ID}),scheduled_for.is.null`,
    });
    expect(f.kind).toBe("invalid");
  });

  it("rejects injection via id on the null-tail branch too", () => {
    const f = buildQueuedCursorFilter({
      scheduledFor: null,
      id: "x' OR 1=1",
    });
    expect(f.kind).toBe("invalid");
  });

  it("rejects non-string and malformed values", () => {
    expect(
      buildQueuedCursorFilter({ scheduledFor: TS, id: "not-a-uuid" }).kind,
    ).toBe("invalid");
    expect(
      buildQueuedCursorFilter({ scheduledFor: "June 12 2026", id: ID }).kind,
    ).toBe("invalid");
    expect(
      buildQueuedCursorFilter({
        scheduledFor: 12345 as unknown as string,
        id: ID,
      }).kind,
    ).toBe("invalid");
    expect(
      buildQueuedCursorFilter({
        scheduledFor: TS,
        id: undefined as unknown as string,
      }).kind,
    ).toBe("invalid");
  });
});
