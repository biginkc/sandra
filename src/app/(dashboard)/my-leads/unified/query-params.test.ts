import { describe, expect, it } from "vitest";

import { parseWorkQuery, workQueryToSearchParams } from "./query-params";

const parse = (qs: string) => parseWorkQuery(new URLSearchParams(qs));

describe("parseWorkQuery", () => {
  it("defaults an empty URL", () => {
    expect(parse("")).toEqual({ tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 });
    expect(parseWorkQuery(undefined)).toEqual(parse(""));
  });

  it("reads valid values, including a record of search params", () => {
    expect(parse("tab=waiting&chip=in_drip&stage=contacted&q=%20main%20st%20&page=3")).toEqual({
      tab: "waiting", chip: "in_drip", stage: "contacted", search: "main st", page: 3,
    });
    expect(parseWorkQuery({ tab: ["all", "waiting"], q: "x" })).toMatchObject({ tab: "all", search: "x" });
  });

  it("falls back to defaults for invalid tab, stage and page", () => {
    expect(parse("tab=nope&stage=nope&page=0")).toMatchObject({ tab: "needs_attention", stage: null, page: 1 });
    expect(parse("page=-2").page).toBe(1);
    expect(parse("page=2.5").page).toBe(1);
    expect(parse("page=abc").page).toBe(1);
  });

  it("resets a chip that does not belong to the tab", () => {
    expect(parse("tab=waiting&chip=due").chip).toBe("all");
    expect(parse("tab=needs_attention&chip=in_drip").chip).toBe("all");
    expect(parse("tab=all&chip=due").chip).toBe("all");
    expect(parse("tab=needs_attention&chip=broken").chip).toBe("broken");
  });

  it("caps the search at 200 characters", () => {
    expect(parse(`q=${"a".repeat(300)}`).search).toHaveLength(200);
  });
});

describe("workQueryToSearchParams", () => {
  it("omits defaults", () => {
    expect(workQueryToSearchParams(parse("")).toString()).toBe("");
  });

  it("round-trips a full query", () => {
    const query = { tab: "waiting", chip: "texted_last", stage: "offer_sent", search: "oak ave", page: 2 } as const;
    expect(parseWorkQuery(workQueryToSearchParams(query))).toEqual(query);
  });

  it("writes only non-default keys", () => {
    expect(workQueryToSearchParams({ ...parse(""), chip: "due" }).toString()).toBe("chip=due");
    expect(workQueryToSearchParams({ ...parse(""), page: 1, tab: "all" }).toString()).toBe("tab=all");
  });
});
