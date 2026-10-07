import { describe, expect, it } from "vitest";

import {
  buildModeBadges,
  computeHeaderStats,
  deriveOpenHolds,
  groupStepsByRun,
} from "./queries";
import type { PipelineRun, PipelineRunStep } from "./types";

function run(over: Partial<PipelineRun> & { id: string }): PipelineRun {
  return {
    org_id: "org",
    inbound_message_id: `msg-${over.id}`,
    property_id: null,
    contact_id: null,
    conversation_id: null,
    status: "replied",
    mode: "automatic",
    final_outcome: null,
    reason: null,
    classification_run_id: null,
    claim_id: null,
    outbound_message_id: null,
    inbound_preview: null,
    started_at: "2026-10-08T10:00:00.000Z",
    completed_at: null,
    ...over,
  };
}

describe("deriveOpenHolds", () => {
  it("returns held and escalated runs oldest first", () => {
    const runs = [
      run({ id: "b", status: "escalated", conversation_id: "c2", started_at: "2026-10-08T11:00:00Z" }),
      run({ id: "a", status: "held", conversation_id: "c1", started_at: "2026-10-08T09:00:00Z" }),
      run({ id: "x", status: "replied", conversation_id: "c3" }),
    ];
    expect(deriveOpenHolds(runs).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drops a hold once a later run exists on the same conversation", () => {
    const runs = [
      run({ id: "hold", status: "held", conversation_id: "c1", started_at: "2026-10-08T09:00:00Z" }),
      run({ id: "later", status: "replied", conversation_id: "c1", started_at: "2026-10-08T09:30:00Z" }),
    ];
    expect(deriveOpenHolds(runs)).toEqual([]);
  });

  it("keeps the hold when the later run is on a different conversation", () => {
    const runs = [
      run({ id: "hold", status: "held", conversation_id: "c1", started_at: "2026-10-08T09:00:00Z" }),
      run({ id: "other", status: "replied", conversation_id: "c2", started_at: "2026-10-08T09:30:00Z" }),
    ];
    expect(deriveOpenHolds(runs).map((r) => r.id)).toEqual(["hold"]);
  });

  it("only the newest of two holds on one conversation stays open", () => {
    const runs = [
      run({ id: "old", status: "held", conversation_id: "c1", started_at: "2026-10-08T09:00:00Z" }),
      run({ id: "new", status: "escalated", conversation_id: "c1", started_at: "2026-10-08T10:00:00Z" }),
    ];
    expect(deriveOpenHolds(runs).map((r) => r.id)).toEqual(["new"]);
  });

  it("keeps holds with no conversation id (nothing can supersede them)", () => {
    expect(deriveOpenHolds([run({ id: "n", status: "held" })]).map((r) => r.id)).toEqual(["n"]);
  });
});

describe("computeHeaderStats", () => {
  it("counts runs started within the last hour and open holds", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const runs = [
      run({ id: "1", started_at: "2026-10-08T11:30:00Z" }),
      run({ id: "2", started_at: "2026-10-08T10:30:00Z" }),
      run({ id: "3", status: "held", conversation_id: "c", started_at: "2026-10-08T11:59:00Z" }),
    ];
    expect(computeHeaderStats(runs, now)).toEqual({ runsLastHour: 2, openHolds: 1 });
  });
});

describe("buildModeBadges", () => {
  const thresholds = [{ outcome: "not_interested" }, { outcome: "nurture" }];
  it("shows AUTO when jev is automatic", () => {
    expect(buildModeBadges({ classifier_provider: "jev", classifier_mode: "automatic" }, thresholds)).toEqual([
      { label: "not_interested", mode: "AUTO" },
      { label: "nurture", mode: "AUTO" },
    ]);
  });
  it("shows SHADOW when jev is in shadow", () => {
    expect(buildModeBadges({ classifier_provider: "jev", classifier_mode: "shadow" }, thresholds)[0].mode).toBe("SHADOW");
  });
  it("shows LEGACY when the legacy classifier is live or no config exists", () => {
    expect(buildModeBadges({ classifier_provider: "legacy", classifier_mode: "shadow" }, thresholds)[0].mode).toBe("LEGACY");
    expect(buildModeBadges(null, thresholds)[0].mode).toBe("LEGACY");
  });
});

describe("groupStepsByRun", () => {
  it("groups and orders steps by seq", () => {
    const step = (id: string, run_id: string, seq: number): PipelineRunStep => ({
      id, run_id, org_id: "o", seq, kind: "gate", name: "n", result: "pass", detail: {}, created_at: "",
    });
    const grouped = groupStepsByRun([step("s2", "r1", 2), step("s1", "r1", 1), step("s3", "r2", 1)]);
    expect(grouped.get("r1")!.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(grouped.get("r2")!.map((s) => s.id)).toEqual(["s3"]);
  });
});
