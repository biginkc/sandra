import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterBlock } from "./prospects-query";

type RecordedQuery = {
  selectArg: string | null;
  calls: string[];
  rangeCalls: Array<[number, number]>;
  rows: unknown[];
};

const { createClientMock, recorded, resolveProspectEligibilityMock } = vi.hoisted(() => {
  const recorded: RecordedQuery = {
    selectArg: null,
    calls: [],
    rangeCalls: [],
    rows: [{ id: "p1" }],
  };

  const query = {
    select(arg: string) {
      recorded.selectArg = arg;
      recorded.calls.push(`select(${arg})`);
      return this;
    },
    is(column: string, value: unknown) {
      recorded.calls.push(`is(${column},${String(value)})`);
      return this;
    },
    eq(column: string, value: unknown) {
      recorded.calls.push(`eq(${column},${String(value)})`);
      return this;
    },
    or(value: string) {
      recorded.calls.push(`or(${value})`);
      return this;
    },
    ilike(column: string, value: string) {
      recorded.calls.push(`ilike(${column},${value})`);
      return this;
    },
    in(column: string, values: unknown[]) {
      recorded.calls.push(`in(${column},${JSON.stringify(values)})`);
      return this;
    },
    gte(column: string, value: unknown) {
      recorded.calls.push(`gte(${column},${String(value)})`);
      return this;
    },
    lt(column: string, value: unknown) {
      recorded.calls.push(`lt(${column},${String(value)})`);
      return this;
    },
    not(column: string, operator: string, value: unknown) {
      recorded.calls.push(`not(${column},${operator},${String(value)})`);
      return this;
    },
    range(from: number, to: number) {
      recorded.rangeCalls.push([from, to]);
      return Promise.resolve({ data: recorded.rows, error: null });
    },
  };

  return {
    recorded,
    resolveProspectEligibilityMock: vi.fn(async (_client, _ids: string[]) => {
      const eligibleIds = (recorded.rows as Array<{
        id: string;
        is_dnc_locked?: boolean;
      }>).filter((row) => !row.is_dnc_locked).map((row) => row.id);
      return {
        eligibleIds,
        exclusions: [],
        dncLockedCount: recorded.rows.length - eligibleIds.length,
        skipTraceDisabledCount: 0,
      };
    }),
    createClientMock: vi.fn(async () => ({
      from: vi.fn(() => query),
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));
vi.mock("@/lib/prospects/eligibility", () => ({
  resolveProspectEligibility: resolveProspectEligibilityMock,
}));

import { getAllMatchingProspectIds } from "./actions";

beforeEach(() => {
  createClientMock.mockClear();
  recorded.selectArg = null;
  recorded.calls.length = 0;
  recorded.rangeCalls.length = 0;
  recorded.rows = [{ id: "p1" }];
});

describe("getAllMatchingProspectIds", () => {
  it("selects embedded filter fragments before applying relationship-backed filters", async () => {
    const blockStack: FilterBlock[] = [
      {
        id: "tag-filter",
        kind: "tag",
        combinator: "any",
        values: ["tag-1"],
      },
      {
        id: "list-count-filter",
        kind: "list_count",
        range: { min: 1, max: null },
      },
    ];

    const result = await getAllMatchingProspectIds({
      search: "Main",
      blockStack,
    });

    expect(result.ok).toBe(true);
    expect(recorded.selectArg).toBe(
      "id, source_import_id, source_imported_at, tag_filter:property_tags!inner(tag_id), stack_filter:property_stack_counts!inner(stack_count)",
    );
    expect(recorded.calls).toContain('in(tag_filter.tag_id,["tag-1"])');
    expect(recorded.calls).toContain("gte(stack_filter.stack_count,1)");
    expect(recorded.rangeCalls).toEqual([[0, 999]]);
  });

  it("excludes an advanced permanent-DNC row from the server-owned ID set", async () => {
    recorded.rows = [
      {
        id: "locked",
        status: "closed",
        is_dnc_locked: true,
      },
      {
        id: "eligible",
        status: "prospect",
        is_dnc_locked: false,
      },
    ];

    const result = await getAllMatchingProspectIds({ search: null, blockStack: [] });
    expect(result).toEqual({ ok: true, data: ["eligible"] });
    expect(recorded.calls).toContain("or(status.eq.prospect,is_dnc_locked.eq.true)");
  });

  it("keeps Imported Today scoped to the latest reviewed import timestamp", async () => {
    const result = await getAllMatchingProspectIds({
      search: null,
      blockStack: [],
      imported: "today",
    });

    expect(result.ok).toBe(true);
    expect(recorded.calls).toContain("not(source_import_id,is,null)");
    expect(recorded.calls.some((call) => call.startsWith("gte(source_imported_at,"))).toBe(true);
    expect(recorded.calls.some((call) => call.startsWith("lt(source_imported_at,"))).toBe(true);
    expect(recorded.calls.some((call) => call.startsWith("gte(created_at,"))).toBe(false);
  });
});
