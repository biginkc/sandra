import { describe, expect, it } from "vitest";

import {
  buildModeBadges,
  computeHeaderStats,
  deriveOpenHolds,
  describeCoverage,
  formatModeBadge,
  groupStepsByRun,
  loadMessagesV2Data,
  type LooseSupabase,
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
    const runs = [
      run({ id: "h", status: "held", property_id: "p1" }),
      run({ id: "e", status: "escalated", property_id: "p2" }),
    ];
    expect(
      deriveOpenHolds({ properties: [], decisions: [], reviews: [], runs }),
    ).toEqual([]);
  });

  it("opens a hold for a flagged property and attaches its latest run", () => {
    const runs = [
      run({ id: "old", property_id: "p1", started_at: iso("09:00:00") }),
      run({ id: "new", property_id: "p1", started_at: iso("10:00:00") }),
    ];
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: iso("09:30:00"),
          last_ai_escalation_reason: "seller_angry",
          updated_at: iso("09:30:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs,
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      id: "p1",
      property_id: "p1",
      sources: ["needs_attention"],
      since: iso("09:30:00"),
    });
    expect(holds[0].run?.id).toBe("new");
    expect(holds[0].reason).toContain("seller_angry");
  });

  it("still holds when the run is closed but a hold step was recorded (flag is the truth)", () => {
    const runs = [run({ id: "r", status: "closed", property_id: "p1" })];
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: null,
          last_ai_escalation_reason: null,
          updated_at: iso("08:00:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs,
    });
    expect(holds.map((h) => h.run?.id)).toEqual(["r"]);
  });

  it("a later replied run does NOT clear a flagged property", () => {
    const runs = [
      run({
        id: "hold",
        status: "held",
        property_id: "p1",
        conversation_id: "c1",
        started_at: iso("09:00:00"),
      }),
      run({
        id: "later",
        status: "replied",
        property_id: "p1",
        conversation_id: "c1",
        started_at: iso("09:30:00"),
      }),
    ];
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: iso("09:00:00"),
          last_ai_escalation_reason: null,
          updated_at: iso("09:00:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs,
    });
    expect(holds).toHaveLength(1);
  });

  it("a held run whose flag has cleared is not a hold", () => {
    const runs = [run({ id: "h", status: "held", property_id: "p1" })];
    expect(
      deriveOpenHolds({ properties: [], decisions: [], reviews: [], runs }),
    ).toEqual([]);
  });

  it("merges flag + pending decision + pending review for one property into one card", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: iso("10:00:00"),
          last_ai_escalation_reason: null,
          updated_at: iso("10:00:00"),
        },
      ],
      decisions: [
        {
          property_id: "p1",
          conversation_id: "c1",
          source_inbound_message_id: "m1",
          created_at: iso("09:00:00"),
        },
      ],
      reviews: [
        {
          property_id: "p1",
          conversation_id: "c1",
          source_inbound_message_id: "m2",
          disposition: "dnc",
          created_at: iso("09:30:00"),
        },
      ],
      runs: [],
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].sources).toEqual([
      "needs_attention",
      "jev_decision",
      "disposition_review",
    ]);
    expect(holds[0].since).toBe(iso("09:00:00"));
    expect(holds[0].conversation_id).toBe("c1");
  });

  it("pending decisions and reviews open holds without a flag, matched to their run by inbound message", () => {
    const runs = [
      run({
        id: "other",
        property_id: null,
        inbound_message_id: "m9",
        started_at: iso("11:00:00"),
      }),
      run({
        id: "src",
        property_id: null,
        inbound_message_id: "m1",
        started_at: iso("08:00:00"),
      }),
    ];
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [
        {
          property_id: "p1",
          conversation_id: "c1",
          source_inbound_message_id: "m1",
          created_at: iso("08:00:01"),
        },
      ],
      reviews: [],
      runs,
    });
    expect(holds.map((h) => [h.id, h.run?.id])).toEqual([["p1", "src"]]);
  });

  it("falls back to a runless card for holds older than the seam", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: null,
          last_ai_escalation_reason: null,
          updated_at: iso("01:00:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs: [],
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].run).toBeNull();
    // updated_at is not a hold clock: age is unknown, not guessed.
    expect(holds[0].since).toBeNull();
  });

  it("flagged property without an escalation time takes the earliest pending decision/review time, not updated_at", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: null,
          last_ai_escalation_reason: null,
          updated_at: iso("11:59:00"),
        },
      ],
      decisions: [
        {
          property_id: "p1",
          conversation_id: "c1",
          source_inbound_message_id: "m1",
          created_at: iso("08:00:00"),
        },
      ],
      reviews: [],
      runs: [],
    });
    expect(holds[0].since).toBe(iso("08:00:00"));
  });

  it("sorts unknown-age holds last", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "unk",
          last_ai_escalation_at: null,
          last_ai_escalation_reason: null,
          updated_at: iso("01:00:00"),
        },
        {
          id: "known",
          last_ai_escalation_at: iso("11:00:00"),
          last_ai_escalation_reason: null,
          updated_at: iso("11:00:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs: [],
    });
    expect(holds.map((h) => h.id)).toEqual(["known", "unk"]);
  });

  it("orders holds oldest first", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "late",
          last_ai_escalation_at: iso("11:00:00"),
          last_ai_escalation_reason: null,
          updated_at: iso("11:00:00"),
        },
        {
          id: "early",
          last_ai_escalation_at: iso("07:00:00"),
          last_ai_escalation_reason: null,
          updated_at: iso("07:00:00"),
        },
      ],
      decisions: [],
      reviews: [],
      runs: [],
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
    expect(computeHeaderStats(runs, now, 3)).toEqual({
      runsLastHour: 1,
      openHolds: 3,
    });
  });
});

describe("describeCoverage", () => {
  it("is null without coverage data", () => {
    expect(describeCoverage(null)).toBeNull();
  });
  it("shows an explicit degraded indicator when the coverage query failed", () => {
    expect(describeCoverage(null, true)).toEqual({
      text: "coverage unavailable",
      gap: true,
      degraded: true,
    });
  });
  it("shows inbound / runs and is healthy when runs cover inbound", () => {
    expect(describeCoverage({ inboundMessages: 4, runs: 4 })).toEqual({
      text: "4 inbound / 4 runs (last hour)",
      gap: false,
    });
    expect(describeCoverage({ inboundMessages: 0, runs: 0 })?.gap).toBe(false);
  });
  it("flags a gap when runs < inbound", () => {
    expect(describeCoverage({ inboundMessages: 5, runs: 3 })).toEqual({
      text: "5 inbound / 3 runs (last hour)",
      gap: true,
    });
  });
});

describe("buildModeBadges", () => {
  const thresholds = [
    {
      outcome: "not_interested",
      min_confidence: "0.950",
      automation_enabled: true,
    },
    { outcome: "nurture", min_confidence: 0.9 },
  ];
  const jevAuto = { classifier_provider: "jev", classifier_mode: "automatic" };
  it("shows AUTO with the confidence floor; missing automation_enabled counts as enabled", () => {
    const badges = buildModeBadges(jevAuto, thresholds);
    expect(badges.map((b) => [b.label, formatModeBadge(b)])).toEqual([
      ["not_interested", "AUTO ≥0.95"],
      ["nurture", "AUTO ≥0.90"],
    ]);
  });
  it("shows HELD for an outcome with automation disabled", () => {
    const [b] = buildModeBadges(jevAuto, [
      { outcome: "x", min_confidence: 0.9, automation_enabled: false },
    ]);
    expect(formatModeBadge(b)).toBe("HELD");
  });
  it("shows SHADOW when jev is in shadow, even if automation is disabled", () => {
    const badges = buildModeBadges(
      { classifier_provider: "jev", classifier_mode: "shadow" },
      [{ outcome: "x", min_confidence: 0.9, automation_enabled: false }],
    );
    expect(formatModeBadge(badges[0])).toBe("SHADOW");
  });
  it("shows LEGACY when the legacy classifier is live or no config exists", () => {
    expect(
      buildModeBadges(
        { classifier_provider: "legacy", classifier_mode: "automatic" },
        thresholds,
      )[0].mode,
    ).toBe("LEGACY");
    expect(buildModeBadges(null, thresholds)[0].mode).toBe("LEGACY");
  });
});

type Call = { table: string; method: string; args: unknown[] }[];
type Result = { data?: unknown; error?: unknown; count?: number | null };

/** Chainable fake supabase: records calls per query, resolves per table. */
function fakeSupabase(results: Record<string, (calls: Call) => Result>) {
  const queries: Call[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: LooseSupabase = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const r = { data: [], error: null, ...(results[fn]?.([]) ?? {}) };
      return Promise.resolve(r);
    },
    from(table: string) {
      const calls: Call = [];
      queries.push(calls);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) {
        q[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args });
          return q;
        };
      }
      q.then = (resolve: (v: Result) => unknown) =>
        resolve({
          data: [],
          error: null,
          count: null,
          ...(results[table]?.(calls) ?? {}),
        });
      return q;
    },
  };
  return { client, queries, rpcCalls };
}
const isHead = (c: Call) =>
  c.some(
    (x) =>
      x.method === "select" && JSON.stringify(x.args[1] ?? {}).includes("head"),
  );

describe("loadMessagesV2Data holds", () => {
  it("orders each hold source oldest-first before limiting, and takes counts from separate head queries", async () => {
    const { client, queries } = fakeSupabase({});
    await loadMessagesV2Data(client, "org");
    const find = (table: string) =>
      queries.filter((q) => q[0]?.table === table && !isHead(q));
    const orderCols = (q: Call) =>
      q.filter((c) => c.method === "order").map((c) => c.args[0]);
    const limitIdx = (q: Call) => q.findIndex((c) => c.method === "limit");
    for (const [table, first] of [
      ["properties", "last_ai_escalation_at"],
      ["jev_lead_decisions", "created_at"],
      ["ai_disposition_reviews", "created_at"],
    ] as const) {
      const q = find(table)[0];
      expect(orderCols(q)[0]).toBe(first);
      expect(q.find((c) => c.method === "order")!.args[1]).toMatchObject({
        ascending: true,
      });
      expect(q.findIndex((c) => c.method === "order")).toBeLessThan(
        limitIdx(q),
      );
    }
    expect(queries.filter(isHead)).toHaveLength(3);
  });

  it("reports truncation as 'N holds (M shown)' data", async () => {
    const props = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`,
      last_ai_escalation_at: iso("01:00:00"),
      last_ai_escalation_reason: null,
      updated_at: iso("01:00:00"),
    }));
    const { client } = fakeSupabase({
      properties: (calls) =>
        isHead(calls) ? { data: null, count: 350 } : { data: props },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta).toMatchObject({
      total: 350,
      shown: 200,
      truncated: true,
      failed: [],
    });
  });

  it("is not truncated when counts match what was returned", async () => {
    const { client } = fakeSupabase({
      properties: (calls) =>
        isHead(calls)
          ? { data: null, count: 1 }
          : {
              data: [
                {
                  id: "p1",
                  last_ai_escalation_at: iso("01:00:00"),
                  last_ai_escalation_reason: null,
                  updated_at: iso("01:00:00"),
                },
              ],
            },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta).toMatchObject({
      total: 1,
      shown: 1,
      truncated: false,
    });
  });

  it("surfaces a failed source query instead of treating it as empty", async () => {
    const { client } = fakeSupabase({
      jev_lead_decisions: (calls) =>
        isHead(calls) ? {} : { data: null, error: { message: "boom" } },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta.failed).toEqual(["jev_decision"]);
    expect(data.holds).toEqual([]);
  });

  it("chunks message lookups to 40 and fetches latest runs per property via one RPC per 200 ids", async () => {
    const props = Array.from({ length: 450 }, (_, i) => ({
      id: `p${i}`,
      last_ai_escalation_at: iso("01:00:00"),
      last_ai_escalation_reason: null,
      updated_at: iso("01:00:00"),
    }));
    const decisions = Array.from({ length: 90 }, (_, i) => ({
      property_id: `p${i}`,
      conversation_id: `c${i}`,
      source_inbound_message_id: `m${i}`,
      created_at: iso("02:00:00"),
    }));
    const { client, queries, rpcCalls } = fakeSupabase({
      properties: (calls) => (isHead(calls) ? {} : { data: props }),
      jev_lead_decisions: (calls) => (isHead(calls) ? {} : { data: decisions }),
    });
    await loadMessagesV2Data(client, "org");
    const runQueries = queries.filter((q) => q[0]?.table === "pipeline_runs");
    const inLens = runQueries
      .flatMap((q) => q.filter((c) => c.method === "in"))
      .map((c) => (c.args[1] as unknown[]).length);
    expect(Math.max(...inLens)).toBeLessThanOrEqual(40);
    expect(rpcCalls.map((c) => c.fn)).toEqual(
      Array(3).fill("pipeline_runs_latest_for_properties"),
    );
    expect(
      rpcCalls.map((c) => (c.args.p_property_ids as string[]).length),
    ).toEqual([200, 200, 50]);
    expect(rpcCalls[0].args.p_org_id).toBe("org");
  });

  it("surfaces run-lookup failures as context errors", async () => {
    const decisions = [
      {
        property_id: "p1",
        conversation_id: "c1",
        source_inbound_message_id: "m1",
        created_at: iso("02:00:00"),
      },
    ];
    const { client } = fakeSupabase({
      jev_lead_decisions: (calls) => (isHead(calls) ? {} : { data: decisions }),
      pipeline_runs_latest_for_properties: () => ({
        data: null,
        error: { message: "x" },
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta.contextErrors).toContain("run lookup by property");
  });

  it("marks holds whose run has a pending ai_reply_drafts row, and tolerates the table being absent", async () => {
    const decisions = [
      {
        property_id: "p1",
        conversation_id: "c1",
        source_inbound_message_id: "m1",
        created_at: iso("02:00:00"),
      },
    ];
    const runRow = {
      ...run({ id: "r1", property_id: "p1", inbound_message_id: "m1" }),
    };
    const base = {
      jev_lead_decisions: (calls: Call) =>
        isHead(calls) ? {} : { data: decisions },
      pipeline_runs: (calls: Call) =>
        calls.some((c) => c.method === "limit" && c.args[0] === MAX)
          ? { data: [] }
          : { data: [runRow] },
    };
    const MAX = 200;
    const withDraft = await loadMessagesV2Data(
      fakeSupabase({
        ...base,
        ai_reply_drafts: () => ({ data: [{ run_id: "r1" }] }),
      }).client,
      "org",
    );
    expect(withDraft.holds[0].draft_held).toBe(true);
    const absent = await loadMessagesV2Data(
      fakeSupabase({
        ...base,
        ai_reply_drafts: () => ({
          data: null,
          error: { message: "relation does not exist" },
        }),
      }).client,
      "org",
    );
    expect(absent.holds[0].draft_held).toBe(false);
  });

  it("falls back to thresholds without automation_enabled when that column is missing", async () => {
    let n = 0;
    const { client } = fakeSupabase({
      jev_outcome_thresholds: () =>
        n++ === 0
          ? { data: null, error: { message: "column does not exist" } }
          : { data: [{ outcome: "x", min_confidence: 0.9 }] },
      ai_responder_configs: () => ({
        data: [{ classifier_provider: "jev", classifier_mode: "automatic" }],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(formatModeBadge(data.badges[0])).toBe("AUTO ≥0.90");
  });
});

describe("groupStepsByRun", () => {
  it("groups and orders steps by seq", () => {
    const step = (
      id: string,
      run_id: string,
      seq: number,
    ): PipelineRunStep => ({
      id,
      run_id,
      org_id: "o",
      seq,
      kind: "gate",
      name: "n",
      result: "pass",
      detail: {},
      created_at: "",
    });
    const grouped = groupStepsByRun([
      step("s2", "r1", 2),
      step("s1", "r1", 1),
      step("s3", "r2", 1),
    ]);
    expect(grouped.get("r1")!.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(grouped.get("r2")!.map((s) => s.id)).toEqual(["s3"]);
  });
});
