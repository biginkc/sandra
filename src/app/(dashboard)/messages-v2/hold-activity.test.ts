import { describe, expect, it } from "vitest";

import { holdActivityMs, holdCursor, holdsAfter, parseHoldCursor, sortNewestFirst } from "./hold-activity";
import type { OpenHold, PipelineRunStep, RunWithSteps } from "./types";

const iso = (n: number) => new Date(n).toISOString();
const base = (id: string, since: string | null, extra: Partial<OpenHold<RunWithSteps>> = {}): OpenHold<RunWithSteps> => ({
  id, property_id: id, conversation_id: null, sources: ["needs_attention"], since, reason: "r", run: null, ...extra,
});
const runAt = (startedAt: string, stepAt?: string): RunWithSteps => ({
  id: "r", org_id: "o", inbound_message_id: "m", property_id: null, contact_id: null, conversation_id: null, status: "held", mode: "automatic",
  final_outcome: null, reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null, inbound_preview: null,
  started_at: startedAt, completed_at: null,
  steps: stepAt ? [{ id: "s", run_id: "r", org_id: "o", seq: 1, kind: "hold", name: "x", result: "held", detail: {}, created_at: stepAt } as PipelineRunStep] : [],
});

describe("holdActivityMs / sortNewestFirst", () => {
  it("uses the latest activity, not the oldest source timestamp", () => {
    expect(holdActivityMs(base("old-hold", iso(1_000), { run: runAt(iso(9_000)) }))).toBe(9_000);
  });

  it("a fresh seller text on an older hold outranks a newer flag with no new activity", () => {
    const newerFlag = base("newer-flag", iso(5_000));
    const olderHoldFreshText = base("older-hold", iso(1_000), { run: runAt(iso(2_000), iso(8_000)) });
    expect(sortNewestFirst([newerFlag, olderHoldFreshText]).map((h) => h.id)).toEqual(["older-hold", "newer-flag"]);
  });

  it("a hold far down the server's start-time order, with newer activity, sorts to the top of ALL holds", () => {
    // 400 holds that started recently with no later activity, plus one that started long ago but was texted just now.
    const many = Array.from({ length: 400 }, (_, i) => base(`h${String(i).padStart(3, "0")}`, iso(100_000 - i)));
    const buried = base("buried", iso(1), { run: runAt(iso(500_000)) });
    const sorted = sortNewestFirst([...many, buried]);
    expect(sorted[0].id).toBe("buried");
    expect(sorted.slice(0, 301).some((h) => h.id === "buried")).toBe(true); // lands on page 1, not behind "Show older"
  });

  it("a hold with an OLD flag but a NEW pending decision sorts to the top (since is the oldest source time)", () => {
    const oldFlagNewDecision = base("old-flag-new-decision", iso(1_000), { last_activity: iso(90_000) });
    const recentFlagOnly = base("recent-flag", iso(50_000), { last_activity: iso(50_000) });
    expect(sortNewestFirst([recentFlagOnly, oldFlagNewDecision]).map((h) => h.id)).toEqual(["old-flag-new-decision", "recent-flag"]);
    expect(holdActivityMs(oldFlagNewDecision)).toBe(90_000);
  });

  it("falls back to since, and sorts a hold with no time at all last", () => {
    const unknown = base("unknown", null);
    expect(sortNewestFirst([unknown, base("a", iso(3_000)), base("b", iso(4_000))]).map((h) => h.id)).toEqual(["b", "a", "unknown"]);
    expect(holdActivityMs(unknown)).toBeNull();
  });

  it("breaks ties deterministically by id", () => {
    expect(sortNewestFirst([base("b", iso(1_000)), base("a", iso(1_000))]).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

import { deriveOpenHolds } from "./queries";

describe("deriveOpenHolds last_activity", () => {
  it("is the newest of the flag and every pending decision / review / draft, while since stays the oldest", () => {
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: "2026-01-01T00:00:00Z", last_ai_escalation_reason: "model:unclear", updated_at: null, needs_human_attention_since: "2026-01-01T00:00:00Z" }],
      decisions: [{ property_id: "p1", conversation_id: "c", source_inbound_message_id: "m", created_at: "2026-10-14T12:00:00Z" }],
      reviews: [],
      drafts: [{ id: "d", property_id: "p1", conversation_id: null, inbound_message_id: null, run_id: null, created_at: "2026-10-10T00:00:00Z" }],
      runs: [],
    });
    expect(holds[0].since).toBe("2026-01-01T00:00:00Z");
    expect(holds[0].last_activity).toBe("2026-10-14T12:00:00Z");
  });
});

describe("keyset paging (holdsAfter)", () => {
  const mk = (id: string, last: number) => base(id, iso(last), { last_activity: iso(last) });

  it("a hold arriving between page 1 and page 2 causes no repeat and no skip, and the last hold stays reachable", () => {
    let server = ["a", "b", "c", "d", "e", "f"].map((id, i) => mk(id, 10_000 - i * 100)); // a newest ... f oldest
    const page = (cursor: ReturnType<typeof holdCursor> | null, limit: number) => holdsAfter(sortNewestFirst(server), cursor).slice(0, limit);
    const page1 = page(null, 3);
    expect(page1.map((h) => h.id)).toEqual(["a", "b", "c"]);
    // A brand-new hold lands on top between the two requests.
    server = [mk("new", 20_000), ...server];
    const page2 = page(holdCursor(page1[page1.length - 1]), 3);
    expect(page2.map((h) => h.id)).toEqual(["d", "e", "f"]); // "c" not repeated, nothing skipped, "f" reachable
    expect(page(holdCursor(page2[page2.length - 1]), 3)).toEqual([]);
  });

  it("holds sharing an activity time are ordered by id and never skipped at the edge", () => {
    const server = [mk("b", 5_000), mk("a", 5_000), mk("c", 5_000), mk("d", 1_000)];
    const sorted = sortNewestFirst(server);
    const seen: string[] = [];
    let cursor: ReturnType<typeof holdCursor> | null = null;
    for (;;) {
      const p = holdsAfter(sorted, cursor).slice(0, 1);
      if (!p.length) break;
      seen.push(p[0].id);
      cursor = holdCursor(p[0]);
    }
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  it("holds with no known time page last, after every dated hold", () => {
    const sorted = sortNewestFirst([base("x", null), mk("dated", 1_000)]);
    expect(holdsAfter(sorted, holdCursor(sorted[0])).map((h) => h.id)).toEqual(["x"]);
  });

  it("only a finite number (or null) and a short id are accepted as a cursor", () => {
    expect(parseHoldCursor({ at: 5, id: "p1" })).toEqual({ at: 5, id: "p1" });
    expect(parseHoldCursor({ at: null, id: "p1" })).toEqual({ at: null, id: "p1" });
    expect(parseHoldCursor({ at: "5", id: "p1" })).toBeNull();
    expect(parseHoldCursor({ at: Number.NaN, id: "p1" })).toBeNull();
    expect(parseHoldCursor({ at: 5, id: "" })).toBeNull();
  });
});
