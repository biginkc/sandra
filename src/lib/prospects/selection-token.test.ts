import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SELECTION_TOKEN_LENGTH,
  isSelectionTokenShape,
  mintSelectionToken,
  readSelectionToken,
} from "./selection-token";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bigFilters = () => ({
  search: "x".repeat(200),
  blockStack: Array.from({ length: 23 }, (_, i) => ({
    id: uuid(i), kind: "tag", combinator: "any", values: [uuid(100 + i), uuid(200 + i), uuid(300 + i), uuid(400 + i), uuid(500 + i)],
  })),
  imported: "today",
});

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-secret";
});

describe("selection token", () => {
  it("round-trips realistic filters (long search, 23 blocks x 5 uuids) well past 200 characters", () => {
    const filters = bigFilters();
    const token = mintSelectionToken({ userId: "u1", filters });
    expect(token.length).toBeGreaterThan(214);
    expect(isSelectionTokenShape(token)).toBe(true);
    expect(readSelectionToken(token, "u1")).toEqual({ ok: true, filters });
  });

  it("a small token is also accepted by the shape check", () => {
    const token = mintSelectionToken({ userId: "u1", filters: { search: "a", blockStack: [] } });
    expect(token.length).toBeGreaterThan(100);
    expect(isSelectionTokenShape(token)).toBe(true);
  });

  it("rejects bad shapes, over-long tokens, another user, an expired token and tampering", () => {
    const token = mintSelectionToken({ userId: "u1", filters: { search: null, blockStack: [] }, now: 1_000 });
    expect(readSelectionToken(token, "u2", 2_000)).toEqual({ ok: false });
    expect(readSelectionToken(token, "u1", 1_000 + 11 * 60 * 1000)).toEqual({ ok: false });
    const [payload, sig] = token.split(".");
    expect(readSelectionToken(`${payload}.${sig.slice(0, -2)}xx`, "u1", 2_000)).toEqual({ ok: false });
    for (const bad of ["", "nodot", "a.b.c", "has space.sig", "é.é", "x".repeat(MAX_SELECTION_TOKEN_LENGTH + 1)]) {
      expect(isSelectionTokenShape(bad), bad.slice(0, 20)).toBe(false);
    }
  });

  it("refuses to mint a token larger than the bound", () => {
    expect(() => mintSelectionToken({ userId: "u1", filters: { huge: "y".repeat(MAX_SELECTION_TOKEN_LENGTH) } })).toThrow(/too large/);
  });
});
