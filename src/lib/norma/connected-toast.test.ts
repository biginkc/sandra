import { describe, expect, it } from "vitest";

import { CONNECTED_TOAST_LOOKBACK_MS, connectedToastSince, connectedToastText, selectConnectedToasts, type ConnectedRequestRow } from "./connected-toast";

const ME = "user-me";
const NOW = Date.parse("2026-10-02T15:00:00Z");
const since = connectedToastSince(NOW);
const row = (over: Partial<ConnectedRequestRow> = {}): ConnectedRequestRow => ({
  id: "r1", property_id: "p1", status: "completed", outcome: "callback_requested",
  completed_at: "2026-10-02T15:00:01Z", requested_by: ME, ...over,
});

describe("connected toast trigger", () => {
  it("fires for each connected outcome on my own completed request", () => {
    for (const outcome of ["reached_no_callback", "callback_requested", "not_interested", "wrong_number"]) {
      expect(selectConnectedToasts([row({ outcome })], ME, new Set(), since)).toHaveLength(1);
    }
  });

  it("never fires for no answer, review states, open requests or other outcomes", () => {
    for (const over of [
      { outcome: "no_answer" }, { outcome: "unknown" }, { outcome: null },
      { status: "needs_review", outcome: "unknown" }, { status: "dispatched", outcome: null },
      { status: "requested", outcome: null }, { completed_at: null },
    ]) {
      expect(selectConnectedToasts([row(over)], ME, new Set(), since)).toHaveLength(0);
    }
  });

  it("only the requesting rep sees it", () => {
    expect(selectConnectedToasts([row({ requested_by: "someone-else" })], ME, new Set(), since)).toHaveLength(0);
    expect(selectConnectedToasts([row({ requested_by: null })], ME, new Set(), since)).toHaveLength(0);
  });

  it("shows once: an already-notified request is skipped", () => {
    expect(selectConnectedToasts([row()], ME, new Set(["r1"]), since)).toHaveLength(0);
  });

  it("ignores calls that finished long before the page loaded, but covers a reload right after a call", () => {
    expect(selectConnectedToasts([row({ completed_at: new Date(NOW - CONNECTED_TOAST_LOOKBACK_MS - 1000).toISOString() })], ME, new Set(), since)).toHaveLength(0);
    expect(selectConnectedToasts([row({ completed_at: new Date(NOW - 30_000).toISOString() })], ME, new Set(), since)).toHaveLength(1);
  });

  it("text is plain and factual", () => {
    expect(connectedToastText("Pat Seller", "12 Oak St, KC, MO")).toBe("Norma reached Pat Seller — 12 Oak St, KC, MO");
    expect(connectedToastText("  ", "12 Oak St")).toBe("Norma reached the seller — 12 Oak St");
    expect(connectedToastText(null, null)).toBe("Norma reached the seller");
  });
});
