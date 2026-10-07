import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { egressChildEnv, proveInProcessDenial, readEgressViolations } from "./egress";

describe("egress guard", () => {
  it("denies a non-loopback connect, logs it, and the probe proof passes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "egress-"));
    const log = path.join(dir, "egress.jsonl");
    proveInProcessDenial(log);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toMatch(/192\.0\.2\.1/);
    expect(readEgressViolations(log)).toEqual([]); // probes are excluded from the failure count
  });
  it("a real (non-probe) denial is counted as a violation and DNS is denied too", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "egress-"));
    const log = path.join(dir, "egress.jsonl");
    const code = `require("node:dns").lookup("example.com", (e) => process.exit(e && e.code === "EGRESS_DENIED" ? 0 : 5));`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, ...egressChildEnv(log) }, timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(readEgressViolations(log)).toHaveLength(1);
  });
  it("allows loopback", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "egress-"));
    const code = `const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{const c=require("node:net").connect(s.address().port,"127.0.0.1",()=>{c.destroy();s.close();process.exit(0)})})`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, ...egressChildEnv(path.join(dir, "e.jsonl")) }, timeout: 10_000 });
    expect(r.status).toBe(0);
  });
  it("the pf rules are anchored where macOS evaluates them and scoped to one uid", () => {
    const conf = readFileSync(path.join(__dirname, "egress-pf.conf"), "utf8");
    const rules = conf.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(rules.some((l) => l.startsWith("set "))).toBe(false); // options are illegal in an anchor
    expect(rules).toContain("pass quick on lo0 all");
    expect(rules.some((l) => /^block drop out log quick proto \{ tcp, udp \} from any to any user __UID__ label "sandra-stress-egress"$/.test(l))).toBe(true);
    expect(readFileSync(path.join(__dirname, "egress-pf.sh"), "utf8")).toContain('ANCHOR="com.apple/sandra-stress"');
  });
});
