import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { LunaResult } from "./classifiers/luna";
import { FileCache, MemoryCache } from "./compare-cache";
import { DEFAULT_THRESHOLDS, buildReport, mapPool, renderMarkdown, runCompare, thresholdsFromExport, type CompareDeps, type CompareOptions, type JevCall } from "./compare-core";
import { PROP, inbound, makeExport } from "./compare-fixtures";
import { assertCompareSafety } from "./compare-safety";
import { buildThread } from "./compare-thread";
import { ReplaySafetyError } from "./safety";

const M = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const jevOk = (outcome: string, confidence: number | null): JevCall => ({ status: "ok", outcome: outcome as never, confidence, escalationReason: null, latencyMs: 100, usage: { inputTokens: 50, outputTokens: 5 } });
const lunaOk = (outcome: string, confidence: number): LunaResult => ({ status: "ok", outcome: outcome as never, confidence, escalationReason: "not_applicable", usage: { inputTokens: 1000, outputTokens: 20 }, latencyMs: 400, model: "luna-test" });

const T = "2026-09-10T10:00:00.000Z";
function fixtureExport() {
  const reviews = (n: number, disposition: string, extra: Record<string, unknown> = {}) => ({ id: `r${n}`, source_inbound_message_id: M(n), disposition, status: "confirmed", corrected_disposition: null, ...extra });
  return makeExport({
    inbound: [
      inbound(M(1), "no thanks", T, { conversationId: "c1" }),
      inbound(M(2), "wrong person", T, { conversationId: "c2" }),
      inbound(M(3), "who is this", T, { conversationId: "c3" }),
      inbound(M(4), "not selling", T, { conversationId: "c4" }),
    ],
    reference: {
      pipelineRuns: [], outboundInWindow: [],
      humanEvents: {
        runs: [], decisions: [], dispoSets: [],
        reviews: [reviews(1, "not_interested"), reviews(2, "wrong_number"), reviews(3, "wrong_number"), reviews(4, "not_interested", { status: "auto_accepted" })],
      },
    },
  });
}
const opts: CompareOptions = { concurrency: 2, limit: null, headToHead: false, scope: "below_threshold", eligibility: "policy", lunaPrices: { inputPerMTok: 2, outputPerMTok: 8 } };

function deps(cache: import("./compare-cache").CompareCache = new MemoryCache()) {
  const jevScript: Record<string, JevCall> = {
    [M(1)]: jevOk("not_interested", 0.7), // below 0.90 -> hold
    [M(2)]: jevOk("wrong_number", 0.85), // below 0.90 -> hold
    [M(3)]: jevOk("unclear", 0.4), // policy hold, out of cascade scope
    [M(4)]: jevOk("not_interested", 0.97), // auto-applied
  };
  const lunaScript: Record<string, LunaResult> = { "no thanks": lunaOk("not_interested", 0.96), "wrong person": lunaOk("not_interested", 0.91) };
  const jev = vi.fn(async (a: { thread: { body: string }[] }) => {
    const id = fixtureExport().inbound.find((m) => m.body === a.thread[a.thread.length - 1].body)!.id;
    return jevScript[id];
  });
  const luna = vi.fn(async (t: { body: string }[]) => lunaScript[t[t.length - 1].body] ?? lunaOk("nurture", 0.5));
  const d: CompareDeps = { jev: jev as never, luna: luna as never, cache, lunaModel: "luna-test", lunaApi: "responses", };
  return { d, jev, luna };
}

describe("runCompare", () => {
  it("runs Luna only on Jev holds, applies thresholds from the defaults, and scores the cascade", async () => {
    const { d, jev, luna } = deps();
    const run = await runCompare(fixtureExport(), opts, d);
    expect(run.thresholdSource).toBe("defaults");
    expect(jev).toHaveBeenCalledTimes(4);
    expect(luna).toHaveBeenCalledTimes(3); // M1, M2 below threshold + M3 policy hold; M4 auto-applied is skipped
    const report = buildReport(fixtureExport(), run, opts, { generatedAt: "x", lunaModel: "luna-test" });
    expect(report.sampleSizes).toMatchObject({ inboundMessages: 4, withHumanTruthExplicit: 3, withHumanTruthImplicit: 1, cascadePopulation: 2, cascadePopulationWithExplicitTruth: 2 });
    const at90 = report.explicit.cascade.find((c) => c.cutoff === 0.9)!;
    expect(at90).toMatchObject({ resolved: 2, resolvedWithTruth: 2, agreed: 1, wrong: 1, remainingHuman: 0 });
    const at95 = report.explicit.cascade.find((c) => c.cutoff === 0.95)!;
    expect(at95).toMatchObject({ resolved: 1, agreed: 1, wrong: 0, remainingHuman: 1 });
    expect(report.explicit.jevAlone).toMatchObject({ autoApplied: 1, autoScored: 0, heldForHuman: 3 });
    expect(report.withImplicit.jevAlone).toMatchObject({ autoScored: 1, autoAgreed: 1 });
    expect(report.cost.luna).toMatchObject({ calls: 3, inputTokens: 3000, outputTokens: 60 });
    expect(report.cost.luna.totalUsd).toBeCloseTo((3000 * 2 + 60 * 8) / 1e6);
    expect(report.disagreements[0]).toMatchObject({ cascadeWrongAt90: true, human: "wrong_number" });
    const md = renderMarkdown(report);
    expect(md).toContain("key risk");
    expect(md).toContain("Sample sizes");
  });

  it("is resumable: a rerun against the same cache file makes no new calls", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cmp-")), "compare-t.jsonl");
    const first = deps(new FileCache(file));
    await runCompare(fixtureExport(), opts, first.d);
    expect(first.jev).toHaveBeenCalledTimes(4);
    const second = deps(new FileCache(file));
    const run = await runCompare(fixtureExport(), opts, second.d);
    expect(second.jev).not.toHaveBeenCalled();
    expect(second.luna).not.toHaveBeenCalled();
    expect(run.stats).toMatchObject({ jevCached: 4, lunaCached: 3, jevCalls: 0, lunaCalls: 0 });
  });

  it("never caches errors, so a rerun retries them", async () => {
    const cache = new MemoryCache();
    const { d } = deps(cache);
    const failing: CompareDeps = { ...d, jev: vi.fn(async () => ({ status: "error", error: "boom", latencyMs: 1 }) as JevCall) as never, luna: null };
    const run = await runCompare(fixtureExport(), opts, failing);
    expect(cache.map.size).toBe(0);
    expect(run.rows.every((r) => r.jevDecision.reason === "jev_error" && r.jev === null)).toBe(true);
  });

  it("head-to-head runs Luna on every message", async () => {
    const { d, luna } = deps();
    const run = await runCompare(fixtureExport(), { ...opts, headToHead: true }, d);
    expect(luna).toHaveBeenCalledTimes(4);
    const report = buildReport(fixtureExport(), run, { ...opts, headToHead: true }, { generatedAt: "x", lunaModel: "l" });
    expect(report.explicit.headToHead?.luna.n).toBe(3);
  });

  it("ignores a torn last line in the cache file", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cmp-")), "c.jsonl");
    writeFileSync(file, `${JSON.stringify({ key: "a", value: 1 })}\n{"key":"b","val`);
    const c = new FileCache(file);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    c.set("c", 2);
    expect(readFileSync(file, "utf8")).toContain('"key":"c"');
  });
});

describe("helpers", () => {
  it("reads thresholds from the export, else documents the defaults", () => {
    const exp = makeExport({ inbound: [] });
    expect(thresholdsFromExport(exp)).toEqual({ map: DEFAULT_THRESHOLDS, source: "defaults" });
    exp.tables.jev_outcome_thresholds = [{ outcome: "nurture", min_confidence: "0.970", version: 3, automation_enabled: true }];
    expect(thresholdsFromExport(exp)).toEqual({ map: { nurture: { minConfidence: 0.97, version: 3, automationEnabled: true } }, source: "export" });
  });
  it("mapPool honours the concurrency bound and keeps order", async () => {
    let live = 0, peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
  it("buildThread uses prior messages in the conversation, both directions, then the current text", () => {
    const exp = makeExport({
      inbound: [inbound(M(1), "earlier", "2026-09-09T10:00:00.000Z"), inbound(M(2), "now", T)],
    });
    exp.tables.messages = [{ id: "h1", conversation_id: exp.inbound[0].conversationId, direction: "outbound", body: "hi", created_at: "2026-09-01T10:00:00.000Z" }];
    exp.reference.outboundInWindow = [{ id: "o1", conversation_id: exp.inbound[0].conversationId, direction: "outbound", body: "reply", created_at: "2026-09-09T11:00:00.000Z" }];
    const { thread, missingOutboundBodies } = buildThread(exp, exp.inbound[1]);
    expect(thread.map((m) => `${m.direction}:${m.body}`)).toEqual(["outbound:hi", "inbound:earlier", "outbound:reply", "inbound:now"]);
    expect(missingOutboundBodies).toBe(0);
    exp.reference.outboundInWindow = [{ id: "o1", conversation_id: exp.inbound[0].conversationId, direction: "outbound", created_at: "2026-09-09T11:00:00.000Z" }];
    expect(buildThread(exp, exp.inbound[1]).missingOutboundBodies).toBe(1);
    void PROP;
  });
});

describe("assertCompareSafety", () => {
  const prod = ["copflsklaefwzipsrjqz"];
  it("passes with only the classifier keys in the environment", () => {
    expect(() => assertCompareSafety({ TYPESAFE_API_KEY: "k", OPENAI_API_KEY: "k", LUNA_MODEL: "m" }, prod)).not.toThrow();
  });
  it("refuses when any SMS provider credential is present", () => {
    for (const name of ["SENDILLO_API_KEY", "TWILIO_AUTH_TOKEN", "DIALPAD_API_KEY"]) {
      expect(() => assertCompareSafety({ [name]: "x" }, prod)).toThrow(ReplaySafetyError);
    }
  });
  it("refuses a production Supabase or database target and any non-local DB host", () => {
    expect(() => assertCompareSafety({ NEXT_PUBLIC_SUPABASE_URL: "https://copflsklaefwzipsrjqz.supabase.co" }, prod)).toThrow(/production/);
    expect(() => assertCompareSafety({ SUPABASE_LOCAL_DB_URL: "postgresql://u:p@db.copflsklaefwzipsrjqz.supabase.co:5432/postgres" }, prod)).toThrow(/production/);
    expect(() => assertCompareSafety({ DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" }, prod)).toThrow(ReplaySafetyError);
    expect(() => assertCompareSafety({ SUPABASE_LOCAL_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres" }, prod)).not.toThrow();
  });
});
