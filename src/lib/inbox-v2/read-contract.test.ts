import { describe, expect, it } from "vitest";
import { encodeHistoryCursor, MAX_HISTORY_CURSOR_LENGTH, validateInboxReadRequest } from "./read-contract";

const conversationId = "123e4567-e89b-12d3-a456-426614174000";
const id = "123e4567-e89b-12d3-a456-426614174001";
const createdAt = "2026-09-13T10:11:12.123456+00:00";
const pack = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("Inbox candidate-neutral read boundary", () => {
  it("defaults to a bounded first page and normalizes canonical UUIDs", () => {
    expect(validateInboxReadRequest({ conversationId: conversationId.toUpperCase() })).toEqual({
      ok: true, value: { conversationId, pageSize: 50, before: null },
    });
    expect(validateInboxReadRequest({ conversationId, pageSize: 100 }).ok).toBe(true);
  });

  it.each([0, -1, 101, 1.5, Infinity, NaN, "50", null])("rejects invalid page size %s", pageSize => {
    expect(validateInboxReadRequest({ conversationId, pageSize })).toEqual({ ok: false, error: "INVALID_PAGE_SIZE" });
  });

  it("rejects caller-supplied tenant authority and legacy thread identities", () => {
    expect(validateInboxReadRequest({ conversationId, orgId: id })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(validateInboxReadRequest({ conversationId: `${conversationId}:${id}` })).toEqual({ ok: false, error: "INVALID_CONVERSATION_ID" });
    expect(validateInboxReadRequest(null)).toEqual({ ok: false, error: "INVALID_REQUEST" });
  });

  it("retains microsecond precision and the tie-breaker ID across opaque transport", () => {
    const cursor = encodeHistoryCursor(conversationId, { createdAt, id });
    expect(validateInboxReadRequest({ conversationId, cursor })).toEqual({
      ok: true, value: { conversationId, pageSize: 50, before: { createdAt, id } },
    });
    expect(encodeHistoryCursor(conversationId, { createdAt, id: conversationId })).not.toBe(cursor);
    expect(validateInboxReadRequest({ conversationId: id, cursor })).toEqual({ ok: false, error: "CURSOR_CONVERSATION_MISMATCH" });
  });

  it("rejects oversized cursors before decoding and malformed transport", () => {
    expect(validateInboxReadRequest({ conversationId, cursor: "x".repeat(MAX_HISTORY_CURSOR_LENGTH + 1) })).toEqual({ ok: false, error: "CURSOR_TOO_LARGE" });
    for (const cursor of ["", "!", "a", "e30", {}, 5]) {
      expect(validateInboxReadRequest({ conversationId, cursor })).toEqual({ ok: false, error: "INVALID_CURSOR" });
    }
  });

  it.each(["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-13T24:00:00Z",
    "2026-09-13T00:00:60Z", "2026-09-13T00:00:00+14:01", "2026-09-13T00:00:00Z),id.gt.x"])("rejects invalid timestamp %s", badTime => {
    expect(validateInboxReadRequest({ conversationId, cursor: pack({ v: 1, conversationId, createdAt: badTime, id }) })).toEqual({ ok: false, error: "INVALID_CURSOR" });
  });

  it("accepts leap-day timestamps but rejects unknown cursor versions and injected IDs", () => {
    expect(validateInboxReadRequest({ conversationId, cursor: encodeHistoryCursor(conversationId, { createdAt: "2024-02-29T00:00:00Z", id }) }).ok).toBe(true);
    for (const payload of [{ v: 2, conversationId, createdAt, id }, { v: 1, conversationId, createdAt, id: `${id}),id.gt.x` }]) {
      expect(validateInboxReadRequest({ conversationId, cursor: pack(payload) })).toEqual({ ok: false, error: "INVALID_CURSOR" });
    }
  });
});
