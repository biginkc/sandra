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

  it("a payload edited to another user/expiry but carrying the ORIGINAL signature is rejected", () => {
    const token = mintSelectionToken({ userId: "u1", filters: { search: "a", blockStack: [] }, now: 1_000 });
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forgedUser = Buffer.from(JSON.stringify({ ...decoded, u: "attacker" })).toString("base64url");
    const forgedExpiry = Buffer.from(JSON.stringify({ ...decoded, e: decoded.e + 10 ** 12 })).toString("base64url");
    const forgedFilters = Buffer.from(JSON.stringify({ ...decoded, f: { search: "everything", blockStack: [] } })).toString("base64url");
    for (const forged of [forgedUser, forgedExpiry, forgedFilters]) {
      expect(readSelectionToken(`${forged}.${sig}`, "attacker", 2_000)).toEqual({ ok: false });
      expect(readSelectionToken(`${forged}.${sig}`, "u1", 2_000)).toEqual({ ok: false });
    }
    expect(readSelectionToken(token, "u1", 2_000)).toMatchObject({ ok: true });
  });

  it("readSelectionToken itself enforces the length bound (not only the shape helper)", () => {
    const over = `${"a".repeat(MAX_SELECTION_TOKEN_LENGTH - 1)}.b`;
    expect(over.length).toBe(MAX_SELECTION_TOKEN_LENGTH + 1);
    expect(readSelectionToken(over, "u1")).toEqual({ ok: false });
  });

  it("the exact boundary: a token of exactly 32,768 characters is minted, shaped and read; one more is refused", () => {
    // payload chars = MAX - 1 (dot) - 43 (sha256 base64url) = 32,724 = 4 * 8,181 => 24,543 payload bytes.
    const bytesFor = (pad: number) => Buffer.byteLength(JSON.stringify({ u: "u1", f: { pad: "x".repeat(pad) }, e: Date.now() + 600_000 }));
    let pad = 0;
    while (bytesFor(pad) < 24_543) pad += 1;
    expect(bytesFor(pad)).toBe(24_543);
    const token = mintSelectionToken({ userId: "u1", filters: { pad: "x".repeat(pad) } });
    expect(token.length).toBe(MAX_SELECTION_TOKEN_LENGTH);
    expect(isSelectionTokenShape(token)).toBe(true);
    expect(readSelectionToken(token, "u1")).toMatchObject({ ok: true });
    expect(() => mintSelectionToken({ userId: "u1", filters: { pad: "x".repeat(pad + 3) } })).toThrow(/too large/);
    expect(isSelectionTokenShape(`${token}a`)).toBe(false);
  });
});
