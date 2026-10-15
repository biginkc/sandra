import { describe, expect, it, vi } from "vitest";

import {
  RequestCeilingError,
  estimateCost,
  flipRate,
  guardedFetch,
  humanLabel,
  renderReport,
  requestPlan,
  sampleIndices,
  scoreRow,
  summarizeScores,
  type NineSample,
} from "./nine-core";

const s = (over: Partial<NineSample> = {}): NineSample => ({
  idx: 0, reply: "hi", ourLastText: null, humanDispo: null, humanStatus: null, isLastForProperty: true, ...over,
});

describe("humanLabel", () => {
  it("maps dispos and status", () => {
    expect(humanLabel(s({ humanDispo: "wrong_number" }))?.expected).toEqual(["wrong_person"]);
    expect(humanLabel(s({ humanDispo: "dnc" }))?.expected).toEqual(["asked_stop"]);
    expect(humanLabel(s({ humanStatus: "lead" }))?.expected).toEqual(["open_to_selling", "talked_price"]);
    expect(humanLabel(s({ humanDispo: "nurture" }))?.expected).toEqual(["maybe_later"]);
  });
  it("gives no label for unmapped, missing or non-final texts", () => {
    expect(humanLabel(s({ humanDispo: "bad_number" }))).toBeNull();
    expect(humanLabel(s({ humanDispo: "callback_requested" }))).toBeNull();
    expect(humanLabel(s())).toBeNull();
    expect(humanLabel(s({ humanDispo: "dnc", isLastForProperty: false }))).toBeNull();
  });
});

describe("summarizeScores", () => {
  it("excludes unlabeled rows from agreement", () => {
    const rows = [
      scoreRow(s({ idx: 0, humanDispo: "not_interested" }), "not_interested"),
      scoreRow(s({ idx: 1, humanDispo: "not_interested" }), "hostile"),
      scoreRow(s({ idx: 2 }), "asked_who"),
      scoreRow(s({ idx: 3, humanStatus: "lead" }), "talked_price"),
    ];
    const st = summarizeScores(rows);
    expect(st.total).toBe(4);
    expect(st.labeled).toBe(3);
    expect(st.agree).toBe(2);
    expect(st.byHuman.not_interested).toMatchObject({ n: 2, hits: 1, recall: 0.5 });
    expect(st.byAnswer.hostile).toMatchObject({ n: 1, hits: 0, precision: 0 });
    expect(st.confusion.not_interested).toEqual({ not_interested: 1, hostile: 1 });
  });
});

describe("flipRate", () => {
  it("counts samples with any change", () => {
    expect(flipRate([["a", "b", "c"], ["a", "x", "c"], ["a", "b", "y"]])).toEqual({ samples: 3, flipped: 2, rate: 2 / 3 });
    expect(flipRate([])).toEqual({ samples: 0, flipped: 0, rate: 0 });
  });
});

describe("sampleIndices", () => {
  it("is deterministic, unique, sorted and bounded", () => {
    const a = sampleIndices(100, 30);
    expect(a).toEqual(sampleIndices(100, 30));
    expect(new Set(a).size).toBe(30);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect(sampleIndices(5, 30)).toHaveLength(5);
  });
});

describe("cost and ceiling", () => {
  it("estimates cost and plans requests", () => {
    expect(estimateCost(1000, 1000).usd).toBeCloseTo(0.000042 * 1000, 6);
    expect(requestPlan(3600, 30, 3)).toEqual({ main: 3600, flip: 90, ceiling: 3690 });
    expect(requestPlan(10, 30, 3).ceiling).toBe(40);
  });
  it("guardedFetch enforces host, method and ceiling", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const g = guardedFetch(inner as unknown as typeof fetch, 2);
    await g.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    await g.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    await expect(g.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" })).rejects.toBeInstanceOf(RequestCeilingError);
    await expect(g.fetch("https://evil.example/x", { method: "POST" })).rejects.toThrow(/refusing/);
    await expect(g.fetch("https://api.typesafe.ai/v1/systemone")).rejects.toThrow(/POST only/);
    expect(g.count()).toBe(2);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("renderReport", () => {
  it("includes summary and the full disagreement list", () => {
    const rows = [scoreRow(s({ idx: 7, humanDispo: "dnc" }), "hostile")];
    const md = renderReport({
      stats: summarizeScores(rows),
      dateRange: { start: "a", end: "b" },
      estimate: { requests: 1, usd: 0.01, inputTokens: 10, ceiling: 4 },
      actualRequests: 1,
      flip: { samples: 1, flipped: 0, rate: 0, runs: 3 },
      disagreements: [{ idx: 7, reply: "go | away", ourLastText: null, answer: "hostile", group: "dnc", probs: { hostile: 0.9, asked_stop: 0.4 } }],
      generatedAt: "now",
    });
    expect(md).toContain("Plain-English summary");
    expect(md).toContain("go \\| away");
    expect(md).toContain("hostile 0.90, asked_stop 0.40");
    expect(md).toContain("Full disagreement list (1)");
  });
});

import { scrubNames } from "./nine-core";
describe("scrubNames", () => {
  it("replaces names case-insensitively and skips short ones", () => {
    expect(scrubNames("Hi John Smith, it's jo", ["John", "Smith", "Jo", null])).toBe("Hi [name] [name], it's jo");
  });
});

import { PhoneMasker } from "./mask";
import { sanitizeText } from "./nine-core";
describe("sanitizeText", () => {
  it("leaves no address, phone or name", () => {
    const m = new PhoneMasker("salt-for-test", [], true);
    const out = sanitizeText(m, "Hi Dana, I'm at 1234 N Main St Apt 4, call (913) 222-3344", ["Dana"]);
    expect(out).not.toMatch(/Main St|Dana|222-3344/);
    expect(out).toContain("[address]");
  });
});
