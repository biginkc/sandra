import { describe, expect, it } from "vitest";

import {
  applyOptOut,
  OPT_OUT_PHRASES,
  renderOptOut,
} from "./opt-out";

describe("renderOptOut", () => {
  it("always returns one of the configured variants", () => {
    for (let i = 0; i < 100; i++) {
      const out = renderOptOut();
      expect(OPT_OUT_PHRASES).toContain(out);
    }
  });

  it("hits all variants across enough calls (no starvation)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(renderOptOut());
    }
    expect(seen.size).toBe(OPT_OUT_PHRASES.length);
  });

  it("is deterministic given a seed (idempotent retries)", () => {
    const a = renderOptOut({ seed: "enr-1-step-2" });
    const b = renderOptOut({ seed: "enr-1-step-2" });
    expect(a).toBe(b);
  });

  it("different seeds spread across variants", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(renderOptOut({ seed: `enr-${i}-step-0` }));
    }
    // With 100 different seeds and 5 buckets, expect all 5 hit with
    // overwhelming statistical probability.
    expect(seen.size).toBe(OPT_OUT_PHRASES.length);
  });
});

describe("applyOptOut", () => {
  it("appends a rotated variant when append_opt_out=true and body has no opt-out", () => {
    const body = "Hi Sandra, cash offer on 123 Main St?";
    const out = applyOptOut(body, { append_opt_out: true });
    expect(out.startsWith(body)).toBe(true);
    const appended = out.slice(body.length).trim();
    expect(OPT_OUT_PHRASES).toContain(appended);
  });

  it("returns body unchanged when body already contains 'STOP' as a word", () => {
    const body = "Hi — interested? Reply STOP anytime to stop.";
    expect(applyOptOut(body, { append_opt_out: true })).toBe(body);
  });

  it("returns body unchanged when body contains the {{opt_out}} template variable", () => {
    const body = "Hi Sandra, interested? {{opt_out}}";
    expect(applyOptOut(body, { append_opt_out: true })).toBe(body);
  });

  it("returns body unchanged when append_opt_out is false — trusts the author", () => {
    const body = "Hi Sandra, interested?";
    expect(applyOptOut(body, { append_opt_out: false })).toBe(body);
  });

  it("doesn't match 'STOP' inside another word (e.g. 'STOPLIGHT')", () => {
    const body = "There's a stoplight by 123 Main St";
    const out = applyOptOut(body, { append_opt_out: true });
    // Since 'stoplight' shouldn't count as an opt-out keyword, an opt-out
    // phrase should have been appended.
    expect(out).not.toBe(body);
    const appended = out.slice(body.length).trim();
    expect(OPT_OUT_PHRASES).toContain(appended);
  });

  it("is deterministic when seeded, both in the variant picked and the final body", () => {
    const body = "Hi Sandra, offer on 123 Main St?";
    const a = applyOptOut(body, { append_opt_out: true, seed: "run-abc" });
    const b = applyOptOut(body, { append_opt_out: true, seed: "run-abc" });
    expect(a).toBe(b);
  });
});
