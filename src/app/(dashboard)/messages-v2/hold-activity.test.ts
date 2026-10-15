import { describe, expect, it } from "vitest";

import { normalizeInstant } from "./chicago-time";
import { holdActivityAt, holdCursor, holdsAfter, parseHoldCursor, sortNewestFirst } from "./hold-activity";
import { deriveOpenHolds } from "./queries";
import type { OpenHold, PipelineRunStep, RunWithSteps } from "./types";

const iso = (n: number) => new Date(n).toISOString();
const norm = (n: number) => normalizeInstant(iso(n))!;
const base = (id: string, since: string | null, extra: Partial<OpenHold<RunWithSteps>> = {}): OpenHold<RunWithSteps> => ({
  id, property_id: id, conversation_id: null, sources: ["needs_attention"], since, reason: "r", run: null, ...extra,
});
const runAt = (startedAt: string, stepAt?: string): RunWithSteps => ({
  id: "r", org_id: "o", inbound_message_id: "m", property_id: null, contact_id: null, conversation_id: null, status: "held", mode: "automatic",
  final_outcome: null, reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null, inbound_preview: null,
  started_at: startedAt, completed_at: null,
  steps: stepAt ? [{ id: "s", run_id: "r", org_id: "o", seq: 1, kind: "hold", name: "x", result: "held", detail: {}, created_at: stepAt } as PipelineRunStep] : [],
});

describe("normalizeInstant", () => {
  it("keeps microseconds and normalizes offsets to UTC, so strings compare chronologically", () => {
    expect(normalizeInstant("2026-10-14T12:00:00.123456+00:00")).toBe("2026-10-14T12:00:00.123456Z");
    expect(normalizeInstant("2026-10-14T12:00:00.12Z")).toBe("2026-10-14T12:00:00.120000Z");
    expect(normalizeInstant("2026-10-14T07:00:00-05:00")).toBe("2026-10-14T12:00:00.000000Z");
    expect(normalizeInstant("nope")).toBeNull();
    expect(normalizeInstant(null)).toBeNull();
  });
});

describe("holdActivityAt / sortNewestFirst", () => {
  it("uses the latest activity, not the oldest source timestamp", () => {
    expect(holdActivityAt(base("old-hold", iso(1_000), { run: runAt(iso(9_000)) }))).toBe(norm(9_000));
  });

  it("a fresh seller text on an older hold outranks a newer flag with no new activity", () => {
    const newerFlag = base("newer-flag", iso(5_000));
    const olderHoldFreshText = base("older-hold", iso(1_000), { run: runAt(iso(2_000), iso(8_000)) });
    expect(sortNewestFirst([newerFlag, olderHoldFreshText]).map((h) => h.id)).toEqual(["older-hold", "newer-flag"]);
  });

  it("two holds active within the same millisecond order by microseconds, not by id", () => {
    const earlier = base("a-id-first", "2026-10-14T12:00:00.123100+00:00");
    const later = base("z-id-last", "2026-10-14T12:00:00.123900+00:00");
    expect(sortNewestFirst([earlier, later]).map((h) => h.id)).toEqual(["z-id-last", "a-id-first"]);
    // and the cursor keeps that precision, so paging between them neither repeats nor skips
    const sorted = sortNewestFirst([earlier, later]);
    expect(holdsAfter(sorted, holdCursor(sorted[0])).map((h) => h.id)).toEqual(["a-id-first"]);
  });

  it("a hold with an OLD flag but a NEW pending decision sorts to the top (since is the oldest source time)", () => {
    const oldFlagNewDecision = base("old-flag-new-decision", iso(1_000), { last_activity: iso(90_000) });
    const recentFlagOnly = base("recent-flag", iso(50_000), { last_activity: iso(50_000) });
    expect(sortNewestFirst([recentFlagOnly, oldFlagNewDecision]).map((h) => h.id)).toEqual(["old-flag-new-decision", "recent-flag"]);
  });

  it("falls back to since, and sorts a hold with no time at all last", () => {
    const unknown = base("unknown", null);
    expect(sortNewestFirst([unknown, base("a", iso(3_000)), base("b", iso(4_000))]).map((h) => h.id)).toEqual(["b", "a", "unknown"]);
    expect(holdActivityAt(unknown)).toBeNull();
  });

  it("breaks ties deterministically by id", () => {
    expect(sortNewestFirst([base("b", iso(1_000)), base("a", iso(1_000))]).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("keyset paging (holdsAfter)", () => {
  const mk = (id: string, last: number) => base(id, iso(last), { last_activity: iso(last) });

  it("a hold arriving between page 1 and page 2 causes no repeat and no skip, and the last hold stays reachable", () => {
    let server = ["a", "b", "c", "d", "e", "f"].map((id, i) => mk(id, 10_000 - i * 100));
    const page = (cursor: ReturnType<typeof holdCursor> | null, limit: number) => holdsAfter(sortNewestFirst(server), cursor).slice(0, limit);
    const page1 = page(null, 3);
    expect(page1.map((h) => h.id)).toEqual(["a", "b", "c"]);
    server = [mk("new", 20_000), ...server];
    const page2 = page(holdCursor(page1[page1.length - 1]), 3);
    expect(page2.map((h) => h.id)).toEqual(["d", "e", "f"]);
    expect(page(holdCursor(page2[page2.length - 1]), 3)).toEqual([]);
  });

  it("there is no ceiling: a hold ranked far past any former cap is reached by paging", () => {
    const server = Array.from({ length: 5_300 }, (_, i) => mk(`h${String(i).padStart(5, "0")}`, 1_000_000 - i * 10));
    const sorted = sortNewestFirst(server);
    const seen = new Set<string>();
    let cursor: ReturnType<typeof holdCursor> | null = null;
    for (;;) {
      const p = holdsAfter(sorted, cursor).slice(0, 1_000);
      if (!p.length) break;
      for (const h of p) seen.add(h.id);
      cursor = holdCursor(p[p.length - 1]);
    }
    expect(seen.size).toBe(5_300);
    expect(seen.has("h05299")).toBe(true); // the oldest-ranked hold, 5,300th
  });

  it("holds sharing an activity time are ordered by id and never skipped at the edge", () => {
    const sorted = sortNewestFirst([mk("b", 5_000), mk("a", 5_000), mk("c", 5_000), mk("d", 1_000)]);
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

  it("only a normalized timestamp (or null) and a uuid are accepted as a cursor", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(parseHoldCursor({ at: "2026-10-14T12:00:00.123456Z", id })).toEqual({ at: "2026-10-14T12:00:00.123456Z", id });
    expect(parseHoldCursor({ at: null, id })).toEqual({ at: null, id });
    expect(parseHoldCursor({ at: "2026-10-14T12:00:00Z", id })).toBeNull();
    expect(parseHoldCursor({ at: 5, id })).toBeNull();
    expect(parseHoldCursor({ at: null, id: "p1" })).toBeNull(); // not a uuid
  });
});

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
