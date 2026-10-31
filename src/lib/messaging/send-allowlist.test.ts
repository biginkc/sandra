import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { assertSendAllowed, checkSendAllowed, decideSendAllowed, normalizeDestination, parseTestDestAllowlist, REFUSED_NON_OWNED } from "./send-allowlist";

// Fictional 555 numbers only; real owned numbers are never committed.
const OWNED = "+18165550142";
const ALLOW = parseTestDestAllowlist(`${OWNED}, +19135550177`);

describe("§5.4 send allowlist (pure)", () => {
  it.each(["(816) 555-0142", "816-555-0142", "+1 816 555 0142", "8165550142", "1.816.555.0142", "+18165550142"])(
    "formatting variant of an owned number is allowed: %s", (v) => {
      expect(decideSendAllowed({ testRunId: "run-1", destination: v, allowlist: ALLOW })).toEqual({ allowed: true, tested: true });
    });
  it("a test-tagged send to a non-owned number is refused", () => {
    expect(decideSendAllowed({ testRunId: "run-1", destination: "+18165550191", allowlist: ALLOW })).toEqual({ allowed: false, reason: REFUSED_NON_OWNED });
  });
  it("a lookalike differing by one digit is refused", () => {
    expect(decideSendAllowed({ testRunId: "run-1", destination: "+18165550143", allowlist: ALLOW })).toMatchObject({ allowed: false });
  });
  it.each(["", "abc", "55512", "+44 20 7946 0958", "816555014", "+1816555014x2", "816-555-0142 ext 2"])("unparseable / short code / foreign is refused when tagged: %j", (v) => {
    expect(decideSendAllowed({ testRunId: "run-1", destination: v, allowlist: ALLOW })).toMatchObject({ allowed: false });
  });
  it("a tagged send with no allowlist configured is refused", () => {
    expect(decideSendAllowed({ testRunId: "run-1", destination: OWNED, allowlist: parseTestDestAllowlist(undefined) })).toMatchObject({ allowed: false });
  });
  it("no test tag: unchanged (allowed, whatever the number)", () => {
    for (const t of [null, undefined, "", "   "]) {
      expect(decideSendAllowed({ testRunId: t, destination: "+18165550191", allowlist: new Set() })).toEqual({ allowed: true, tested: false });
    }
  });
  it("invalid allowlist entries never widen it", () => {
    expect([...parseTestDestAllowlist("not-a-number, 555, +18165550142")]).toEqual([OWNED]);
    expect([...parseTestDestAllowlist("(816) 555-0142;\n+1 913 555 0177")]).toEqual([OWNED, "+19135550177"]);
    expect(normalizeDestination("+1 (816) 555-0142")).toBe(OWNED);
  });
});

function fakeDb(lead: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    from: (t: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: lead.data ?? null, error: lead.error ?? null }) }) }),
      insert: async (row: Record<string, unknown>) => { inserts.push({ table: t, ...row }); return { error: null }; },
    }),
  };
  return { db: db as never, inserts };
}
const env = { TEST_DEST_ALLOWLIST: OWNED };
const base = { orgId: "o", propertyId: "p", origin: "automated", messageId: "m", env };

describe("§5.4 assertSendAllowed (boundary)", () => {
  it("a test-tagged lead to a non-owned number: refused and recorded with the last 4 digits only", async () => {
    const { db, inserts } = fakeDb({ data: { test_run_id: "run-1" } });
    expect(await assertSendAllowed(db, { ...base, destination: "+18165550191" })).toBe(false);
    expect(inserts).toEqual([expect.objectContaining({ table: "test_send_refusals", test_run_id: "run-1", destination_last4: "0191", reason: "refused_non_owned" })]);
    expect(JSON.stringify(inserts)).not.toContain("8165550191");
  });
  it("a derived work item whose own tag was lost: the lead's tag still refuses it (taint)", async () => {
    const { db } = fakeDb({ data: { test_run_id: "run-1" } });
    expect(await assertSendAllowed(db, { ...base, destination: "+18165550191", testRunId: null })).toBe(false);
  });
  it("a tagged work item on an untagged lead is still held to the allowlist", async () => {
    const { db } = fakeDb({ data: { test_run_id: null } });
    expect(await assertSendAllowed(db, { ...base, destination: "+18165550191", testRunId: "run-1" })).toBe(false);
    expect(await assertSendAllowed(db, { ...base, destination: "(816) 555-0142", testRunId: "run-1" })).toBe(true);
  });
  it("production (no tag anywhere): allowed, nothing recorded", async () => {
    const { db, inserts } = fakeDb({ data: { test_run_id: null } });
    expect(await assertSendAllowed(db, { ...base, destination: "+18165550191", env: {} })).toBe(true);
    expect(inserts).toEqual([]);
  });
  it("database without the column yet: untagged", async () => {
    expect(await assertSendAllowed(fakeDb({ error: { code: "42703", message: "column properties.test_run_id does not exist" } }).db, { ...base, destination: "+18165550191" })).toBe(true);
  });
  it("a taint lookup failure fails closed even with no test run active (production too); retryable, no refusal row", async () => {
    const timeout = () => fakeDb({ error: { message: "timeout" } });
    const prod = timeout();
    expect(await checkSendAllowed(prod.db, { ...base, destination: "+18165550191", env: {} })).toEqual({ allowed: false, why: "taint_lookup_failed" });
    expect(prod.inserts).toEqual([]);
    expect(await assertSendAllowed(timeout().db, { ...base, destination: OWNED })).toBe(false);
  });
  it("a taint lookup failure on a tagged work item: the item's own tag decides (owned allowed, other refused + recorded)", async () => {
    expect(await checkSendAllowed(fakeDb({ error: { message: "timeout" } }).db, { ...base, destination: OWNED, testRunId: "run-1" })).toEqual({ allowed: true });
    const other = fakeDb({ error: { message: "timeout" } });
    expect(await checkSendAllowed(other.db, { ...base, destination: "+18165550191", testRunId: "run-1" })).toEqual({ allowed: false, why: REFUSED_NON_OWNED });
    expect(other.inserts).toEqual([expect.objectContaining({ table: "test_send_refusals", test_run_id: "run-1", destination_last4: "0191" })]);
  });
  it("checkSendAllowed names a confirmed refusal refused_non_owned (the terminal kind)", async () => {
    expect(await checkSendAllowed(fakeDb({ data: { test_run_id: "run-1" } }).db, { ...base, destination: "+18165550191" })).toEqual({ allowed: false, why: REFUSED_NON_OWNED });
  });
});

describe("§5.4 shadow has no send capability", () => {
  it("the shadow module imports no provider, send, outbox, enrollment or suppression writer", () => {
    const src = readFileSync(path.join(__dirname, "../sms-classification/routing-v2/shadow.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const forbidden of [/messaging\/send/, /messaging\/providers/, /outbox/, /sequences\/enrollment/, /suppression/, /ai-responder\/dispatch/]) {
      expect(imports.filter((i) => forbidden.test(i!)), String(forbidden)).toEqual([]);
    }
  });
});
