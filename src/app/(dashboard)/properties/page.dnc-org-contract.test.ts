import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const pageSelect = readFileSync(new URL("./page-select.ts", import.meta.url), "utf8");
const selectAllSource = readFileSync(
  new URL("../../../lib/prospects/select-all.ts", import.meta.url),
  "utf8",
);
const scopeSource = readFileSync(
  new URL("../../../lib/prospects/search-scope.ts", import.meta.url),
  "utf8",
);

describe("Search page permanent DNC display contract", () => {
  it("keeps DNC-locked rows read-only and channel suppression separate", () => {
    // Independent literals (not derived from the shared constant): the columns the DNC display needs.
    for (const column of ["status", "is_dnc_locked", "outreach_dispo", "org_id", "cass_status", "is_vacant", "source_imported_at"]) {
      expect(pageSelect, column).toMatch(new RegExp(`[ "]${column}[,"]`));
    }
    expect(pageSelect).toContain(
      "homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)",
    );
    // ...and the page really builds its main query from that constant.
    expect(source).toMatch(/const propertiesSelect = \[\s*PAGE_PROPERTIES_SELECT,/);
    expect(source).not.toContain("homeowner:contacts!properties_homeowner_contact_id_fkey");
    expect(source).toContain("dnc_reason: p.is_dnc_locked");
    expect(source).toContain("homeowner?.sms_opted_out");
    expect(source).not.toContain('from("sms_phone_suppressions")');
    expect(source).not.toContain("evaluateSuppression");
  });

  it("the Search query context has no legacy predicates and no origin switch", () => {
    expect(scopeSource).not.toContain("status.eq.prospect,is_dnc_locked.eq.true");
    expect(scopeSource).not.toMatch(/QueryOrigin|parseQueryOrigin/);
    expect(scopeSource).toContain('.eq("is_training", false)');
    expect(scopeSource).toContain("escapeLikePattern(q)");
    for (const caller of [source, selectAllSource]) {
      expect(caller).not.toContain("status.eq.prospect,is_dnc_locked.eq.true");
    }
  });

  it("every list/count/select-all path goes through the shared Search query context", () => {
    expect(source).not.toContain("applyFilters(");
    expect(source.match(/buildScopedQuery\(/g)).toHaveLength(2); // rows + CASS counts
    expect(selectAllSource).toContain("buildScopedQuery(");
    expect(source.match(/rawSearchParams\.imported === "today"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("hides the CASS breakdown while a global search is active", () => {
    expect(source).toContain('searchModeFor(search) === "rpc"');
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
