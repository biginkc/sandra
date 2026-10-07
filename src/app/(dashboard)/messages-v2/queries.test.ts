import { describe, expect, it } from "vitest";

import {
  buildModeBadges,
  computeHeaderStats,
  deriveOpenHolds,
  describeCoverage,
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

const iso = (s: string) => `2026-10-08T${s}Z`;

describe("deriveOpenHolds", () => {
  it("is empty when nothing is flagged or pending, whatever the run statuses say", () => {
    const runs = [run({ id: "h", status: "held", property_id: "p1" }), run({ id: "e", status: "escalated", property_id: "p2" })];
    expect(deriveOpenHolds({ properties: [], decisions: [], reviews: [], runs })).toEqual([]);
  });

  it("opens a hold for a flagged property and attaches its latest run", () => {
    const runs = [
      run({ id: "old", property_id: "p1", started_at: iso("09:00:00") }),
      run({ id: "new", property_id: "p1", started_at: iso("10:00:00") }),
    ];
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: iso("09:30:00"), last_ai_escalation_reason: "seller_angry", updated_at: iso("09:30:00") }],
      decisions: [], reviews: [], runs,
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ id: "p1", property_id: "p1", sources: ["needs_attention"], since: iso("09:30:00") });
    expect(holds[0].run?.id).toBe("new");
    expect(holds[0].reason).toContain("seller_angry");
  });

  it("still holds when the run is closed but a hold step was recorded (flag is the truth)", () => {
    const runs = [run({ id: "r", status: "closed", property_id: "p1" })];
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: null, last_ai_escalation_reason: null, updated_at: iso("08:00:00") }],
      decisions: [], reviews: [], runs,
    });
    expect(holds.map((h) => h.run?.id)).toEqual(["r"]);
  });

  it("a later replied run does NOT clear a flagged property", () => {
    const runs = [
      run({ id: "hold", status: "held", property_id: "p1", conversation_id: "c1", started_at: iso("09:00:00") }),
      run({ id: "later", status: "replied", property_id: "p1", conversation_id: "c1", started_at: iso("09:30:00") }),
    ];
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: iso("09:00:00"), last_ai_escalation_reason: null, updated_at: iso("09:00:00") }],
      decisions: [], reviews: [], runs,
    });
    expect(holds).toHaveLength(1);
  });

  it("a held run whose flag has cleared is not a hold", () => {
    const runs = [run({ id: "h", status: "held", property_id: "p1" })];
    expect(deriveOpenHolds({ properties: [], decisions: [], reviews: [], runs })).toEqual([]);
  });

  it("merges flag + pending decision + pending review for one property into one card", () => {
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: iso("10:00:00"), last_ai_escalation_reason: null, updated_at: iso("10:00:00") }],
      decisions: [{ property_id: "p1", conversation_id: "c1", source_inbound_message_id: "m1", created_at: iso("09:00:00") }],
      reviews: [{ property_id: "p1", conversation_id: "c1", source_inbound_message_id: "m2", disposition: "dnc", created_at: iso("09:30:00") }],
      runs: [],
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].sources).toEqual(["needs_attention", "jev_decision", "disposition_review"]);
    expect(holds[0].since).toBe(iso("09:00:00"));
    expect(holds[0].conversation_id).toBe("c1");
  });

  it("pending decisions and reviews open holds without a flag, matched to their run by inbound message", () => {
    const runs = [
      run({ id: "other", property_id: null, inbound_message_id: "m9", started_at: iso("11:00:00") }),
      run({ id: "src", property_id: null, inbound_message_id: "m1", started_at: iso("08:00:00") }),
    ];
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [{ property_id: "p1", conversation_id: "c1", source_inbound_message_id: "m1", created_at: iso("08:00:01") }],
      reviews: [], runs,
    });
    expect(holds.map((h) => [h.id, h.run?.id])).toEqual([["p1", "src"]]);
  });

  it("falls back to a runless card for holds older than the seam", () => {
    const holds = deriveOpenHolds({
      properties: [{ id: "p1", last_ai_escalation_at: null, last_ai_escalation_reason: null, updated_at: iso("01:00:00") }],
      decisions: [], reviews: [], runs: [],
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].run).toBeNull();
    expect(holds[0].since).toBe(iso("01:00:00"));
  });

  it("orders holds oldest first", () => {
    const holds = deriveOpenHolds({
      properties: [
        { id: "late", last_ai_escalation_at: iso("11:00:00"), last_ai_escalation_reason: null, updated_at: iso("11:00:00") },
        { id: "early", last_ai_escalation_at: iso("07:00:00"), last_ai_escalation_reason: null, updated_at: iso("07:00:00") },
      ],
      decisions: [], reviews: [], runs: [],
    });
    expect(holds.map((h) => h.id)).toEqual(["early", "late"]);
  });
});

describe("computeHeaderStats", () => {
  it("counts runs started within the last hour and passes through open holds", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const runs = [
      run({ id: "1", started_at: "2026-10-08T11:30:00Z" }),
      run({ id: "2", started_at: "2026-10-08T10:30:00Z" }),
    ];
    expect(computeHeaderStats(runs, now, 3)).toEqual({ runsLastHour: 1, openHolds: 3 });
  });
});

describe("describeCoverage", () => {
  it("is null without coverage data", () => {
    expect(describeCoverage(null)).toBeNull();
  });
  it("shows inbound / runs and is healthy when runs cover inbound", () => {
    expect(describeCoverage({ inboundMessages: 4, runs: 4 })).toEqual({ text: "4 inbound / 4 runs (last hour)", gap: false });
    expect(describeCoverage({ inboundMessages: 0, runs: 0 })?.gap).toBe(false);
  });
  it("flags a gap when runs < inbound", () => {
    expect(describeCoverage({ inboundMessages: 5, runs: 3 })).toEqual({ text: "5 inbound / 3 runs (last hour)", gap: true });
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
