import { describe, it, expect } from "vitest";

import {
  buildTableHref,
  parseTableSearch,
  type SortDirection,
} from "./use-table-url-state";

const PROSPECTS_LIKE_CONFIG = {
  sortableColumns: ["address", "market", "created_at"] as const,
  defaultSort: "created_at",
  defaultDir: "desc" as SortDirection,
};

describe("parseTableSearch", () => {
  it("returns defaults when raw is empty", () => {
    expect(parseTableSearch({}, PROSPECTS_LIKE_CONFIG)).toEqual({
      page: 1,
      search: null,
      sort: "created_at",
      dir: "desc",
      filters: {},
    });
  });

  it("clamps invalid pages to 1 and truncates fractional", () => {
    expect(parseTableSearch({ page: "0" }, PROSPECTS_LIKE_CONFIG).page).toBe(1);
    expect(parseTableSearch({ page: "-3" }, PROSPECTS_LIKE_CONFIG).page).toBe(1);
    expect(parseTableSearch({ page: "nope" }, PROSPECTS_LIKE_CONFIG).page).toBe(1);
    expect(parseTableSearch({ page: "3.7" }, PROSPECTS_LIKE_CONFIG).page).toBe(3);
  });

  it("trims whitespace on search and collapses empty/whitespace to null", () => {
    expect(parseTableSearch({ search: "  hello  " }, PROSPECTS_LIKE_CONFIG).search).toBe("hello");
    expect(parseTableSearch({ search: "   " }, PROSPECTS_LIKE_CONFIG).search).toBeNull();
    expect(parseTableSearch({ search: "" }, PROSPECTS_LIKE_CONFIG).search).toBeNull();
  });

  it("whitelists sort columns; unknown values fall back to default", () => {
    expect(parseTableSearch({ sort: "address" }, PROSPECTS_LIKE_CONFIG).sort).toBe("address");
    expect(parseTableSearch({ sort: "market" }, PROSPECTS_LIKE_CONFIG).sort).toBe("market");
    expect(parseTableSearch({ sort: "password" }, PROSPECTS_LIKE_CONFIG).sort).toBe("created_at");
    expect(parseTableSearch({ sort: undefined }, PROSPECTS_LIKE_CONFIG).sort).toBe("created_at");
  });

  it("only accepts 'asc' for dir; everything else collapses to default", () => {
    expect(parseTableSearch({ dir: "asc" }, PROSPECTS_LIKE_CONFIG).dir).toBe("asc");
    expect(parseTableSearch({ dir: "desc" }, PROSPECTS_LIKE_CONFIG).dir).toBe("desc");
    expect(parseTableSearch({ dir: "nope" }, PROSPECTS_LIKE_CONFIG).dir).toBe("desc");
    // Honors a non-default config.defaultDir
    const ascDefault = { ...PROSPECTS_LIKE_CONFIG, defaultDir: "asc" as SortDirection };
    expect(parseTableSearch({}, ascDefault).dir).toBe("asc");
    expect(parseTableSearch({ dir: "wat" }, ascDefault).dir).toBe("asc");
  });

  it("handles array-style searchParams by taking the first value", () => {
    expect(parseTableSearch({ search: ["first", "second"] }, PROSPECTS_LIKE_CONFIG).search).toBe("first");
    expect(parseTableSearch({ sort: ["address", "market"] }, PROSPECTS_LIKE_CONFIG).sort).toBe("address");
  });

  it("calls config.parseFilters and merges into the .filters slot when provided", () => {
    type F = { archived: boolean };
    const config = {
      ...PROSPECTS_LIKE_CONFIG,
      parseFilters: (r: Record<string, string | string[] | undefined>): F => ({
        archived: r.archived === "1",
      }),
    };
    expect(parseTableSearch<F>({ archived: "1" }, config).filters).toEqual({ archived: true });
    expect(parseTableSearch<F>({}, config).filters).toEqual({ archived: false });
  });
});

describe("buildTableHref", () => {
  it("returns empty string when every value is default", () => {
    expect(buildTableHref({}, PROSPECTS_LIKE_CONFIG)).toBe("");
    expect(
      buildTableHref(
        { page: 1, search: null, sort: "created_at", dir: "desc" },
        PROSPECTS_LIKE_CONFIG,
      ),
    ).toBe("");
  });

  it("only includes non-default values", () => {
    expect(buildTableHref({ page: 2 }, PROSPECTS_LIKE_CONFIG)).toBe("?page=2");
    expect(buildTableHref({ search: "foo" }, PROSPECTS_LIKE_CONFIG)).toBe("?search=foo");
    expect(buildTableHref({ sort: "address" }, PROSPECTS_LIKE_CONFIG)).toBe("?sort=address");
    expect(buildTableHref({ dir: "asc" }, PROSPECTS_LIKE_CONFIG)).toBe("?dir=asc");
  });

  it("URL-encodes special characters in search", () => {
    expect(buildTableHref({ search: "Main St" }, PROSPECTS_LIKE_CONFIG)).toBe("?search=Main+St");
    expect(buildTableHref({ search: "Oak & Vine" }, PROSPECTS_LIKE_CONFIG)).toBe("?search=Oak+%26+Vine");
  });

  it("preserves multiple non-default fields together in stable order page→search→sort→dir", () => {
    expect(
      buildTableHref(
        { page: 2, search: "foo", sort: "address", dir: "asc" },
        PROSPECTS_LIKE_CONFIG,
      ),
    ).toBe("?page=2&search=foo&sort=address&dir=asc");
  });

  it("calls buildFilterParams AFTER the standard four params so filter params come last", () => {
    type F = { vacant: boolean };
    const config = {
      ...PROSPECTS_LIKE_CONFIG,
      buildFilterParams: (filters: Partial<F>, sp: URLSearchParams) => {
        if (filters.vacant) sp.set("vacant", "1");
      },
    };
    expect(
      buildTableHref<F>(
        { page: 2, sort: "address", dir: "asc", filters: { vacant: true } },
        config,
      ),
    ).toBe("?page=2&sort=address&dir=asc&vacant=1");
  });
});
