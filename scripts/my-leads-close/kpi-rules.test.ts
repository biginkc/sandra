import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertRulesCoverKeys, kpiKeysFromMigrationSource, RULES } from "./kpi-rules.mjs";
import { compare } from "./kpi-compare.mjs";
import { buildWindows, isProductionRef, parseArgs as parseSnapshotArgs } from "./kpi-snapshot.mjs";
import { buildManifest, migrationVersion } from "./lease-manifest.mjs";

const KPI_MIGRATION = path.resolve(__dirname, "../../supabase/migrations/20260930031000_dialpad_recording_provider_window_finalizer.sql");

describe("kpi-rules", () => {
  it("classifies every key fn_get_acquisition_kpis returns, and nothing else", () => {
    const keys = kpiKeysFromMigrationSource(readFileSync(KPI_MIGRATION, "utf8"));
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(() => assertRulesCoverKeys(keys)).not.toThrow();
    expect(() => assertRulesCoverKeys([...keys, "brandNewTile"])).toThrow(/unclassified=\[brandNewTile\]/);
    expect(() => assertRulesCoverKeys(keys.filter((k) => k !== "attempts"))).toThrow(/stale=\[attempts\]/);
  });

  it("keeps the period tiles strict and the current-state tiles out of the before/after comparison", () => {
    expect(RULES.attempts).toBe("EQUAL_IN_CLOSED_WINDOWS");
    expect(RULES.appointmentsDue).toBe("EQUAL_IN_CLOSED_WINDOWS");
    expect(RULES.pendingOutcomes).toBe("EQUAL_UNLESS_CLOSEOUT");
    expect(RULES.contactWithoutFollowUp).toBe("CURRENT_STATE_MAY_CHANGE");
    expect(RULES.appointmentsOverdue).toBe("CURRENT_STATE_MAY_CHANGE");
  });
});

describe("kpi-compare", () => {
  const row = (member: string, window: string, kpi: Record<string, unknown>) => ({ member, window, kpi });
  const base = { attempts: 3, reached: 1, offersSent: 0, pendingOutcomes: 2, contactWithoutFollowUp: 5, firstCallElapsedSeconds: 12.5 };

  it("passes when closed-window tiles match and current-state tiles differ", () => {
    const before = { rows: [row("m1", "day:2026-09-20", base)] };
    const after = { rows: [row("m1", "day:2026-09-20", { ...base, contactWithoutFollowUp: 1, firstCallElapsedSeconds: 12.5000000001 })] };
    const result = compare(before, after);
    expect(result.ok).toBe(true);
    expect(result.compared).toBeGreaterThan(0);
  });

  it("fails on a changed period tile, a missing row and an unclassified key", () => {
    const before = { rows: [row("m1", "w", base), row("m2", "w", base)] };
    const after = { rows: [row("m1", "w", { ...base, attempts: 4, mysteryTile: 1 })] };
    const result = compare(before, after);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.key).sort()).toEqual(["*", "attempts", "mysteryTile"]);
  });

  it("allows pendingOutcomes to drop by exactly the independently counted close-outs", () => {
    const before = { rows: [row("m1", "since-launch", base)] };
    const ok = compare(before, { rows: [row("m1", "since-launch", { ...base, pendingOutcomes: 0 })] }, { closeoutByWindow: { "since-launch": 2 } });
    expect(ok.ok).toBe(true);
    const bad = compare(before, { rows: [row("m1", "since-launch", { ...base, pendingOutcomes: 1 })] }, { closeoutByWindow: { "since-launch": 2 } });
    expect(bad.ok).toBe(false);
  });

  it("compares a rejected member as equal-to-itself instead of skipping it", () => {
    const before = { rows: [row("m3", "w", { error: "FORBIDDEN" })] };
    expect(compare(before, { rows: [row("m3", "w", { error: "FORBIDDEN" })] }).ok).toBe(true);
    expect(compare(before, { rows: [row("m3", "w", base)] }).ok).toBe(false);
  });
});

describe("kpi-snapshot", () => {
  it("accepts only the production project ref", () => {
    expect(isProductionRef("postgresql://postgres.copflsklaefwzipsrjqz:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toBe(true);
    expect(isProductionRef("postgresql://postgres:x@db.copflsklaefwzipsrjqz.supabase.co:5432/postgres")).toBe(true);
    expect(isProductionRef("postgresql://postgres:postgres@127.0.0.1:54329/postgres")).toBe(false);
    expect(isProductionRef("postgresql://postgres.ncsngxlcyxylaeskiteu:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toBe(false);
    expect(isProductionRef("not a url")).toBe(false);
  });

  it("builds completed Central days, the September month and the since-launch window", () => {
    const now = new Date("2026-09-15T18:00:00.000Z");
    const windows = buildWindows(now, "2026-09-12", now);
    const labels = windows.map((w) => w.label);
    expect(labels).toEqual(["day:2026-09-12", "day:2026-09-13", "day:2026-09-14", "month:2026-09", "since-launch"]);
    // Central midnight in September is 05:00Z (CDT).
    expect(windows[0]!.start).toBe("2026-09-12T05:00:00.000Z");
    expect(windows[0]!.end).toBe("2026-09-13T05:00:00.000Z");
    expect(windows.at(-1)!.end).toBe("2026-09-15T05:00:00.000Z");
  });

  it("requires uuids, a member and an output path", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    expect(() => parseSnapshotArgs(["--org", org, "--owner", org, "--member", org, "--out", "x.json"])).not.toThrow();
    expect(() => parseSnapshotArgs(["--org", "nope", "--owner", org, "--member", org, "--out", "x.json"])).toThrow(/UUID/);
    expect(() => parseSnapshotArgs(["--org", org, "--owner", org, "--out", "x.json"])).toThrow(/--member/);
  });
});

describe("lease-manifest", () => {
  const pr = {
    number: 900,
    headRefOid: "abc123def",
    baseRefName: "main",
    files: ["supabase/migrations/20261006100000_new_thing.sql", "src/lib/x.ts", "vercel.json"],
    checks: [{ name: "E2E", conclusion: "SUCCESS" }],
  };

  it("lists files and migrations in order and passes a clean PR", () => {
    const m = buildManifest({ pr, approvedSha: "abc123def", mainMigrationVersions: ["20261005180000"], openPrs: [{ number: 901, files: ["README.md"] }], vercelCronDiff: "" });
    expect(m.ok).toBe(true);
    expect(m.migrations).toEqual(["20261006100000"]);
    expect(m.files[0]).toBe("src/lib/x.ts");
    expect(m.cronChanged).toBe(false);
  });

  it("flags an older migration, a red check, a different approved SHA and an overlapping open PR", () => {
    const m = buildManifest({
      pr: { ...pr, checks: [{ name: "E2E", conclusion: "FAILURE" }] },
      approvedSha: "fff000",
      mainMigrationVersions: ["20261007000000"],
      openPrs: [{ number: 901, files: ["src/lib/x.ts"] }],
      vercelCronDiff: "+ cron",
    });
    expect(m.ok).toBe(false);
    expect(m.problems.join("\n")).toMatch(/sorts before origin\/main/);
    expect(m.problems.join("\n")).toMatch(/check E2E is FAILURE/);
    expect(m.problems.join("\n")).toMatch(/not the approved SHA/);
    expect(m.problems.join("\n")).toMatch(/open PR #901 touches src\/lib\/x.ts/);
    expect(m.cronChanged).toBe(true);
  });

  it("recognises migration versions", () => {
    expect(migrationVersion("supabase/migrations/20261006100000_x.sql")).toBe("20261006100000");
    expect(migrationVersion("supabase/rollbacks/20261006100000_x.sql")).toBeNull();
  });
});
