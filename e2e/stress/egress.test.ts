import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyOsProbe, egressChildEnv, parsePfRules, pfProofProblems, proveInProcessDenial, proveOsDenial, readEgressViolations } from "./egress";
import { LaneRefusal } from "./guards";

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
  it("classifies the OS probe: only a silent timeout proves the pf ring", () => {
    expect(classifyOsProbe("timeout")).toBe("denied");
    expect(classifyOsProbe("connected")).toBe("open");
    expect(classifyOsProbe("error:ENETUNREACH")).toBe("inconclusive");
  });
  it("the pf rules are anchored where macOS evaluates them and scoped to one uid", () => {
    const conf = readFileSync(path.join(__dirname, "egress-pf.conf"), "utf8");
    const rules = conf.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(rules.some((l) => l.startsWith("set "))).toBe(false); // options are illegal in an anchor
    expect(rules).toContain("pass quick on lo0 all");
    expect(rules.some((l) => /^block drop out log quick proto \{ tcp, udp \}.* user __UID__$/.test(l))).toBe(true);
    expect(readFileSync(path.join(__dirname, "egress-pf.sh"), "utf8")).toContain('ANCHOR="com.apple/sandra-stress"');
  });
});

describe("#7 the OS ring is proven by pf's own state and counters, not by a timeout", () => {
  const rules = (tcpPackets: number, uid = 501) => `pass quick on lo0 all
  [ Evaluations: 10  Packets: 4  Bytes: 400  States: 0 ]
block drop out log quick proto tcp from any to any user = ${uid}
  [ Evaluations: 20  Packets: ${tcpPackets}  Bytes: 180  States: 0 ]
block drop out log quick proto udp from any to any user = ${uid}
  [ Evaluations: 20  Packets: 0  Bytes: 0  States: 0 ]
`;
  const on = "Status: Enabled for 0 days 00:10:00           Debug: Urgent";
  const base = { statusText: on, rulesBefore: rules(2), rulesAfter: rules(3), uids: [501], probe: "timeout" as const };
  it("parses rules with their packet counters", () => {
    const r = parsePfRules(rules(7));
    expect(r.map((x) => x.packets)).toEqual([4, 7, 0]);
    expect(r[1]).toMatchObject({ uid: 501, proto: "tcp" });
  });
  it("a timeout alone is not proof: no rules, pf disabled, or an uncovered uid all fail", () => {
    expect(pfProofProblems({ ...base, rulesBefore: "", rulesAfter: "" }).join()).toMatch(/holds no rules/);
    expect(pfProofProblems({ ...base, statusText: "Status: Disabled" }).join()).toMatch(/not enabled/);
    expect(pfProofProblems({ ...base, rulesBefore: rules(2, 502), rulesAfter: rules(3, 502) }).join()).toMatch(/uid 501/);
    expect(pfProofProblems({ ...base, uids: [501, 777] }).join()).toMatch(/uid 777/);
  });
  it("the probe must move the block counter: an upstream filter that merely times out does not count", () => {
    expect(pfProofProblems({ ...base, rulesAfter: rules(2) }).join()).toMatch(/did not move the pf block counter/);
  });
  it("proves with active rules covering the uid and a counter that moved", () => {
    expect(pfProofProblems(base)).toEqual([]);
    expect(pfProofProblems({ ...base, probe: "connected" }).join()).toMatch(/succeeded/);
    expect(pfProofProblems({ ...base, probe: "error:ENETUNREACH" }).join()).toMatch(/not a firewall-style timeout/);
  });
  it("proveOsDenial refuses when pf state cannot be read, and when the evidence is missing; passes with it", () => {
    const state = (statusText: string, before: string, after: string) => { let n = 0; return (args: string[]) => (args[0] === "-si" ? statusText : n++ === 0 ? before : after); };
    expect(() => proveOsDenial({ uids: [501], runner: () => { throw new Error("sudo: a password is required"); }, probe: () => "timeout" })).toThrow(LaneRefusal);
    expect(() => proveOsDenial({ uids: [501], runner: state(on, rules(2), rules(2)), probe: () => "timeout" })).toThrow(/block counter/);
    expect(() => proveOsDenial({ uids: [501], runner: state(on, rules(2), rules(3)), probe: () => "timeout" })).not.toThrow();
  });
});
