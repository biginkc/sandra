import { describe, it, expect } from "vitest";

import {
  buildProspectsHref,
  computeEngagement,
  DEFAULT_DIR,
  DEFAULT_SORT,
  formatFullAddress,
  KNOWN_MARKETS,
  parseProspectsSearch,
  truncateMessagePreview,
} from "./prospects-query";

describe("parseProspectsSearch", () => {
  it("returns defaults when raw is empty", () => {
    expect(parseProspectsSearch({})).toEqual({
      page: 1,
      search: null,
      sort: DEFAULT_SORT,
      dir: DEFAULT_DIR,
      filters: {
        vacant: false,
        cass: null,
        engagement: null,
        market: null,
        assignee: null,
      },
    });
  });

  it("clamps invalid pages to 1 and truncates fractional", () => {
    expect(parseProspectsSearch({ page: "0" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "-3" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "nope" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "3.7" }).page).toBe(3);
  });

  it("trims whitespace on search and collapses empty/whitespace to null", () => {
    expect(parseProspectsSearch({ search: "   " }).search).toBe(null);
    expect(parseProspectsSearch({ search: "" }).search).toBe(null);
    expect(parseProspectsSearch({ search: "  Main St  " }).search).toBe(
      "Main St",
    );
  });

  it("whitelists sort columns; unknown values fall back to default", () => {
    expect(parseProspectsSearch({ sort: "address" }).sort).toBe("address");
    expect(parseProspectsSearch({ sort: "market" }).sort).toBe("market");
    // Removed (no longer their own columns) — should fall back to default.
    expect(parseProspectsSearch({ sort: "city" }).sort).toBe(DEFAULT_SORT);
    expect(parseProspectsSearch({ sort: "is_vacant" }).sort).toBe(DEFAULT_SORT);
    expect(parseProspectsSearch({ sort: "deleted_at" }).sort).toBe(
      DEFAULT_SORT,
    );
    expect(parseProspectsSearch({ sort: "; DROP TABLE x" }).sort).toBe(
      DEFAULT_SORT,
    );
  });

  it("only accepts 'asc' for dir; everything else collapses to default desc", () => {
    expect(parseProspectsSearch({ dir: "asc" }).dir).toBe("asc");
    expect(parseProspectsSearch({ dir: "desc" }).dir).toBe("desc");
    expect(parseProspectsSearch({ dir: "DESCENDING" }).dir).toBe("desc");
    expect(parseProspectsSearch({}).dir).toBe("desc");
  });

  it("handles array-style searchParams by taking the first value", () => {
    expect(
      parseProspectsSearch({
        page: ["2", "5"],
        sort: ["address", "market"],
      }),
    ).toMatchObject({ page: 2, sort: "address" });
  });
});

describe("buildProspectsHref", () => {
  it("returns empty string when every value is default", () => {
    expect(buildProspectsHref({})).toBe("");
    expect(
      buildProspectsHref({ page: 1, search: null, sort: DEFAULT_SORT, dir: DEFAULT_DIR }),
    ).toBe("");
  });

  it("only includes non-default values", () => {
    expect(buildProspectsHref({ page: 3 })).toBe("?page=3");
    expect(buildProspectsHref({ search: "main" })).toBe("?search=main");
    expect(buildProspectsHref({ sort: "address", dir: "asc" })).toBe(
      "?sort=address&dir=asc",
    );
  });

  it("URL-encodes special characters in search", () => {
    const href = buildProspectsHref({ search: "5th & Vine" });
    // URLSearchParams uses '+' for spaces and percent-encodes &.
    expect(href).toBe("?search=5th+%26+Vine");
  });

  it("preserves multiple non-default fields together", () => {
    expect(
      buildProspectsHref({
        page: 2,
        search: "oak",
        sort: "market",
        dir: "asc",
      }),
    ).toBe("?page=2&search=oak&sort=market&dir=asc");
  });
});

describe("computeEngagement", () => {
  it("returns 'none' when there is no latest message", () => {
    expect(computeEngagement(null)).toBe("none");
  });

  it("returns 'contacted' when the latest message is outbound (we wrote, no reply)", () => {
    expect(computeEngagement({ direction: "outbound" })).toBe("contacted");
  });

  it("returns 'replying' when the latest message is inbound (their move was last)", () => {
    expect(computeEngagement({ direction: "inbound" })).toBe("replying");
  });
});

describe("truncateMessagePreview", () => {
  it("returns null for null/empty/whitespace-only input", () => {
    expect(truncateMessagePreview(null)).toBe(null);
    expect(truncateMessagePreview(undefined)).toBe(null);
    expect(truncateMessagePreview("")).toBe(null);
    expect(truncateMessagePreview("   ")).toBe(null);
  });

  it("collapses internal whitespace and trims", () => {
    expect(truncateMessagePreview("  hello\n\nworld  ")).toBe("hello world");
  });

  it("returns the body unchanged when shorter than maxLen", () => {
    expect(truncateMessagePreview("short")).toBe("short");
  });

  it("appends ellipsis when over maxLen", () => {
    const long = "x".repeat(120);
    const out = truncateMessagePreview(long, 30);
    expect(out).toMatch(/…$/);
    expect((out ?? "").length).toBeLessThanOrEqual(30);
  });

  it("respects an explicit maxLen", () => {
    expect(truncateMessagePreview("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("parseProspectsSearch — filters", () => {
  it("returns all-empty filters when no filter params present", () => {
    expect(parseProspectsSearch({}).filters).toEqual({
      vacant: false,
      cass: null,
      engagement: null,
      market: null,
      assignee: null,
    });
  });

  it("parses ?vacant=1 and ?vacant=true as true; everything else false", () => {
    expect(parseProspectsSearch({ vacant: "1" }).filters.vacant).toBe(true);
    expect(parseProspectsSearch({ vacant: "true" }).filters.vacant).toBe(true);
    expect(parseProspectsSearch({ vacant: "0" }).filters.vacant).toBe(false);
    expect(parseProspectsSearch({ vacant: "yes" }).filters.vacant).toBe(false);
    expect(parseProspectsSearch({}).filters.vacant).toBe(false);
  });

  it("whitelists ?cass to 'verified' only — anything else collapses to null", () => {
    expect(parseProspectsSearch({ cass: "verified" }).filters.cass).toBe(
      "verified",
    );
    expect(parseProspectsSearch({ cass: "invalid" }).filters.cass).toBe(null);
    expect(parseProspectsSearch({ cass: "VERIFIED" }).filters.cass).toBe(null);
  });

  it("whitelists ?engagement to 'contacted' only", () => {
    expect(
      parseProspectsSearch({ engagement: "contacted" }).filters.engagement,
    ).toBe("contacted");
    expect(
      parseProspectsSearch({ engagement: "replying" }).filters.engagement,
    ).toBe(null);
  });

  it("whitelists ?market to known markets only", () => {
    expect(parseProspectsSearch({ market: "Kansas City" }).filters.market).toBe(
      "Kansas City",
    );
    expect(parseProspectsSearch({ market: "St. Louis" }).filters.market).toBe(
      "St. Louis",
    );
    expect(parseProspectsSearch({ market: "Chicago" }).filters.market).toBe(
      null,
    );
    expect(parseProspectsSearch({ market: "" }).filters.market).toBe(null);
  });

  it("passes through ?assignee as a string (uuid validated upstream); 'unassigned' is the sentinel", () => {
    const uuid = "9b6f0c2a-1234-4abc-89de-aaaaaaaaaaaa";
    expect(parseProspectsSearch({ assignee: uuid }).filters.assignee).toBe(
      uuid,
    );
    expect(
      parseProspectsSearch({ assignee: "unassigned" }).filters.assignee,
    ).toBe("unassigned");
    expect(parseProspectsSearch({ assignee: "  " }).filters.assignee).toBe(
      null,
    );
    expect(parseProspectsSearch({}).filters.assignee).toBe(null);
  });

  it("KNOWN_MARKETS exposes the four configured markets", () => {
    expect(KNOWN_MARKETS).toEqual([
      "Kansas City",
      "St. Louis",
      "Dayton",
      "Lake of the Ozarks",
    ]);
  });
});

describe("buildProspectsHref — filters", () => {
  it("emits ?vacant=1 only when vacant is true", () => {
    expect(buildProspectsHref({ filters: { vacant: true } })).toBe(
      "?vacant=1",
    );
    expect(buildProspectsHref({ filters: { vacant: false } })).toBe("");
  });

  it("emits ?cass and ?engagement when set; omits when null", () => {
    expect(buildProspectsHref({ filters: { cass: "verified" } })).toBe(
      "?cass=verified",
    );
    expect(buildProspectsHref({ filters: { engagement: "contacted" } })).toBe(
      "?engagement=contacted",
    );
    expect(buildProspectsHref({ filters: { cass: null, engagement: null } })).toBe(
      "",
    );
  });

  it("URL-encodes the market value", () => {
    expect(
      buildProspectsHref({ filters: { market: "Kansas City" } }),
    ).toBe("?market=Kansas+City");
    expect(
      buildProspectsHref({ filters: { market: "Lake of the Ozarks" } }),
    ).toBe("?market=Lake+of+the+Ozarks");
  });

  it("emits ?assignee for uuid and for the 'unassigned' sentinel", () => {
    expect(buildProspectsHref({ filters: { assignee: "abc-123" } })).toBe(
      "?assignee=abc-123",
    );
    expect(
      buildProspectsHref({ filters: { assignee: "unassigned" } }),
    ).toBe("?assignee=unassigned");
  });

  it("composes filters with sort+search+page in stable order", () => {
    expect(
      buildProspectsHref({
        page: 2,
        search: "oak",
        sort: "market",
        dir: "asc",
        filters: {
          vacant: true,
          cass: "verified",
          engagement: "contacted",
          market: "Kansas City",
          assignee: "unassigned",
        },
      }),
    ).toBe(
      "?page=2&search=oak&sort=market&dir=asc&vacant=1&cass=verified&engagement=contacted&market=Kansas+City&assignee=unassigned",
    );
  });
});

describe("formatFullAddress", () => {
  it("renders 'street, city, state zip' when every part is present", () => {
    expect(
      formatFullAddress({
        address: "1307 NW DEER RUN TRL",
        city: "BLUE SPRINGS",
        state: "MO",
        zip: "64015",
      }),
    ).toBe("1307 NW DEER RUN TRL, BLUE SPRINGS, MO 64015");
  });

  it("drops the city cleanly when missing — no leading comma", () => {
    expect(
      formatFullAddress({
        address: "1307 NW DEER RUN TRL",
        city: null,
        state: "MO",
        zip: "64015",
      }),
    ).toBe("1307 NW DEER RUN TRL, MO 64015");
  });

  it("drops the zip cleanly when missing — no trailing space", () => {
    expect(
      formatFullAddress({
        address: "1307 NW DEER RUN TRL",
        city: "BLUE SPRINGS",
        state: "MO",
        zip: null,
      }),
    ).toBe("1307 NW DEER RUN TRL, BLUE SPRINGS, MO");
  });

  it("renders just the street when nothing else is set", () => {
    expect(
      formatFullAddress({
        address: "1307 NW DEER RUN TRL",
        city: null,
        state: "",
        zip: null,
      }),
    ).toBe("1307 NW DEER RUN TRL");
  });

  it("trims whitespace around each part", () => {
    expect(
      formatFullAddress({
        address: "  1307 NW DEER RUN TRL  ",
        city: "  BLUE SPRINGS  ",
        state: " MO ",
        zip: " 64015 ",
      }),
    ).toBe("1307 NW DEER RUN TRL, BLUE SPRINGS, MO 64015");
  });
});
