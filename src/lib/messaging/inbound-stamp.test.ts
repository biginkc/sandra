import { describe, expect, it, vi } from "vitest";

import { latestInboundMessageId, normalizeInboundMessageId, resolveInboundStamp } from "./inbound-stamp";

const ID = "33333333-3333-4333-8333-333333333333";
const scope = { orgId: "org-1", propertyId: "prop-1" };

function client(result: { data: unknown; error?: unknown } | Error) {
  const maybeSingle = vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve({ error: null, ...result })));
  return { from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })), maybeSingle };
}
const row = (over: Record<string, unknown> = {}) => ({
  direction: "inbound", org_id: "org-1", property_id: "prop-1", ...over,
});

describe("normalizeInboundMessageId", () => {
  it("accepts a uuid and rejects junk", () => {
    expect(normalizeInboundMessageId(` ${ID} `)).toBe(ID);
    expect(normalizeInboundMessageId("nope")).toBeNull();
    expect(normalizeInboundMessageId(42)).toBeNull();
  });
});

describe("resolveInboundStamp", () => {
  it("returns the id for an inbound message on the same org and property", async () => {
    expect(await resolveInboundStamp(client({ data: row() }), ID, scope)).toBe(ID);
  });
  it("drops outbound, cross-org, cross-property, missing and errored lookups", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const c of [
      client({ data: row({ direction: "outbound" }) }),
      client({ data: row({ org_id: "org-2" }) }),
      client({ data: row({ property_id: "prop-2" }) }),
      client({ data: null }),
      client({ data: row(), error: { message: "boom" } }),
      client(new Error("network")),
    ]) {
      expect(await resolveInboundStamp(c, ID, scope)).toBeNull();
    }
    warn.mockRestore();
  });
  it("skips the lookup entirely when absent or malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = client({ data: row() });
    expect(await resolveInboundStamp(c, undefined, scope)).toBeNull();
    expect(await resolveInboundStamp(c, null, scope)).toBeNull();
    expect(await resolveInboundStamp(c, "not-a-uuid", scope)).toBeNull();
    expect(c.from).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("latestInboundMessageId", () => {
  it("picks the newest inbound by created_at, not by id order", () => {
    expect(
      latestInboundMessageId([
        { id: "zzz", direction: "inbound", created_at: "2026-10-14T10:00:00Z" },
        { id: "aaa", direction: "inbound", created_at: "2026-10-14T11:00:00Z" },
        { id: "mmm", direction: "outbound", created_at: "2026-10-14T12:00:00Z" },
      ]),
    ).toBe("aaa");
  });
  it("breaks identical timestamps by (created_at, id) regardless of input order", () => {
    const a = { id: "aaa", direction: "inbound", created_at: "2026-10-14T10:00:00Z" };
    const b = { id: "bbb", direction: "inbound", created_at: "2026-10-14T10:00:00Z" };
    expect(latestInboundMessageId([a, b])).toBe("bbb");
    expect(latestInboundMessageId([b, a])).toBe("bbb");
  });
  it("ignores non-sms channels and returns null when none", () => {
    expect(latestInboundMessageId([{ id: "c", direction: "inbound", channel: "call", created_at: "2026-10-14T10:00:00Z" }])).toBeNull();
    expect(latestInboundMessageId([])).toBeNull();
  });
});
