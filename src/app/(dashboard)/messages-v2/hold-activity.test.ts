import { describe, expect, it } from "vitest";

import { holdActivityMs, sortNewestFirst } from "./hold-activity";
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

  it("falls back to since, and sorts a hold with no time at all last", () => {
    const unknown = base("unknown", null);
    expect(sortNewestFirst([unknown, base("a", iso(3_000)), base("b", iso(4_000))]).map((h) => h.id)).toEqual(["b", "a", "unknown"]);
    expect(holdActivityMs(unknown)).toBeNull();
  });

  it("breaks ties deterministically by id", () => {
    expect(sortNewestFirst([base("b", iso(1_000)), base("a", iso(1_000))]).map((h) => h.id)).toEqual(["a", "b"]);
  });
});
