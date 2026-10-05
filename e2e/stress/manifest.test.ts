import { describe, expect, it } from "vitest";

import { buildManifest, countByScenario, MANDATORY, MANDATORY_TOTAL, parseNdjson, toNdjson } from "./manifest";
import { createRng } from "./prng";

describe("manifest", () => {
  it("has the plan's mandatory counts and ~60 calls", () => {
    const m = buildManifest(20261005, "STRESS-t");
    const counts = countByScenario(m.ticks);
    for (const row of MANDATORY) expect(counts[row.scenario]).toBe(row.count);
    expect(MANDATORY_TOTAL).toBe(59);
    expect(m.total).toBe(59);
  });
  it("is byte-identical for the same seed and different for another", () => {
    const a = buildManifest(20261005, "STRESS-t");
    const b = buildManifest(20261005, "STRESS-t");
    const c = buildManifest(1, "STRESS-t");
    expect(toNdjson(a)).toBe(toNdjson(b));
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
  });
  it("round-trips through ndjson and gives every non-noise tick a distinct lead slot", () => {
    const m = buildManifest(7, "STRESS-t");
    expect(parseNdjson(toNdjson(m))).toEqual(m.ticks);
    const slots = m.ticks.filter((t) => t.actor !== "noise").map((t) => t.leadSlot);
    expect(new Set(slots).size).toBe(slots.length);
  });
  it("splits drivers: browser instances exist and every mandatory scenario has a replay or browser realization", () => {
    const m = buildManifest(20261005, "STRESS-t");
    expect(m.ticks.filter((t) => t.actor === "browser").length).toBeGreaterThanOrEqual(10);
    expect(m.ticks.filter((t) => t.actor === "replay").length).toBeGreaterThanOrEqual(40);
  });
  it("only schedules approved note markers (run tag + tick), never free text", () => {
    const m = buildManifest(20261005, "STRESS-t");
    for (const t of m.ticks) if (t.expected.noteMarker) expect(t.expected.noteMarker).toBe(`STRESS-t note t${t.tick}`);
  });
});

describe("rng", () => {
  it("is deterministic", () => {
    const a = createRng(5), b = createRng(5);
    expect([a.next(), a.int(1, 9), a.next()]).toEqual([b.next(), b.int(1, 9), b.next()]);
  });
});
