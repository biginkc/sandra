import { appendFileSync, readFileSync, mkdtempSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { snapshotLog } from "./app-proof";
import { BackgroundChecks } from "./background-checks";
import { scanServerLog } from "./engine";

const log = (lines: string[]) => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "scan-")), "app.log");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
};
const zero = (f: string) => ({ ino: statSync(f).ino, size: 0 });
const FETCH = "[browser] ⨯ unhandledRejection: TypeError: Failed to fetch";

describe("server log scan", () => {
  it("flags 5xx and unhandled rejections", () => {
    const f = log([" GET /x 500 in 12ms", "⨯ unhandledRejection: Error: boom", " GET /y 200 in 3ms"]);
    expect(scanServerLog(f, zero(f))).toHaveLength(2);
  });
  it("tolerates exactly as many offline-gesture fetch failures as gestures ran, never more", () => {
    const f = log([FETCH, FETCH]);
    expect(scanServerLog(f, zero(f), { injectedOfflineFetchFailures: 2 })).toEqual([]);
    expect(scanServerLog(f, zero(f), { injectedOfflineFetchFailures: 1 })).toHaveLength(1);
    expect(scanServerLog(f, zero(f))).toHaveLength(2);
  });
  it("does not tolerate any other rejection, even when a fetch failure is allowed", () => {
    const f = log([FETCH, "⨯ unhandledRejection: TypeError: other"]);
    expect(scanServerLog(f, zero(f), { injectedOfflineFetchFailures: 1 })).toHaveLength(1);
  });
  it("a byte offset past multibyte text still starts at the right byte", () => {
    const f = log(["Zoë ✓ 日本語 ñandú 🚫"]);
    const snap = snapshotLog(f)!;
    appendFileSync(f, " GET /z 500 in 9ms\n");
    expect(scanServerLog(f, snap)).toHaveLength(1);
  });
  it("fails closed: a T0 offset of 4096 with a replacement log holding a 500 is a violation (replaced, not 'clean')", () => {
    const f = log(["x".repeat(5000)]);
    const snap = { ino: statSync(f).ino, size: 4096 };
    const dir = path.dirname(f);
    const repl = path.join(dir, "app.log.new");
    writeFileSync(repl, " GET /x 500 in 12ms\n" + "y".repeat(6000) + "\n");
    renameSync(repl, f); // a new inode over the same path
    const out = scanServerLog(f, snap);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(" ")).toMatch(/replaced or rotated/);
  });
  it("fails closed on a truncated, deleted or never-snapshotted log", () => {
    const f = log(["x".repeat(5000)]);
    const snap = snapshotLog(f)!;
    truncateSync(f, 100);
    expect(scanServerLog(f, snap).join(" ")).toMatch(/truncated/);
    unlinkSync(f);
    expect(scanServerLog(f, snap).join(" ")).toMatch(/not found/);
    expect(scanServerLog(f, null).join(" ")).toMatch(/never snapshotted/);
  });
});

describe("background invariant checks are awaited and folded in before the verdict", () => {
  it("a check still running at finish is awaited, and its late violation is returned", async () => {
    const bg = new BackgroundChecks();
    let done = false;
    bg.start(async () => { await new Promise((r) => setTimeout(r, 40)); done = true; return ["invariant 7 (x) violated mid-run"]; });
    expect(done).toBe(false);
    const failures = await bg.settle();
    expect(done).toBe(true);
    expect(failures).toEqual(["invariant 7 (x) violated mid-run"]);
  });
  it("a check that throws is a failure, and nothing starts after settle", async () => {
    const bg = new BackgroundChecks();
    bg.start(async () => { throw new Error("db gone"); });
    expect((await bg.settle())[0]).toMatch(/failed to run: db gone/);
    bg.start(async () => ["late"]);
    expect(await bg.settle()).not.toContain("late");
  });
  it("the engine settles the tracker before decide() and again in its finally, and a folded failure is never a PASS", () => {
    const eng = readFileSync(path.join(__dirname, "engine.ts"), "utf8");
    expect(eng.indexOf("await background.settle()")).toBeGreaterThan(0);
    expect(eng.lastIndexOf("await background.settle()")).toBeLessThan(eng.indexOf("decide({"));
    expect(eng).toMatch(/finally \{[\s\S]*await background\.settle\(\)/);
  });
});
