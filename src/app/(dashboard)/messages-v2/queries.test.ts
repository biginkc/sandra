import { describe, expect, it } from "vitest";

import {
  buildModeBadges,
  computeHeaderStats,
  deriveOpenHolds,
  describeCoverage,
  formatModeBadge,
  groupStepsByRun,
  HOLDS_COUNT_CAP,
  buildHoldsMeta,
  formatHoldsTotal,
  loadMessagesV2Data,
  type HoldDraftRow,
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
    expect(holds[0].flag_reason).toBe("seller_angry");
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
  it("shows AUTO with the confidence floor; missing automation_enabled is UNKNOWN", () => {
    const badges = buildModeBadges(jevAuto, thresholds);
    expect(badges.map((b) => [b.label, formatModeBadge(b)])).toEqual([
      ["not_interested", "AUTO ≥0.95"],
      ["nurture", "UNKNOWN"],
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
      for (const m of ["select", "eq", "in", "order", "limit", "not", "gte"]) {
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
/** The capped id-only query used for distinct-hold totals. */
const isHead = (c: Call) =>
  c.some((x) => x.method === "limit" && x.args[0] === HOLDS_COUNT_CAP + 1);

describe("loadMessagesV2Data holds", () => {
  it("orders each hold source oldest-first before limiting, and takes distinct totals from separate capped id queries", async () => {
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
      ["ai_reply_drafts", "created_at"],
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
    expect(queries.filter(isHead)).toHaveLength(4);
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
        isHead(calls)
          ? { data: Array.from({ length: 350 }, (_, i) => ({ id: `p${i}` })) }
          : { data: props },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta).toMatchObject({
      total: 350,
      shown: 200,
      truncated: true,
      totalState: "exact",
      failed: [],
    });
  });

  it("is not truncated when counts match what was returned", async () => {
    const { client } = fakeSupabase({
      properties: (calls) =>
        isHead(calls)
          ? { data: [{ id: "p1" }] }
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

  describe("alert delivery status", () => {
    const flagged = (id: string) => ({
      id,
      last_ai_escalation_at: iso("01:00:00"),
      last_ai_escalation_reason: "draft_held",
      updated_at: iso("01:00:00"),
    });
    const withDeliveries = (rows: unknown[] | null, error?: unknown) =>
      fakeSupabase({
        properties: (calls) =>
          isHead(calls) ? { data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } : { data: [flagged("p1"), flagged("p2"), flagged("p3")] },
        hold_alert_latest_status: () => (error ? { data: null, error } : { data: rows }),
      });

    it("attaches the latest delivery status per property, newest wins", async () => {
      const { client, queries, rpcCalls } = withDeliveries([
        { property_id: "p1", status: "skipped", last_error: "no_token", created_at: iso("02:00:00") },
        { property_id: "p1", status: "sent", last_error: null, created_at: iso("01:00:00") },
        { property_id: "p2", status: "failed", last_error: "interrupted", created_at: iso("02:00:00") },
      ]);
      const data = await loadMessagesV2Data(client, "org");
      const byId = Object.fromEntries(data.holds.map((h) => [h.id, h.alert]));
      expect(byId.p1).toEqual({ status: "skipped", reason: "no_token" });
      expect(byId.p2).toEqual({ status: "failed", reason: "interrupted" });
      expect(byId.p3).toBeUndefined();
      expect(rpcCalls).toContainEqual({
        fn: "hold_alert_latest_status",
        args: { p_org_id: "org", p_property_ids: ["p1", "p2", "p3"] },
      });
      expect(queries.some((c) => c[0]?.table === "hold_alert_deliveries")).toBe(false);
    });

    it("looks up each chunk of properties separately, so one noisy property cannot hide another's status", async () => {
      const many = Array.from({ length: 450 }, (_, i) => `p${i}`);
      const { client, rpcCalls } = fakeSupabase({
        properties: (calls) =>
          isHead(calls) ? { data: many.map((id) => ({ id })) } : { data: many.map(flagged) },
        hold_alert_latest_status: () => ({ data: [] }),
      });
      await loadMessagesV2Data(client, "org");
      const lookups = rpcCalls.filter((c) => c.fn === "hold_alert_latest_status");
      expect(lookups.map((c) => (c.args.p_property_ids as string[]).length)).toEqual([200, 200, 50]);
      expect(lookups.flatMap((c) => c.args.p_property_ids as string[]).sort()).toEqual([...many].sort());
    });

    it("reports a failed delivery lookup as a context error instead of hiding it", async () => {
      const { client } = withDeliveries(null, { message: "boom" });
      const data = await loadMessagesV2Data(client, "org");
      expect(data.holdsMeta.contextErrors).toContain("alert status");
      expect(data.holds.every((h) => h.alert === undefined)).toBe(true);
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
    expect(
      rpcCalls.map((c) => c.fn).filter((f) => f === "pipeline_runs_latest_for_properties"),
    ).toEqual(Array(3).fill("pipeline_runs_latest_for_properties"));
    const runRpcs = rpcCalls.filter((c) => c.fn === "pipeline_runs_latest_for_properties");
    expect(runRpcs.map((c) => (c.args.p_property_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(runRpcs[0].args.p_org_id).toBe("org");
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

  it("makes a pending ai_reply_drafts row a hold of its own and never reads the body", async () => {
    const { client, queries } = fakeSupabase({
      ai_reply_drafts: () => ({
        data: [
          {
            id: "d1",
            property_id: "p9",
            conversation_id: null,
            inbound_message_id: null,
            run_id: null,
            created_at: iso("03:00:00"),
          },
        ],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holds).toHaveLength(1);
    expect(data.holds[0]).toMatchObject({
      property_id: "p9",
      sources: ["pending_draft"],
      draft_held: true,
    });
    const draftQ = queries.find(
      (q) => q[0]?.table === "ai_reply_drafts" && !isHead(q),
    )!;
    const cols = String(draftQ.find((c) => c.method === "select")!.args[0]);
    expect(cols).not.toMatch(/body/);
  });

  it("surfaces a failed drafts query as 'draft status unavailable', not as no drafts", async () => {
    const { client } = fakeSupabase({
      ai_reply_drafts: () => ({ data: null, error: { message: "x" } }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta.failed).toEqual(["pending_draft"]);
  });

  it("surfaces a failed feed window query as feedError, not an empty feed", async () => {
    const { client } = fakeSupabase({
      pipeline_runs: (calls) =>
        calls.some((c) => c.method === "limit" && c.args[0] === 200)
          ? { data: null, error: { message: "timeout" } }
          : {},
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.feedError).toBe("Feed unavailable — timeout");
    expect(data.runs).toEqual([]);
  });

  it("flags a failed count query as total unavailable while keeping the list", async () => {
    const { client } = fakeSupabase({
      properties: (calls) =>
        isHead(calls)
          ? { data: null, error: { message: "x" } }
          : {
              data: [
                {
                  id: "p1",
                  last_ai_escalation_at: iso("01:00:00"),
                  last_ai_escalation_reason: null,
                  updated_at: null,
                },
              ],
            },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holdsMeta).toMatchObject({
      totalState: "unavailable",
      shown: 1,
    });
    expect(data.holdsMeta.failed).toEqual([]);
  });

  it("flags a failed step lookup", async () => {
    const { client } = fakeSupabase({
      pipeline_runs: (calls) =>
        calls.some((c) => c.method === "limit")
          ? { data: [run({ id: "r1" })] }
          : {},
      pipeline_run_steps: () => ({ data: null, error: { message: "x" } }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.stepsUnavailable).toBe(true);
  });

  it("flags failed config/threshold queries and never retries without automation_enabled", async () => {
    const { client, queries } = fakeSupabase({
      jev_outcome_thresholds: () => ({
        data: null,
        error: { message: "column does not exist" },
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.badgesError).toMatch(/Mode badges unavailable/);
    expect(data.badges).toEqual([]);
    expect(
      queries.filter((q) => q[0]?.table === "jev_outcome_thresholds"),
    ).toHaveLength(1);
    const cfg = await loadMessagesV2Data(
      fakeSupabase({
        ai_responder_configs: () => ({ data: null, error: { message: "x" } }),
      }).client,
      "org",
    );
    expect(cfg.badgesError).toMatch(/Mode badges unavailable/);
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

describe("deriveOpenHolds pending drafts", () => {
  const draft = (
    over: Partial<HoldDraftRow> & { id: string },
  ): HoldDraftRow => ({
    property_id: null,
    conversation_id: null,
    inbound_message_id: null,
    run_id: null,
    created_at: iso("05:00:00"),
    ...over,
  });
  it("opens a hold from a pending draft even when the flag is clear and a newer run exists", () => {
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [draft({ id: "d1", property_id: "p1" })],
      runs: [run({ id: "new", property_id: "p1", status: "replied" })],
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      property_id: "p1",
      sources: ["pending_draft"],
      draft_held: true,
      since: iso("05:00:00"),
    });
    expect(holds[0].run?.id).toBe("new");
  });
  it("merges with other sources for the same property and orders oldest first", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: iso("06:00:00"),
          last_ai_escalation_reason: null,
          updated_at: null,
        },
      ],
      decisions: [],
      reviews: [],
      drafts: [
        draft({ id: "d1", property_id: "p1" }),
        draft({ id: "d2", property_id: "p2", created_at: iso("01:00:00") }),
      ],
      runs: [],
    });
    expect(holds.map((h) => h.id)).toEqual(["p2", "p1"]);
    expect(holds[1].sources).toEqual(["needs_attention", "pending_draft"]);
    expect(holds[1].since).toBe(iso("05:00:00"));
  });
  it("resolves a property-less draft through its run, else keeps it as its own hold", () => {
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [
        draft({ id: "d1", run_id: "r1" }),
        draft({ id: "d2", created_at: iso("06:00:00") }),
      ],
      runs: [run({ id: "r1", property_id: "p7" })],
    });
    expect(holds.map((h) => h.id)).toEqual(["p7", "draft:d2"]);
    expect(holds[1].property_id).toBeNull();
  });
});

describe("buildHoldsMeta / formatHoldsTotal", () => {
  const src = (
    source: "needs_attention" | "jev_decision",
    ids: string[] | null,
    failed = false,
  ) => ({ source, ids, failed });
  it("counts distinct properties across sources, not the largest source", () => {
    const m = buildHoldsMeta({
      shown: 2,
      sources: [
        src("needs_attention", ["a", "b"]),
        src("jev_decision", ["b", "c"]),
      ],
    });
    expect(m).toMatchObject({ total: 3, totalState: "exact", truncated: true });
  });
  it("reports 2,000+ (incomplete) above the cap", () => {
    const ids = Array.from({ length: HOLDS_COUNT_CAP + 1 }, (_, i) => `p${i}`);
    const m = buildHoldsMeta({
      shown: 5,
      sources: [src("needs_attention", ids)],
    });
    expect(m).toMatchObject({ totalState: "capped", truncated: true });
    expect(formatHoldsTotal(m, 5)).toBe("2,000+ holds (incomplete)");
  });
  it("reports count unavailable when a count query failed", () => {
    const m = buildHoldsMeta({
      shown: 1,
      sources: [src("needs_attention", null)],
    });
    expect(m.totalState).toBe("unavailable");
    expect(formatHoldsTotal(m, 1)).toBe("holds count unavailable");
  });
  it("reports holds unavailable when a source failed", () => {
    const m = buildHoldsMeta({
      shown: 0,
      sources: [src("jev_decision", null, true)],
    });
    expect(formatHoldsTotal(m, 0)).toBe("holds unavailable");
  });
});

describe("buildModeBadges unknown automation flag", () => {
  it("shows UNKNOWN, never AUTO, when automation_enabled is absent", () => {
    const b = buildModeBadges(
      { classifier_provider: "jev", classifier_mode: "automatic" },
      [{ outcome: "x", min_confidence: 0.9 }],
    );
    expect(b[0].mode).toBe("UNKNOWN");
    expect(formatModeBadge(b[0])).toBe("UNKNOWN");
  });
});

describe("round 4: distinct-before-cap, failed drafts, dead letters", () => {
  const draftRow = (i: number) => ({
    id: `d${i}`,
    property_id: "p1",
    conversation_id: null,
    inbound_message_id: null,
    run_id: null,
    created_at: iso("03:00:00"),
  });
  it("2,001 pending drafts on one property is 1 hold, labeled incomplete, never '2,000+'", async () => {
    const rows = Array.from({ length: HOLDS_COUNT_CAP + 1 }, (_, i) => ({
      id: `d${i}`,
      property_id: "p1",
    }));
    const { client } = fakeSupabase({
      ai_reply_drafts: (calls) =>
        isHead(calls) ? { data: rows } : { data: [draftRow(0)] },
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holds).toHaveLength(1);
    expect(data.holdsMeta.totalState).toBe("incomplete");
    expect(data.holdsMeta.total).toBe(1);
    const label = formatHoldsTotal(data.holdsMeta, 1);
    expect(label).toBe("1+ holds (incomplete)");
    expect(label).not.toMatch(/2,000/);
  });
  it("applies the cap to DISTINCT properties", () => {
    const ids = Array.from({ length: HOLDS_COUNT_CAP + 1 }, (_, i) => `p${i}`);
    const m = buildHoldsMeta({
      shown: 5,
      sources: [{ source: "pending_draft", ids, failed: false }],
    });
    expect(m.totalState).toBe("capped");
  });
  it("a failed drafts query makes the total unavailable, never exact", () => {
    const m = buildHoldsMeta({
      shown: 0,
      sources: [
        { source: "needs_attention", ids: [], failed: false },
        { source: "pending_draft", ids: null, failed: true },
      ],
    });
    expect(m.totalState).toBe("unavailable");
    expect(m.failed).toEqual(["pending_draft"]);
    expect(formatHoldsTotal(m, 0)).toBe("holds count unavailable");
  });
  it("marks a hold whose run has a dead-letter row, selecting ids only", async () => {
    const { client, queries } = fakeSupabase({
      ai_reply_drafts: (calls) =>
        isHead(calls)
          ? {}
          : {
              data: [{ ...draftRow(0), run_id: "r1" }],
            },
      pipeline_runs_latest_for_properties: () => ({
        data: [run({ id: "r1", property_id: "p1" })],
      }),
      ai_reply_dead_letters: () => ({
        data: [{ id: "dl1", run_id: "r1", inbound_message_id: null }],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holds[0].dead_letter).toBe(true);
    expect(data.holdsMeta.deadLetterUnavailable).toBeFalsy();
    const q = queries.find((c) => c[0]?.table === "ai_reply_dead_letters")!;
    const cols = String(q.find((c) => c.method === "select")!.args[0]);
    expect(cols).not.toMatch(/body|text|reply/);
  });
  it("sent_late takes precedence over the original dead-letter row, reason only (no body)", async () => {
    const { client, queries } = fakeSupabase({
      ai_reply_drafts: (calls) =>
        isHead(calls) ? {} : { data: [{ ...draftRow(0), run_id: "r1" }] },
      pipeline_runs_latest_for_properties: () => ({
        data: [run({ id: "r1", property_id: "p1" })],
      }),
      ai_reply_dead_letters: () => ({
        data: [
          {
            id: "dl1",
            run_id: "r1",
            inbound_message_id: null,
            reason: "send_timeout",
          },
          {
            id: "dl2",
            run_id: "r1",
            inbound_message_id: null,
            reason: "sent_late",
          },
        ],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holds[0].dead_letter).toBe(true);
    expect(data.holds[0].dead_letter_late).toBe(true);
    const q = queries.find((c) => c[0]?.table === "ai_reply_dead_letters")!;
    const cols = String(q.find((c) => c.method === "select")!.args[0]);
    expect(cols).toMatch(/\breason\b/);
    expect(cols).not.toMatch(/body|text|reply/);
  });
  it("a hold spanning one late and one non-late inbound keeps both dead-letters", async () => {
    const { client } = fakeSupabase({
      ai_reply_drafts: (calls) =>
        isHead(calls)
          ? {}
          : {
              data: [
                { ...draftRow(0), run_id: "r1", inbound_message_id: "m1" },
                { ...draftRow(1), inbound_message_id: "m2" },
              ],
            },
      pipeline_runs_latest_for_properties: () => ({
        data: [run({ id: "r1", property_id: "p1", inbound_message_id: "m1" })],
      }),
      ai_reply_dead_letters: () => ({
        data: [
          {
            id: "a",
            run_id: "r1",
            inbound_message_id: "m1",
            reason: "send_timeout",
          },
          {
            id: "b",
            run_id: "r1",
            inbound_message_id: "m1",
            reason: "sent_late",
          },
          {
            id: "c",
            run_id: null,
            inbound_message_id: "m1",
            reason: "sent_late",
          },
          {
            id: "d",
            run_id: null,
            inbound_message_id: "m2",
            reason: "send_timeout",
          },
        ],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    const dls = data.holds[0].dead_letters ?? [];
    expect(dls.filter((d) => d.late)).toHaveLength(1);
    expect(dls.filter((d) => !d.late)).toHaveLength(1);
    expect(data.holds[0].dead_letter_late).toBe(true);
  });
  it("a non-late dead-letter reason does not set dead_letter_late", async () => {
    const { client } = fakeSupabase({
      ai_reply_drafts: (calls) =>
        isHead(calls) ? {} : { data: [{ ...draftRow(0), run_id: "r1" }] },
      pipeline_runs_latest_for_properties: () => ({
        data: [run({ id: "r1", property_id: "p1" })],
      }),
      ai_reply_dead_letters: () => ({
        data: [
          {
            id: "dl1",
            run_id: "r1",
            inbound_message_id: null,
            reason: "send_timeout",
          },
        ],
      }),
    });
    const data = await loadMessagesV2Data(client, "org");
    expect(data.holds[0].dead_letter).toBe(true);
    expect(data.holds[0].dead_letter_late).toBeFalsy();
  });
  it("treats a missing dead-letter table as none, but other errors as unavailable", async () => {
    const base = {
      ai_reply_drafts: (calls: Call) =>
        isHead(calls)
          ? {}
          : { data: [{ ...draftRow(0), inbound_message_id: "m1" }] },
    };
    const missing = fakeSupabase({
      ...base,
      ai_reply_dead_letters: () => ({
        data: null,
        error: { code: "42P01", message: 'relation "x" does not exist' },
      }),
    });
    const a = await loadMessagesV2Data(missing.client, "org");
    expect(a.holds[0].dead_letter).toBeFalsy();
    expect(a.holdsMeta.deadLetterUnavailable).toBeFalsy();
    const broken = fakeSupabase({
      ...base,
      ai_reply_dead_letters: () => ({
        data: null,
        error: { message: "permission denied" },
      }),
    });
    const b = await loadMessagesV2Data(broken.client, "org");
    expect(b.holdsMeta.deadLetterUnavailable).toBe(true);
  });
});

describe("Phase 1: pending draft exposed for the hold actions", () => {
  const draft = (over: Partial<HoldDraftRow> & { id: string }): HoldDraftRow => ({
    property_id: "p1",
    conversation_id: "c1",
    inbound_message_id: "m1",
    run_id: null,
    created_at: iso("05:00:00"),
    ...over,
  });

  it("a hold carries its newest pending draft (id, inbound, body when loaded)", () => {
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [
        draft({ id: "old", created_at: iso("01:00:00"), body: "older", edited_body: null }),
        draft({ id: "new", created_at: iso("02:00:00"), body: "newer", edited_body: "edited" }),
      ],
      runs: [],
    });
    expect(holds[0]!.draft).toEqual({
      id: "new",
      inbound_message_id: "m1",
      body: "newer",
      edited_body: "edited",
    });
  });

  it("omits body fields when the loader did not select them", () => {
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [draft({ id: "d1" })],
      runs: [],
    });
    expect(holds[0]!.draft).toEqual({ id: "d1", inbound_message_id: "m1" });
  });

  it("includeDraftBody selects body and edited_body; the default never does", async () => {
    const rows = [
      {
        id: "d1",
        property_id: "p9",
        conversation_id: null,
        inbound_message_id: "m9",
        run_id: null,
        created_at: iso("03:00:00"),
        body: "hello",
        edited_body: null,
      },
    ];
    const withBody = fakeSupabase({ ai_reply_drafts: () => ({ data: rows }) });
    const data = await loadMessagesV2Data(withBody.client, "org", Date.now(), { includeDraftBody: true });
    expect(data.holds[0]!.draft).toMatchObject({ id: "d1", body: "hello" });
    const q = withBody.queries.find((c) => c[0]?.table === "ai_reply_drafts" && !isHead(c))!;
    expect(String(q.find((c) => c.method === "select")!.args[0])).toMatch(/body, edited_body/);

    const without = fakeSupabase({ ai_reply_drafts: () => ({ data: rows }) });
    await loadMessagesV2Data(without.client, "org");
    const q2 = without.queries.find((c) => c[0]?.table === "ai_reply_drafts" && !isHead(c))!;
    expect(String(q2.find((c) => c.method === "select")!.args[0])).not.toMatch(/body/);
  });
});

describe("deriveOpenHolds seen (the stale-click guard's view of the card)", () => {
  it("carries the newest pending row time (to the microsecond) and the flag the card displayed", () => {
    const holds = deriveOpenHolds({
      properties: [
        {
          id: "p1",
          last_ai_escalation_at: "2026-10-07T11:59:00.5+00:00",
          last_ai_escalation_reason: "draft_held",
          updated_at: null,
        },
      ],
      decisions: [
        { property_id: "p1", conversation_id: "c1", source_inbound_message_id: "m1", created_at: "2026-10-07T12:00:00.123456+00:00" },
      ],
      reviews: [
        { property_id: "p1", conversation_id: "c1", source_inbound_message_id: "m2", disposition: "dnc", created_at: "2026-10-07T12:00:00.123999+00:00" },
      ],
      drafts: [
        { id: "d1", property_id: "p1", conversation_id: "c1", inbound_message_id: "m1", run_id: null, created_at: "2026-10-07T11:00:00+00:00" },
      ],
      runs: [],
    });
    expect(holds[0]!.seen).toEqual({
      through: "2026-10-07T12:00:00.123999+00:00",
      flagReason: "draft_held",
      flagAt: "2026-10-07T11:59:00.5+00:00",
    });
  });

  it("has no flag fields when the hold is not flagged, and a null `through` when no rows are pending", () => {
    const unflagged = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [{ id: "d1", property_id: "p1", conversation_id: null, inbound_message_id: null, run_id: null, created_at: "2026-10-07T11:00:00+00:00" }],
      runs: [],
    });
    expect(unflagged[0]!.seen).toEqual({ through: "2026-10-07T11:00:00+00:00", flagReason: null, flagAt: null });
    const flagOnly = deriveOpenHolds({
      properties: [{ id: "p2", last_ai_escalation_at: null, last_ai_escalation_reason: "price_or_offer", updated_at: null }],
      decisions: [],
      reviews: [],
      runs: [],
    });
    expect(flagOnly[0]!.seen).toEqual({ through: null, flagReason: "price_or_offer", flagAt: null });
  });

  it("passes the draft's edit version through for Send / Edit", () => {
    const holds = deriveOpenHolds({
      properties: [],
      decisions: [],
      reviews: [],
      drafts: [
        { id: "d1", property_id: "p1", conversation_id: null, inbound_message_id: null, run_id: null, created_at: "2026-10-07T11:00:00+00:00", body: "b", edited_body: "e", edited_at: "2026-10-07T11:30:00+00:00" },
      ],
      runs: [],
    });
    expect(holds[0]!.draft).toMatchObject({ body: "b", edited_body: "e", edited_at: "2026-10-07T11:30:00+00:00" });
  });
});

describe("deriveOpenHolds alert_since (when the hold began, for alert eligibility)", () => {
  const prop = (over: Partial<{ id: string; since: string | null }> = {}) => ({
    id: over.id ?? "p1",
    last_ai_escalation_at: iso("01:00:00"),
    last_ai_escalation_reason: "needs_review",
    updated_at: iso("02:00:00"),
    needs_human_attention_since: over.since === undefined ? iso("09:00:00") : over.since,
  });
  const decision = (createdAt: string) => ({
    property_id: "p1",
    conversation_id: "c1",
    source_inbound_message_id: "m1",
    created_at: createdAt,
  });

  it("is the flag's tracked start, not last_ai_escalation_at or updated_at", () => {
    const [h] = deriveOpenHolds({ properties: [prop()], decisions: [], reviews: [], runs: [] });
    expect(h.alert_since).toBe(iso("09:00:00"));
  });

  it("is null for a flagged property with no tracked start (the backlog)", () => {
    const [h] = deriveOpenHolds({ properties: [prop({ since: null })], decisions: [], reviews: [], runs: [] });
    expect(h.alert_since).toBeNull();
  });

  it("backlog flag with only old pending activity: alert_since is that old activity (pre-watermark, silent)", () => {
    const [h] = deriveOpenHolds({
      properties: [prop({ since: null })],
      decisions: [decision(iso("03:00:00"))],
      reviews: [],
      runs: [],
    });
    expect(h.alert_since).toBe(iso("03:00:00"));
  });

  it("backlog flag with nothing reliable known is null", () => {
    const [h] = deriveOpenHolds({ properties: [prop({ since: null })], decisions: [], reviews: [], runs: [] });
    expect(h.alert_since).toBeNull();
  });

  it("backlog flag plus a newer pending decision starts at the decision", () => {
    const [h] = deriveOpenHolds({
      properties: [prop({ since: null })],
      decisions: [decision(iso("11:00:00"))],
      reviews: [],
      runs: [],
    });
    expect(h.alert_since).toBe(iso("11:00:00"));
  });

  it("backlog flag plus a seller message after the watermark starts at that message", () => {
    const [h] = deriveOpenHolds({
      properties: [prop({ since: null })],
      decisions: [],
      reviews: [],
      inboundAfter: new Map([["p1", iso("12:30:00")]]),
      runs: [],
    });
    expect(h.alert_since).toBe(iso("12:30:00"));
  });

  it("a flag raised after an old pending decision starts at the flag, not the older decision", () => {
    const [h] = deriveOpenHolds({
      properties: [prop({ since: iso("09:00:00") })],
      decisions: [decision(iso("08:00:00"))],
      reviews: [],
      runs: [],
    });
    expect(h.alert_since).toBe(iso("09:00:00"));
  });

  it("a flag raised after an old pending draft starts at the flag, not the older draft", () => {
    const [h] = deriveOpenHolds({
      properties: [prop({ since: iso("09:00:00") })],
      decisions: [],
      reviews: [],
      drafts: [
        { id: "d1", property_id: "p1", conversation_id: null, inbound_message_id: null, run_id: null, created_at: iso("02:00:00") },
      ],
      runs: [],
    });
    expect(h.alert_since).toBe(iso("09:00:00"));
  });

  it("is the decision's created_at for a hold with no flagged property", () => {
    const [h] = deriveOpenHolds({ properties: [], decisions: [decision(iso("11:00:00"))], reviews: [], runs: [] });
    expect(h.alert_since).toBe(iso("11:00:00"));
  });
});

describe("loadMessagesV2Data alertsSince (seller messages on backlog-flagged leads)", () => {
  const flagged = (id: string, since: string | null) => ({
    id,
    last_ai_escalation_at: iso("01:00:00"),
    last_ai_escalation_reason: "needs_review",
    updated_at: iso("01:00:00"),
    needs_human_attention_since: since,
  });
  const WM = iso("10:00:00");

  it("asks for inbound messages only for properties with an unknown flag start, at/after the watermark", async () => {
    const { client, queries } = fakeSupabase({
      properties: (c) => (isHead(c) ? { data: [] } : { data: [flagged("old", null), flagged("tracked", iso("11:00:00"))] }),
      messages: () => ({ data: [{ property_id: "old", created_at: iso("12:00:00") }] }),
    });
    const data = await loadMessagesV2Data(client, "org", undefined, { alertsSince: WM });
    const msgQueries = queries.filter((q) => q[0]?.table === "messages");
    expect(msgQueries).toHaveLength(1);
    const call = (q: Call, m: string) => q.find((c) => c.method === m)!.args;
    expect(call(msgQueries[0]!, "in")).toEqual(["property_id", ["old"]]);
    expect(call(msgQueries[0]!, "gte")).toEqual(["created_at", WM]);
    expect(msgQueries[0]!.some((c) => c.method === "eq" && c.args[0] === "direction" && c.args[1] === "inbound")).toBe(true);
    expect(data.holds.find((h) => h.id === "old")!.alert_since).toBe(iso("12:00:00"));
    expect(data.holds.find((h) => h.id === "tracked")!.alert_since).toBe(iso("11:00:00"));
  });

  it("makes no messages query without alertsSince (the page)", async () => {
    const { client, queries } = fakeSupabase({
      properties: (c) => (isHead(c) ? { data: [] } : { data: [flagged("old", null)] }),
    });
    await loadMessagesV2Data(client, "org");
    expect(queries.some((q) => q[0]?.table === "messages")).toBe(false);
  });

  it("a backlog lead with no seller message after the watermark stays unknown (silent)", async () => {
    const { client } = fakeSupabase({
      properties: (c) => (isHead(c) ? { data: [] } : { data: [flagged("old", null)] }),
    });
    const data = await loadMessagesV2Data(client, "org", undefined, { alertsSince: WM });
    expect(data.holds[0]!.alert_since).toBeNull();
  });
});
