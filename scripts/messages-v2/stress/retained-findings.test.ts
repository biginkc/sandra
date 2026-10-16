import { describe, it } from "vitest";

/**
 * Retained review findings against the Messages v2 candidate (PR 4 candidate 729a282b, which
 * contains the PR 2 and PR 3 candidates). Each is tracked here as a TODO so it shows up in every
 * stress-branch test run until a fixture proves it fixed. These are KNOWN GAPS, not passing checks.
 * Label format: [KNOWN-FAILING|TODO] <source PR / reviewer>: <finding> (expected: <decision>).
 */
describe("Messages v2 retained findings (tracked, not yet fixed)", () => {
  it.todo(
    "[KNOWN-FAILING] PR 892: confirmed-owner drip-switch READ ERROR closes silently (expected per decision: hold for a person, not close)",
  );
  it.todo(
    "[TODO] PR 892: homeowner badge loader past 1,000 rows falls back to one query per homeowner (fixture: count queries for 1,001+ homeowners; expected a bounded, batched count)",
  );
  it.todo(
    "[TODO] PR 889 Astra: wrong-person close uses the LATEST revision under a concurrent takeover (expected: act on the revision it read, or stop if a person took over)",
  );
  it.todo(
    "[TODO] PR 889 Astra: unreadable-engine hold is written BEFORE the responder-off check (expected: responder off for the property = no hold, no alert)",
  );
  it.todo(
    "[TODO] PR 882 Astra: delayed-reply path writes non-hot keyword holds on responder-off properties (expected: responder off = no hold, no alert)",
  );
});
