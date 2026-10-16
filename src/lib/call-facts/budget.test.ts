import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLAIM_BATCH, CLAIM_LEASE_SECONDS, CLAIM_WINDOW_HOURS, FACTS_REQUEST_RETRIES, FACTS_REQUEST_TIMEOUT_MS, ROUTE_MAX_DURATION_S,
  worstCaseMsPerCall, worstCaseRequests,
} from "./budget";

describe("cron time budget", () => {
  it("worst-case requests x timeout x calls per run stays at or under half the route's maxDuration", () => {
    const worst = worstCaseMsPerCall() * CLAIM_BATCH;
    expect(worstCaseRequests()).toBe(41);
    expect(worst).toBeLessThanOrEqual((ROUTE_MAX_DURATION_S * 1000) / 2);
    // 41 requests at 4 in flight is 11 waves of at most one timeout each (88s).
    expect(worstCaseMsPerCall()).toBe(11 * FACTS_REQUEST_TIMEOUT_MS);
  });
  it("no per-request retries, so the timeout is the whole per-request cost", () => {
    expect(FACTS_REQUEST_RETRIES).toBe(0);
  });
  it("the lease outlives the longest possible run, so it cannot expire mid-run", () => {
    expect(CLAIM_LEASE_SECONDS).toBeGreaterThan(ROUTE_MAX_DURATION_S);
  });
  it("the route's literal maxDuration equals the constant the budget is checked against", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/cron/call-facts-sweep/route.ts"), "utf8");
    expect(src).toMatch(new RegExp(`export const maxDuration = ${ROUTE_MAX_DURATION_S};`));
  });
  it("the claim window is 48 hours", () => {
    expect(CLAIM_WINDOW_HOURS).toBe(48);
  });
});
