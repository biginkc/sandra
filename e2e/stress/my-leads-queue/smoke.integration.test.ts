import { afterAll, describe, expect, it } from "vitest";

import { assertEnvLooksLocal, resolveDbUrl } from "./guards";
import { lastClassifierMigration, loadClassifierMigration } from "./migration";
import { preflightCommitLanes, laneStampedSendVsInbound, unstampedSendDriver } from "./races";
import { FAMILIES } from "./families";
import { SMOKE_DEFAULTS, runStress } from "./run";
import { runFamilies } from "./runner";

// Smoke run of the My Leads queue stress harness: 1 repeat, 3 families, one rep of each rolled-back lane. It proves the harness still
// runs end to end against the classifier in this checkout and that it can still tell a broken classifier from a good one. The volume
// run (31 families x 20 repeats, race lanes, scale) is manual: see e2e/stress/my-leads-queue/README.md.
const env = { ...process.env, MYLEADS_STRESS_DB_URL: process.env.MYLEADS_STRESS_DB_URL ?? process.env.TEST_SUPABASE_DB_URL };
const url = (() => { assertEnvLooksLocal(env); return resolveDbUrl(env); })();

describe("my-leads queue stress harness smoke", () => {
  it("passes against the classifier in this checkout (1 repeat, 3 families, refresh + bind-failure lanes)", async () => {
    const report = await runStress({ ...SMOKE_DEFAULTS, outDir: null }, env);
    expect(report.failReasons).toEqual([]);
    expect(report.verdict).toBe("PASS");
    expect(report.families.map((f) => f.family).sort()).toEqual([...SMOKE_DEFAULTS.families!].sort());
    expect(report.families.every((f) => f.leads > 0 && f.checks > 0 && f.errors.length === 0)).toBe(true);
    expect(report.lanes.length).toBeGreaterThanOrEqual(4);
    expect(report.lanes.every((l) => !l.skipped && l.runs > 0)).toBe(true);
  }, 240_000);

  it("notices a broken classifier: widening the Due window from 15 to 16 minutes is caught by the callback-boundary family", async () => {
    // Mutate the LAST classifier file (a later fix would overwrite a mutation of an earlier one), then apply all of them in order.
    const sql = loadClassifierMigration();
    const last = lastClassifierMigration();
    const mutatedLast = last.sql.replace("eff <= p_at + interval '15 minutes' and eff >= ((p_at", "eff <= p_at + interval '16 minutes' and eff >= ((p_at");
    expect(mutatedLast).not.toBe(last.sql);
    const mutated = `${sql}\n;\n${mutatedLast}`;
    const runs = await runFamilies(url, { families: FAMILIES.filter((f) => f.id === "callback_boundary"), repeats: 1, seed: 1, migrationSql: mutated });
    const kinds = runs[0]!.mismatches.map((m) => m.kind);
    expect(runs[0]!.errors).toEqual([]);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("wrong_tab");
  }, 240_000);

  it("the race lane has teeth: with the reply-to stamp removed, a late-accepted text wrongly handles the newer inbound", async () => {
    const skip = await preflightCommitLanes(url).catch((error: Error) => error.message);
    if (skip && process.env.MYLEADS_STRESS_DISPOSABLE_DB === "1") throw new Error(`race-lane mutation check cannot run: ${skip}`);
    if (skip) { console.warn(`race-lane mutation check skipped: ${skip}`); return; }
    // Y always lands before the fake provider accepts, so without the stamp the text's send time is newer than Y.
    const lane = await laneStampedSendVsInbound(url, 4, 3, unstampedSendDriver, { latencyMs: [700, 900], yDelayMs: [50, 100] });
    expect(lane.failures).toBe(lane.runs);
  }, 120_000);

  afterAll(() => undefined);
});
