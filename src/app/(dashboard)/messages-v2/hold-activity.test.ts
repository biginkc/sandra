import { describe, expect, it } from "vitest";

import { normalizeInstant } from "./chicago-time";
import { holdActivityAt, sortNewestFirst } from "./hold-activity";
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
