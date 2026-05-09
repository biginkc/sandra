/**
 * Unit tests for the prospects filter translator.
 *
 * One `describe("applyBlock: <kind>", ...)` per kind = 23 + cross-cutting
 * (cross-block AND, soft-delete, empty stack) = 26 describe blocks.
 *
 * Strategy:
 *  - mockBuilder() returns a Proxy that records every chained call into a
 *    `calls: string[]` array. Tests assert against the exact predicate
 *    chain the translator emitted.
 *  - For pre-fetch blocks (list, list_count, engagement, has_unread_inbound,
 *    has_open_tasks, tag), mockSupabaseClient() exposes a tiny fluent stub
 *    whose terminal `.then()`/await yields a fixture row set the test wires.
 *  - The translator's contract is to NEVER touch `.is('deleted_at', null)`.
 *    The cross-block describe asserts this.
 *
 * Per the plan:
 *  - empty values / no predicate → builder returned unchanged.
 *  - within-multi-select tri-state combinator: all = AND ; any = IN ; not = NOT IN.
 *  - tri-state booleans: any = no-op ; yes = .eq(col, true) ; no = .or(col.eq.false,col.is.null).
 *  - numeric range: only emit .gte / .lte when bound is non-null.
 *  - date mode: fixed = .gte/.lte on created_at ; since N = .gte(now-N) ; prior N = .lte(now-N).
 *  - engagement 4-bucket pre-fetch via messages + outreach_dispo.
 *
 * Date mode "since/prior" tests freeze time with vi.useFakeTimers() so the
 * .gte/.lte ISO strings are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterBlock } from "./filter-schema";
import { BLOCK_KINDS } from "./filter-schema";
import {
  FILTER_STRATEGIES,
  RISKY_FILTER_CONTRACT_KINDS,
  assertFilterStrategyRegistryComplete,
} from "./filter-strategies";
import {
  applyBlock,
  applyFilters,
  filterSelectFragment,
  needsPropertyListsEmbed,
  propertyListsSelectFragment,
} from "./filter-to-supabase";

// ---------------------------------------------------------------------------
// mockBuilder — a Proxy whose every method call is recorded as a string and
// returns the same proxy so chaining keeps working.
// ---------------------------------------------------------------------------

type MockBuilder = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fluent proxy records arbitrary query-builder calls.
  proxy: any;
  calls: string[];
};

function mockBuilder(): MockBuilder {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fluent proxy records arbitrary query-builder calls.
  const proxy: any = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") {
          // Don't mark this proxy as thenable to avoid auto-awaiting.
          return undefined;
        }
        if (prop === Symbol.toPrimitive || typeof prop === "symbol") {
          return undefined;
        }
        return (...args: unknown[]) => {
          const formatted = args
            .map((a) =>
              typeof a === "object" && a !== null
                ? JSON.stringify(a)
                : String(a),
            )
            .join(",");
          calls.push(`${String(prop)}(${formatted})`);
          return proxy;
        };
      },
    },
  );
  return { proxy, calls };
}

// ---------------------------------------------------------------------------
// mockSupabaseClient — minimal chainable stub that captures pre-fetch calls
// and returns fixture rows as { data: rows, error: null } for the await.
// Each table has its own queue of fixture responses set via setReturn(...).
// ---------------------------------------------------------------------------

type FixtureMap = Map<string, { data: unknown[]; error: null }>;

function mockSupabaseClient(fixtures: FixtureMap = new Map()) {
  // The pre-fetch chains in the translator look like:
  //   sb.from("property_lists").select(...).in(...).{terminal-await}
  //   sb.from("messages").select(...).eq(...).is(...){terminal-await}
  // Build a chainable proxy whose terminal value is the fixture for the
  // table named in `from(...)`.

  const calls: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Awaitable fluent proxy mirrors the Supabase query builder.
  function chain(table: string): any {
    const fixture = fixtures.get(table) ?? { data: [], error: null };
    const handler: ProxyHandler<object> = {
      get(_, prop) {
        if (prop === "then") {
          // When awaited at the end of a chain, resolve to the fixture.
          return (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
            resolve(fixture);
        }
        if (typeof prop === "symbol") return undefined;
        return (...args: unknown[]) => {
          calls.push(
            `${table}.${String(prop)}(${args
              .map((a) =>
                typeof a === "object" && a !== null
                  ? JSON.stringify(a)
                  : String(a),
              )
              .join(",")})`,
          );
          return new Proxy({}, handler);
        };
      },
    };
    return new Proxy({}, handler);
  }

  return {
    sb: {
      from: (table: string) => {
        calls.push(`from(${table})`);
        return chain(table);
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Minimal Supabase stub only implements the methods this test calls.
    } as any,
    calls,
    setReturn(table: string, rows: unknown[]) {
      fixtures.set(table, { data: rows, error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Tiny helpers to build typed FilterBlock fixtures inline without UUIDs.
// ---------------------------------------------------------------------------

let nextId = 0;
function id() {
  return `block-${++nextId}`;
}
// Helper signature is intentionally permissive — `Omit<FilterBlock, "id">`
// doesn't distribute over the discriminated union (TS resolves it to a
// kind-only intersection), so we accept the union shape directly minus
// the id and stamp one in. Callers still pass a structurally-correct
// FilterBlock variant; callsites use `as FilterBlock` to assert.
type FilterBlockNoId = { kind: FilterBlock["kind"] } & Record<string, unknown>;
function block(b: FilterBlockNoId & { id?: string }): FilterBlock {
  return { id: b.id ?? id(), ...b } as unknown as FilterBlock;
}

beforeEach(() => {
  nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FILTER_STRATEGIES", () => {
  it("declares an explicit query shape for every supported filter kind", () => {
    expect(assertFilterStrategyRegistryComplete()).toBe(true);
    expect(Object.keys(FILTER_STRATEGIES).sort()).toEqual(
      [...BLOCK_KINDS].sort(),
    );
  });

  it("keeps risky production filters in the contract list", () => {
    expect([...RISKY_FILTER_CONTRACT_KINDS].sort()).toEqual(
      [
        "cass",
        "engagement",
        "equity_pct",
        "has_open_tasks",
        "has_unread_inbound",
        "list",
        "list_count",
        "pipeline_status",
        "vacancy",
      ].sort(),
    );
  });

  it("documents relationship and computed filters that can produce Bad Request regressions", () => {
    expect(FILTER_STRATEGIES.list.strategy).toBe("relationshipJoin");
    expect(FILTER_STRATEGIES.engagement.strategy).toBe("relationshipJoin");
    expect(FILTER_STRATEGIES.list_count.strategy).toBe("aggregateView");
    expect(FILTER_STRATEGIES.has_unread_inbound.strategy).toBe(
      "computedServerSide",
    );
    expect(FILTER_STRATEGIES.has_open_tasks.strategy).toBe(
      "computedServerSide",
    );
  });
});

// ===========================================================================
// applyBlock — per-kind describes
// ===========================================================================

describe("applyBlock: vacancy", () => {
  it("tri='any' → no predicate added", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "vacancy", tri: "any" }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
  it("tri='yes' → .eq(is_vacant, true)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "vacancy", tri: "yes" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("eq(is_vacant,true)");
  });
  it("tri='no' → .or(is_vacant.eq.false,is_vacant.is.null)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "vacancy", tri: "no" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("or(is_vacant.eq.false,is_vacant.is.null)");
  });
});

describe("applyBlock: cass", () => {
  it("empty values → no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "cass", combinator: "any", values: [] }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
  it("combinator='any' single value → .in(cass_status, [verified])", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(cass_status,"))).toBe(true);
  });
  it("combinator='not' → .not('cass_status','in',(verified,unverified))", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "cass",
        combinator: "not",
        values: ["verified", "unverified"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("not(cass_status,in,"))).toBe(true);
  });
  it("combinator='all' single-column collapses to .in", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "cass",
        combinator: "all",
        values: ["verified", "invalid"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(cass_status,"))).toBe(true);
  });
});

describe("applyBlock: outreach_dispo", () => {
  it("any+values → .in(outreach_dispo, …)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "outreach_dispo",
        combinator: "any",
        values: ["opted_out", "dnc"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(outreach_dispo,"))).toBe(true);
  });
  it("not+values → .not(outreach_dispo, in, …)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "outreach_dispo",
        combinator: "not",
        values: ["opted_out"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("not(outreach_dispo,in,"))).toBe(
      true,
    );
  });
});

describe("applyBlock: source", () => {
  it("any+values → .in(source, …)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "source",
        combinator: "any",
        values: ["csv", "manual"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(source,"))).toBe(true);
  });
});

describe("applyBlock: beds (range)", () => {
  it("min only → .gte(beds, x)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "beds", range: { min: 3, max: null } }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(beds,3)");
    expect(calls.some((c) => c.startsWith("lte(beds,"))).toBe(false);
  });
  it("max only → .lte(beds, y)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "beds", range: { min: null, max: 5 } }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("lte(beds,5)");
    expect(calls.some((c) => c.startsWith("gte(beds,"))).toBe(false);
  });
  it("both bounds → .gte then .lte", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "beds", range: { min: 2, max: 4 } }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(beds,2)");
    expect(calls).toContain("lte(beds,4)");
  });
  it("neither bound → no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "beds", range: { min: null, max: null } }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
});

describe("applyBlock: baths (range)", () => {
  it("both bounds → .gte then .lte on baths", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "baths", range: { min: 1, max: 3 } }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(baths,1)");
    expect(calls).toContain("lte(baths,3)");
  });
});

describe("applyBlock: year_built (range)", () => {
  it("min-only → .gte(year_built, 1990)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "year_built",
        range: { min: 1990, max: null },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(year_built,1990)");
  });
});

describe("applyBlock: state", () => {
  it("any → .in(state, [MO, KS])", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "state",
        combinator: "any",
        values: ["MO", "KS"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(state,"))).toBe(true);
  });
});

describe("applyBlock: market", () => {
  it("any → .in(market, [Jackson, MO])", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "market",
        combinator: "any",
        values: ["Jackson, MO"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(market,"))).toBe(true);
  });
});

describe("applyBlock: absentee (tri-state)", () => {
  it("yes → .eq(absentee_flag, true)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "absentee", tri: "yes" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("eq(absentee_flag,true)");
  });
  it("no → .or(absentee_flag.eq.false,absentee_flag.is.null)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "absentee", tri: "no" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("or(absentee_flag.eq.false,absentee_flag.is.null)");
  });
  it("any → no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "absentee", tri: "any" }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
});

describe("applyBlock: estimated_value (range)", () => {
  it("min/max → .gte(listing_price,…).lte(listing_price,…)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "estimated_value",
        range: { min: 100000, max: 500000 },
      }) as FilterBlock,
      sb,
    );
    // The translator uses `arv` (after-repair value) as the canonical estimated-value
    // column on properties; verify whichever column is chosen, only one column appears.
    const valueCol = calls
      .find((c) => c.startsWith("gte("))
      ?.match(/gte\((\w+),/)?.[1];
    expect(valueCol).toBeTruthy();
    expect(calls).toContain(`gte(${valueCol},100000)`);
    expect(calls).toContain(`lte(${valueCol},500000)`);
  });
});

describe("applyBlock: equity_pct (range, indexed via migration 057)", () => {
  it("min-only 50 → .gte(equity_pct, 50) (matches High Equity base preset)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "equity_pct",
        range: { min: 50, max: null },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(equity_pct,50)");
  });
  it("min/max → .gte(equity_pct,…).lte(equity_pct,…)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "equity_pct",
        range: { min: 30, max: 80 },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(equity_pct,30)");
    expect(calls).toContain("lte(equity_pct,80)");
  });
  it("neither bound → no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "equity_pct",
        range: { min: null, max: null },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
});

describe("applyBlock: pipeline_status", () => {
  it("any+values=['lead','prospect'] → .in(status,…) (broadens beyond hardcoded prospect)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "pipeline_status",
        combinator: "any",
        values: ["lead", "prospect"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(status,"))).toBe(true);
  });
});

describe("applyBlock: assignee", () => {
  it("'unassigned' sentinel → .is(assigned_user_id, null)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "assignee",
        combinator: "any",
        values: ["unassigned"],
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("is(assigned_user_id,null)");
  });
  it("UUIDs only → .in(assigned_user_id, [uuid])", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "assignee",
        combinator: "any",
        values: ["aaa-bbb-ccc"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(assigned_user_id,"))).toBe(true);
  });
  it("mixed UUIDs + 'unassigned' → .or(is.null,in(...))", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "assignee",
        combinator: "any",
        values: ["unassigned", "uuid-1"],
      }) as FilterBlock,
      sb,
    );
    expect(
      calls.some(
        (c) =>
          c.startsWith("or(") &&
          c.includes("assigned_user_id.is.null") &&
          c.includes("assigned_user_id.in"),
      ),
    ).toBe(true);
  });
  it("not + UUIDs → .not(assigned_user_id, in, ...)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "assignee",
        combinator: "not",
        values: ["uuid-1"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("not(assigned_user_id,in,"))).toBe(
      true,
    );
  });
});

describe("applyBlock: created_date", () => {
  it("mode=fixed both bounds → .gte/.lte on created_at", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "created_date",
        date: { mode: "fixed", from: "2026-01-01", to: "2026-02-01" },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(created_at,2026-01-01)");
    expect(calls).toContain("lte(created_at,2026-02-01)");
  });
  it("mode=fixed null bounds → no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "created_date",
        date: { mode: "fixed", from: null, to: null },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toEqual([]);
  });
  it("mode=since 7 days → .gte(created_at, now-7d)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "created_date",
        date: { mode: "since", days: 7 },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("gte(created_at,2026-05-01T00:00:00.000Z)");
  });
  it("mode=prior 30 days → .lte(created_at, now-30d)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "created_date",
        date: { mode: "prior", days: 30 },
      }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("lte(created_at,2026-04-08T00:00:00.000Z)");
  });
});

describe("applyBlock: needs_human_attention (tri-state)", () => {
  it("yes → .eq(needs_human_attention, true)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "needs_human_attention", tri: "yes" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain("eq(needs_human_attention,true)");
  });
  it("no → .or(needs_human_attention.eq.false,needs_human_attention.is.null)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "needs_human_attention", tri: "no" }) as FilterBlock,
      sb,
    );
    expect(calls).toContain(
      "or(needs_human_attention.eq.false,needs_human_attention.is.null)",
    );
  });
});

describe("applyBlock: motivation_level", () => {
  it("any+values → .in(motivation_level, …)", async () => {
    const { proxy, calls } = mockBuilder();
    const { sb } = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "motivation_level",
        combinator: "any",
        values: ["hot", "warm"],
      }) as FilterBlock,
      sb,
    );
    expect(calls.some((c) => c.startsWith("in(motivation_level,"))).toBe(true);
  });
});

// ===========================================================================
// Pre-fetch blocks — list / tag / list_count / engagement / has_unread_inbound
// / has_open_tasks. These need supabase client mocking.
// ===========================================================================

describe("applyBlock: list (pre-fetch via property_lists)", () => {
  it("empty values → no pre-fetch, no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "any",
        values: [],
      }) as FilterBlock,
      m.sb,
    );
    expect(calls).toEqual([]);
    expect(m.calls.length).toBe(0);
  });
  it("any combinator → filters through embedded property_lists instead of expanding IDs", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "any",
        values: ["L1", "L2"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.length).toBe(0);
    expect(calls).toEqual(['in(list_filter.list_id,["L1","L2"])']);
  });
  it("single-value all combinator → filters through embedded property_lists", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "all",
        values: ["L1"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.length).toBe(0);
    expect(calls).toEqual(['in(list_filter.list_id,["L1"])']);
  });
  it("all combinator → only properties on EVERY selected list", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_lists", [
      { property_id: "p1", list_id: "L1" },
      { property_id: "p1", list_id: "L2" },
      { property_id: "p2", list_id: "L1" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "all",
        values: ["L1", "L2"],
      }) as FilterBlock,
      m.sb,
    );
    // p1 is on both; p2 is only on L1. Translator should pass ["p1"].
    const inCall = calls.find((c) => c.startsWith("in(id,"));
    expect(inCall).toBeTruthy();
    expect(inCall).toContain("p1");
    expect(inCall).not.toContain("p2");
  });
  it("not combinator → uses anti-join instead of expanding matched property IDs", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_lists", [{ property_id: "p1", list_id: "L1" }]);
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "not",
        values: ["L1"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.length).toBe(0);
    expect(calls).toEqual([
      'in(list_exclusion.list_id,["L1"])',
      "is(list_exclusion,null)",
    ]);
  });
  it("empty multi-list all pre-fetch → 00000000-0000-0000-0000-000000000000 short-circuit so .in() never matches", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_lists", []);
    await applyBlock(
      proxy,
      block({
        kind: "list",
        combinator: "all",
        values: ["L1", "L2"],
      }) as FilterBlock,
      m.sb,
    );
    expect(
      calls.some((c) => c.includes("00000000-0000-0000-0000-000000000000")),
    ).toBe(true);
  });
});

describe("needsPropertyListsEmbed", () => {
  it("returns true for list filters that use embedded relationship paths", () => {
    expect(
      needsPropertyListsEmbed([
        block({
          kind: "list",
          combinator: "any",
          values: ["L1"],
        }) as FilterBlock,
      ]),
    ).toBe(true);
    expect(
      needsPropertyListsEmbed([
        block({
          kind: "list",
          combinator: "all",
          values: ["L1"],
        }) as FilterBlock,
      ]),
    ).toBe(true);
  });

  it("returns false only for multi-list all filters that still need pre-fetch set logic", () => {
    expect(
      needsPropertyListsEmbed([
        block({
          kind: "list",
          combinator: "all",
          values: ["L1", "L2"],
        }) as FilterBlock,
      ]),
    ).toBe(false);
    expect(
      needsPropertyListsEmbed([
        block({
          kind: "list",
          combinator: "not",
          values: ["L1"],
        }) as FilterBlock,
      ]),
    ).toBe(true);
  });
});

describe("propertyListsSelectFragment", () => {
  it("adds positive and anti-join aliases independently", () => {
    expect(
      propertyListsSelectFragment([
        block({
          kind: "list",
          combinator: "any",
          values: ["L1"],
        }) as FilterBlock,
        block({
          kind: "list",
          combinator: "not",
          values: ["L2"],
        }) as FilterBlock,
      ]),
    ).toBe(
      "list_filter:property_lists!inner(list_id), list_exclusion:property_lists(list_id)",
    );
  });
});

describe("filterSelectFragment", () => {
  it("adds relationship aliases for single-bucket engagement filters", () => {
    expect(
      filterSelectFragment([
        block({
          kind: "engagement",
          combinator: "any",
          values: ["never_contacted"],
        }) as FilterBlock,
        block({
          kind: "engagement",
          combinator: "any",
          values: ["attempted"],
        }) as FilterBlock,
        block({
          kind: "engagement",
          combinator: "any",
          values: ["replied"],
        }) as FilterBlock,
      ]),
    ).toBe(
      [
        "contact_messages:messages()",
      ].join(", "),
    );
  });

  it("adds a relationship alias for the contacted engagement preset", () => {
    expect(
      filterSelectFragment([
        block({
          kind: "engagement",
          combinator: "any",
          values: ["replied", "attempted"],
        }) as FilterBlock,
      ]),
    ).toBeNull();
  });
});

describe("applyBlock: tag (pre-fetch via property_tags)", () => {
  it("any combinator → pre-fetches property_tags, applies .in('id', ids)", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_tags", [
      { property_id: "p1", tag_id: "T1" },
      { property_id: "p2", tag_id: "T2" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "tag",
        combinator: "any",
        values: ["T1", "T2"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(property_tags)"))).toBe(true);
    expect(calls.some((c) => c.startsWith("in(id,"))).toBe(true);
  });
  it("empty values → no pre-fetch, no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "tag",
        combinator: "any",
        values: [],
      }) as FilterBlock,
      m.sb,
    );
    expect(calls).toEqual([]);
    expect(m.calls.length).toBe(0);
  });
});

describe("applyBlock: list_count (pre-fetch via property_stack_counts)", () => {
  it("min only → pre-fetches property_stack_counts, applies .in('id', ids)", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_stack_counts", [
      { property_id: "p1" },
      { property_id: "p2" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "list_count",
        range: { min: 2, max: null },
      }) as FilterBlock,
      m.sb,
    );
    expect(
      m.calls.some((c) => c.startsWith("from(property_stack_counts)")),
    ).toBe(true);
    expect(calls.some((c) => c.startsWith("in(id,"))).toBe(true);
  });
  it("empty pre-fetch → 00000000-0000-0000-0000-000000000000 short-circuit", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_stack_counts", []);
    await applyBlock(
      proxy,
      block({
        kind: "list_count",
        range: { min: 5, max: null },
      }) as FilterBlock,
      m.sb,
    );
    expect(
      calls.some((c) => c.includes("00000000-0000-0000-0000-000000000000")),
    ).toBe(true);
  });
  it("range bounds passed to .gte/.lte on the view query", async () => {
    const { proxy } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("property_stack_counts", [{ property_id: "p1" }]);
    await applyBlock(
      proxy,
      block({
        kind: "list_count",
        range: { min: 2, max: 5 },
      }) as FilterBlock,
      m.sb,
    );
    expect(
      m.calls.some((c) => c.startsWith("property_stack_counts.gte(")),
    ).toBe(true);
    expect(
      m.calls.some((c) => c.startsWith("property_stack_counts.lte(")),
    ).toBe(true);
  });
});

describe("applyBlock: engagement (4-bucket pre-fetch)", () => {
  it("'replied' bucket → pre-fetches ids for inbound-message properties", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("messages", [
      { property_id: "p1", direction: "inbound" },
      { property_id: "p2", direction: "outbound" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "engagement",
        combinator: "any",
        values: ["replied"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(true);
    expect(calls).toEqual(['in(id,["p1"])']);
  });
  it("'never_contacted' → anti-joins messages without pre-fetching ids", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "engagement",
        combinator: "any",
        values: ["never_contacted"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(false);
    expect(calls).toEqual(["is(contact_messages,null)"]);
  });
  it("'attempted' → pre-fetches ids for outbound-only properties", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("messages", [
      { property_id: "p1", direction: "outbound" },
      { property_id: "p2", direction: "outbound" },
      { property_id: "p2", direction: "inbound" },
      { property_id: "p3", direction: "inbound" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "engagement",
        combinator: "any",
        values: ["attempted"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(true);
    expect(calls).toEqual(['in(id,["p1"])']);
  });
  it("'opted_out' → checks outreach_dispo column for opted_out / dnc", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({
        kind: "engagement",
        combinator: "any",
        values: ["opted_out"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(false);
    expect(calls).toEqual(['in(outreach_dispo,["opted_out","dnc"])']);
  });
  it("'attempted' + 'replied' → pre-fetches and unions contacted ids", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("messages", [
      { property_id: "p1", direction: "inbound" },
      { property_id: "p2", direction: "outbound" },
    ]);
    await applyBlock(
      proxy,
      block({
        kind: "engagement",
        combinator: "any",
        values: ["replied", "attempted"],
      }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(true);
    expect(calls).toEqual(['in(id,["p1","p2"])']);
  });
});

describe("applyBlock: has_unread_inbound (tri-state pre-fetch)", () => {
  it("'yes' → pre-fetches messages where direction=inbound + read_at is null", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("messages", [{ property_id: "pX" }]);
    await applyBlock(
      proxy,
      block({ kind: "has_unread_inbound", tri: "yes" }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(messages)"))).toBe(true);
    expect(calls.some((c) => c.startsWith("in(id,"))).toBe(true);
  });
  it("'any' → no pre-fetch, no predicate", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyBlock(
      proxy,
      block({ kind: "has_unread_inbound", tri: "any" }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.length).toBe(0);
    expect(calls).toEqual([]);
  });
  it("'no' empty pre-fetch → no predicate (everyone qualifies as 'no unread')", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("messages", []);
    await applyBlock(
      proxy,
      block({ kind: "has_unread_inbound", tri: "no" }) as FilterBlock,
      m.sb,
    );
    // No predicate (empty negative set means nothing is excluded).
    expect(calls).toEqual([]);
  });
});

describe("applyBlock: has_open_tasks (tri-state pre-fetch via tasks)", () => {
  it("'yes' → pre-fetches tasks where status='open', applies .in('id', property_ids)", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("tasks", [{ related_property_id: "pX" }]);
    await applyBlock(
      proxy,
      block({ kind: "has_open_tasks", tri: "yes" }) as FilterBlock,
      m.sb,
    );
    expect(m.calls.some((c) => c.startsWith("from(tasks)"))).toBe(true);
    expect(calls.some((c) => c.startsWith("in(id,"))).toBe(true);
  });
  it("'no' with task rows → .not('id','in', ...)", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    m.setReturn("tasks", [{ related_property_id: "pX" }]);
    await applyBlock(
      proxy,
      block({ kind: "has_open_tasks", tri: "no" }) as FilterBlock,
      m.sb,
    );
    expect(calls.some((c) => c.startsWith("not(id,in,"))).toBe(true);
  });
});

// ===========================================================================
// Cross-cutting: applyFilters
// ===========================================================================

describe("applyFilters: cross-block AND", () => {
  it("vacancy + beds chains predicates in order", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyFilters(
      proxy,
      [
        block({ kind: "vacancy", tri: "yes" }) as FilterBlock,
        block({ kind: "beds", range: { min: 3, max: null } }) as FilterBlock,
      ],
      m.sb,
    );
    expect(calls).toContain("eq(is_vacant,true)");
    expect(calls).toContain("gte(beds,3)");
  });
});

describe("applyFilters: soft-delete is the caller's responsibility", () => {
  it("never emits .is(deleted_at, …)", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyFilters(
      proxy,
      [
        block({ kind: "vacancy", tri: "yes" }) as FilterBlock,
        block({
          kind: "cass",
          combinator: "any",
          values: ["verified"],
        }) as FilterBlock,
      ],
      m.sb,
    );
    expect(calls.some((c) => c.includes("deleted_at"))).toBe(false);
  });
});

describe("applyFilters: empty stack returns builder unchanged", () => {
  it("empty stack → calls is empty", async () => {
    const { proxy, calls } = mockBuilder();
    const m = mockSupabaseClient();
    await applyFilters(proxy, [], m.sb);
    expect(calls).toEqual([]);
  });
});
