import { describe, expect, it } from "vitest";

import { appendStep, upsertRun } from "./feed-state";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const run = (id: string, started_at: string, over: Partial<PipelineRun> = {}): PipelineRun => ({
  id, org_id: "o", inbound_message_id: `m-${id}`, property_id: null, contact_id: null,
  conversation_id: null, status: "running", mode: "automatic", final_outcome: null,
  reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null,
  inbound_preview: null, started_at, completed_at: null, ...over,
});
const step = (id: string, run_id: string, seq: number): PipelineRunStep => ({
  id, run_id, org_id: "o", seq, kind: "gate", name: "g", result: "pass", detail: {}, created_at: "",
});

describe("upsertRun", () => {
  it("inserts new runs newest first", () => {
    const a: RunWithSteps = { ...run("a", "2026-10-08T10:00:00Z"), steps: [] };
    const out = upsertRun([a], run("b", "2026-10-08T11:00:00Z"));
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("updates in place and keeps already-streamed steps", () => {
    const a: RunWithSteps = { ...run("a", "2026-10-08T10:00:00Z"), steps: [step("s1", "a", 1)] };
    const out = upsertRun([a], run("a", "2026-10-08T10:00:00Z", { status: "replied" }));
    expect(out[0].status).toBe("replied");
    expect(out[0].steps).toHaveLength(1);
  });
  it("caps memory at 200 runs, dropping the oldest", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...run(`r${i}`, new Date(Date.UTC(2026, 9, 8, 0, i)).toISOString()),
      steps: [],
    }));
    const out = upsertRun(many, run("new", "2026-10-09T00:00:00Z"));
    expect(out).toHaveLength(200);
    expect(out[0].id).toBe("new");
    expect(out.some((r) => r.id === "r0")).toBe(false);
  });
});

describe("appendStep", () => {
  const a: RunWithSteps = { ...run("a", "2026-10-08T10:00:00Z"), steps: [] };
  it("appends and orders by seq", () => {
    const one = appendStep([a], step("s2", "a", 2));
    const two = appendStep(one.runs, step("s1", "a", 1));
    expect(two.runs[0].steps.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
  it("is idempotent for a replayed step", () => {
    const one = appendStep([a], step("s1", "a", 1));
    expect(appendStep(one.runs, step("s1", "a", 1)).runs[0].steps).toHaveLength(1);
  });
  it("flags steps for unknown runs", () => {
    expect(appendStep([a], step("s9", "zzz", 1)).unknownRun).toBe(true);
  });
});
