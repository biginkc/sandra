import { describe, expect, it } from "vitest";

import { loadHomeownerHouses, MAX_HOMEOWNER_IDS, MAX_PAGE_ROWS, type HousesClient } from "../../../src/lib/leads/homeowner-houses";

/**
 * Retained review findings against the Messages v2 candidate (PR 4 candidate 729a282b, which
 * contains the PR 2 and PR 3 candidates), as REAL regression tests asserting the DESIRED
 * behaviour. A product defect is an expected failure (`it.fails`, labelled [KNOWN DEFECT]): green
 * while the defect exists, RED the day it is fixed (then remove the marker). No todos.
 *
 * Only the DB-free finding, (b), lives here; it is still a [KNOWN DEFECT] at PR 4 candidate 392dadc0
 * (My Leads' fix pending). The four that need the real dispatch / webhook path were FIXED in
 * 392dadc0 and are plain passing regression tests in retained-findings.db.integration.test.ts
 * (npm run stress:messages-v2:db):
 *   (a) PR 892 confirmed-owner drip-switch read error -> hold for a person
 *   (c) PR 889 wrong-person close under a concurrent human takeover -> no revision absorption
 *   (d) PR 889 unreadable engine switch on a responder-off property -> no hold
 *   (e) PR 882 delayed-reply path, responder-off + non-hot keyword -> no hold
 *
 * MV2_RETAINED_STRICT=1 runs them as plain `it` to show the real assertion message.
 */
const knownDefect = process.env.MV2_RETAINED_STRICT === "1" ? it : it.fails;

/** A fake caller client that counts every query and serves `rowsPerOwner` houses per homeowner. */
function countingClient(rowsPerOwner: number) {
  let queries = 0;
  const client = {
    from() {
      return {
        select(_cols: string, options?: { count: "exact" }) {
          queries++;
          const filters: { in?: string[]; eq?: string } = {};
          let limit = Infinity;
          const q = {
            eq(column: string, value: string) {
              if (column === "homeowner_contact_id") filters.eq = value;
              return q;
            },
            in(_column: string, values: string[]) {
              filters.in = values;
              return q;
            },
            is() {
              return q;
            },
            order() {
              return q;
            },
            limit(n: number) {
              limit = n;
              return Promise.resolve(run());
            },
            range(from: number, to: number) {
              limit = to - from + 1;
              return Promise.resolve(run());
            },
          };
          const run = () => {
            const owners = filters.eq ? [filters.eq] : (filters.in ?? []);
            const all = owners.flatMap((owner) =>
              Array.from({ length: rowsPerOwner }, (_, i) => ({
                id: `${owner}-${i}`,
                address: `${i} Fixture St`,
                city: "Kansas City",
                state: "MO",
                assigned_user_id: null,
                homeowner_contact_id: owner,
              })),
            );
            return { data: all.slice(0, limit), error: null, ...(options ? { count: all.length } : {}) };
          };
          return q;
        },
      };
    },
  } as unknown as HousesClient;
  return { client, queries: () => queries };
}

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("Messages v2 retained findings (pure)", () => {
  it("control (b): under the row ceiling the badge loader is ONE query for the whole page", async () => {
    const ids = Array.from({ length: MAX_HOMEOWNER_IDS }, (_, i) => uuid(i));
    const { client, queries } = countingClient(2); // 200 rows < 1,000
    const result = await loadHomeownerHouses(client, { orgId: uuid(9999), viewerId: uuid(9998), contactIds: ids });
    expect(Object.keys(result)).toHaveLength(MAX_HOMEOWNER_IDS);
    expect(queries()).toBe(1);
  });

  knownDefect(
    "[KNOWN DEFECT] (b) PR 892: homeowner badge loader past 1,000 rows must keep a bounded, batched query count (today: 1 + one query per homeowner)",
    async () => {
      const ids = Array.from({ length: MAX_HOMEOWNER_IDS }, (_, i) => uuid(i));
      const { client, queries } = countingClient(11); // 1,100 rows: past MAX_PAGE_ROWS
      expect(MAX_HOMEOWNER_IDS * 11).toBeGreaterThan(MAX_PAGE_ROWS);
      const result = await loadHomeownerHouses(client, { orgId: uuid(9999), viewerId: uuid(9998), contactIds: ids });
      expect(result[ids[0]!]!.count).toBe(11); // still exact
      // Desired: the fallback is batched, so the query count does not grow with the number of
      // homeowners on the page. Bound: the page query plus at most 10 batched follow-ups.
      expect(queries()).toBeLessThanOrEqual(11);
    },
  );
});
