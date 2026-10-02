import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const selectAllSource = readFileSync(
  new URL("../../../lib/prospects/select-all.ts", import.meta.url),
  "utf8",
);
const countSource = readFileSync(new URL("./_actions/count.ts", import.meta.url), "utf8");
const scopeSource = readFileSync(
  new URL("../../../lib/prospects/search-scope.ts", import.meta.url),
  "utf8",
);

const LEGACY_STATUS_OR = '.or("status.eq.prospect,is_dnc_locked.eq.true")';

describe("Search page permanent DNC display contract", () => {
  it("keeps DNC-locked rows read-only and channel suppression separate", () => {
    expect(source).toContain("status, is_dnc_locked, outreach_dispo");
    expect(source).toContain("dnc_reason: p.is_dnc_locked");
    expect(source).toContain("homeowner?.sms_opted_out");
    expect(source).not.toContain('from("sms_phone_suppressions")');
    expect(source).not.toContain("evaluateSuppression");
  });

  it("the legacy origin keeps today's exact predicates, in ONE place", () => {
    // The legacy branch owns the prospect-or-DNC status literal and the
    // unescaped address ilike; no caller inlines them any more.
    expect(scopeSource.split(LEGACY_STATUS_OR)).toHaveLength(2);
    expect(scopeSource).toContain('query.ilike("address", `%${args.search}%`)');
    for (const caller of [source, selectAllSource, countSource]) {
      expect(caller).not.toContain("status.eq.prospect,is_dnc_locked.eq.true");
    }
  });

  it("the search origin shows all statuses and hides training rows", () => {
    const searchBranch = scopeSource.slice(scopeSource.indexOf("let mode = searchModeFor"));
    expect(searchBranch).toContain('.eq("is_training", false)');
    expect(searchBranch).not.toContain("status.eq.prospect");
    expect(searchBranch).toContain("escapeLikePattern(q)");
  });

  it("every list/count/select-all path goes through the shared query context", () => {
    expect(source).not.toContain("applyFilters(");
    expect(source.match(/buildScopedQuery\(/g)).toHaveLength(2); // rows + CASS counts
    expect(source.match(/origin: "search_page"/g)).toHaveLength(2);
    expect(selectAllSource).toContain("buildScopedQuery(");
    expect(countSource).toContain("buildScopedQuery(");
    expect(source.match(/rawSearchParams\.imported === "today"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("hides the CASS breakdown while a global search is active", () => {
    expect(source).toContain('searchModeFor("search_page", search) === "rpc"');
    expect(source).toContain("if (total === 0 || globalSearchActive) return null;");
  });

  it("message previews and the engagement pill are gated by the server-derived include_messages flag", () => {
    expect(source).toContain("includeMessages = await resolveIncludeMessages()");
    expect(source).toContain("if (includeMessages && pageIds.length > 0)");
    // A lookup failure keeps message search OFF and is surfaced, never ignored.
    expect(source).toContain("membershipError");
    expect(source).not.toMatch(/includeMessages\s*=\s*true/);
  });
});
