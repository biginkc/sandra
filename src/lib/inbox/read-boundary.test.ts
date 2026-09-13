import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReadBoundaryCodec, InvalidReadBoundaryError, type ReadBoundaryConfiguration } from "./read-boundary";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { requesterId: id(1), organizationId: id(2), conversationId: id(3), captureGeneration: id(4) };
const snapshot = { ...context, boundaryId: id(5), snapshotId: id(6), headRevision: "9007199254740993" };
// Synthetic deterministic test keys only, never application defaults.
const oldKey = Buffer.alloc(32, 1);
const newKey = Buffer.alloc(32, 2);
const config = (overrides: Partial<ReadBoundaryConfiguration> = {}): ReadBoundaryConfiguration => ({ currentKid: "old", keys: new Map([["old", oldKey]]), ttlSeconds: 300, maxTtlSeconds: 300, ...overrides });
const codec = createReadBoundaryCodec(config());
const unsigned = () => JSON.parse(Buffer.from(codec.issue(snapshot, 1000).split(".")[0], "base64url").toString());
function sign(value: unknown, domain = "sandra:inbox:read-boundary:v1\0", raw?: string) {
  const payload = Buffer.from(raw ?? JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", oldKey).update(domain).update(payload).digest("base64url")}`;
}

describe("Inbox read boundary integrity", () => {
  it.each(["0", "9007199254740993", "9223372036854775807"])("preserves exact revision %s", (headRevision) => {
    const token = codec.issue({ ...snapshot, headRevision }, 1000);
    const value = codec.verify(token, context, 1001);
    expect(value.headRevision).toBe(headRevision);
    expect(value.expiresAt).toBe(1300);
    expect(Object.isFrozen(value)).toBe(true);
    expect(codec.verify(token, context, 1002)).toEqual(value); // Integrity is not one-use.
  });
  it.each(["-1", "+1", "01", "1e3", " 1", "1.0", "9223372036854775808", "", 9007199254740992])("rejects invalid revision %s even when signed", (headRevision) => {
    expect(() => codec.verify(sign({ ...unsigned(), headRevision }), context, 1001)).toThrow(InvalidReadBoundaryError);
    expect(() => codec.issue({ ...snapshot, headRevision } as typeof snapshot, 1000)).toThrow();
  });
  it.each(Object.keys(context))("binds expected %s", (field) => {
    expect(() => codec.verify(codec.issue(snapshot, 1000), { ...context, [field]: id(99) }, 1001)).toThrow(InvalidReadBoundaryError);
  });
  it("rejects modified payload, signature and another signing domain", () => {
    const token = codec.issue(snapshot, 1000);
    const [payload, signature] = token.split(".");
    const changed = Buffer.from(JSON.stringify({ ...unsigned(), headRevision: "99" })).toString("base64url");
    expect(() => codec.verify(`${changed}.${signature}`, context, 1001)).toThrow();
    expect(() => codec.verify(`${payload}.${Buffer.alloc(32).toString("base64url")}`, context, 1001)).toThrow();
    expect(() => codec.verify(sign(unsigned(), "sandra:other-purpose:v1\0"), context, 1001)).toThrow();
  });
  it("rotates issuance while accepting retained previous keys; rejects removed/unknown keys", () => {
    const token = codec.issue(snapshot, 1000);
    const rotated = createReadBoundaryCodec(config({ currentKid: "new", keys: new Map([["old", oldKey], ["new", newKey]]) }));
    expect(rotated.verify(token, context, 1001).kid).toBe("old");
    expect(rotated.verify(rotated.issue(snapshot, 1001), context, 1002).kid).toBe("new");
    expect(() => createReadBoundaryCodec(config({ currentKid: "new", keys: new Map([["new", newKey]]) })).verify(token, context, 1001)).toThrow();
    expect(() => codec.verify(sign({ ...unsigned(), kid: "unknown" }), context, 1001)).toThrow();
  });
  it("copies injected keys so caller mutation cannot alter active signing keys", () => {
    const key = Buffer.from(oldKey); const keys = new Map([["old", key]]);
    const instance = createReadBoundaryCodec(config({ keys }));
    key.fill(0); keys.clear();
    expect(codec.verify(instance.issue(snapshot, 1000), context, 1001).kid).toBe("old");
  });
  it.each([
    { issuedAt: 1002 }, { expiresAt: 1001 }, { expiresAt: 1000 },
    { expiresAt: 1301 }, { issuedAt: -1 }, { issuedAt: 1000.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: "1300" },
  ])("rejects invalid signed lifetime %j", (change) => {
    expect(() => codec.verify(sign({ ...unsigned(), ...change }), context, 1001)).toThrow();
  });
  it("accepts until expiry exclusively and rejects future issuance without clock skew", () => {
    const token = codec.issue(snapshot, 1000);
    expect(codec.verify(token, context, 1299).issuedAt).toBe(1000);
    expect(() => codec.verify(token, context, 1300)).toThrow();
    expect(() => codec.verify(token, context, 999)).toThrow();
  });
  it("rejects noncanonical encodings, JSON fields and duplicate keys", () => {
    const token = codec.issue(snapshot, 1000); const [payload, signature] = token.split(".");
    const value = unsigned(); const missing = { ...value }; delete missing.snapshotId;
    const bad = [token + ".extra", `${payload}=.${signature}`, `${payload}.${signature}=`, `${payload}.AA`, "x".repeat(2049), sign({ ...value, extra: true }), sign(missing), sign({ ...value, version: 2 }), sign(value, undefined, JSON.stringify(value, null, 2)), sign(value, undefined, JSON.stringify(value).replace('"version":1', '"version":1,"version":1')), sign([]), sign(null), sign(value, undefined, "not json")];
    for (const candidate of bad) expect(() => codec.verify(candidate, context, 1001)).toThrow(InvalidReadBoundaryError);
  });
  it("rejects malformed identifiers, missing expected scope and unexpected issuance fields", () => {
    expect(() => codec.verify(sign({ ...unsigned(), snapshotId: "not-an-id" }), context, 1001)).toThrow();
    expect(() => codec.verify(codec.issue(snapshot, 1000), {} as typeof context, 1001)).toThrow();
    expect(() => codec.issue({ ...snapshot, extra: true } as typeof snapshot, 1000)).toThrow();
    expect(() => codec.issue(snapshot, Number.MAX_SAFE_INTEGER)).toThrow();
  });
  it.each([undefined, 123, { toString: () => "old" }])("rejects runtime non-string key IDs %s without regex coercion", (invalidKid) => {
    expect(() => createReadBoundaryCodec(config({
      currentKid: invalidKid as unknown as string,
      keys: new Map([[invalidKid as unknown as string, oldKey]]),
    }))).toThrow(InvalidReadBoundaryError);
    expect(() => createReadBoundaryCodec(config({
      keys: new Map([["old", oldKey], [invalidKid as unknown as string, newKey]]),
    }))).toThrow(InvalidReadBoundaryError);
  });
  it("requires explicit bounded lifetime and adequate configured keys", () => {
    for (const overrides of [ { ttlSeconds: 0 }, { ttlSeconds: 301 }, { maxTtlSeconds: 301 }, { maxTtlSeconds: 0 }, { ttlSeconds: 1.5 }, { keys: new Map([["old", Buffer.alloc(31)]]) }, { keys: new Map() }, { currentKid: "absent" } ]) {
      expect(() => createReadBoundaryCodec(config(overrides))).toThrow();
    }
    const short = createReadBoundaryCodec(config({ ttlSeconds: 10, maxTtlSeconds: 20 }));
    expect(short.verify(short.issue(snapshot, 1000), context, 1001).expiresAt).toBe(1010);
    expect(() => short.verify(codec.issue(snapshot, 1000), context, 1001)).toThrow();
  });
});
