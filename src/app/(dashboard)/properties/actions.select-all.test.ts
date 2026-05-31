import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterBlock } from "./prospects-query";

type RecordedQuery = {
  selectArg: string | null;
  calls: string[];
  rangeCalls: Array<[number, number]>;
};

const { createClientMock, recorded } = vi.hoisted(() => {
  const recorded: RecordedQuery = {
    selectArg: null,
    calls: [],
    rangeCalls: [],
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
    range(from: number, to: number) {
      recorded.rangeCalls.push([from, to]);
      return Promise.resolve({ data: [{ id: "p1" }], error: null });
    },
  };

  return {
    recorded,
    createClientMock: vi.fn(async () => ({
      from: vi.fn(() => query),
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));

// eslint-disable-next-line import/first
import { getAllMatchingProspectIds } from "./actions";

beforeEach(() => {
  createClientMock.mockClear();
  recorded.selectArg = null;
  recorded.calls.length = 0;
  recorded.rangeCalls.length = 0;
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
      "id, tag_filter:property_tags!inner(tag_id), stack_filter:property_stack_counts!inner(stack_count)",
    );
    expect(recorded.calls).toContain('in(tag_filter.tag_id,["tag-1"])');
    expect(recorded.calls).toContain("gte(stack_filter.stack_count,1)");
    expect(recorded.rangeCalls).toEqual([[0, 999]]);
  });
});
