import { describe, expect, it } from "vitest";

import { proveOsDenial, type PfRunner } from "./egress";
import { LaneRefusal } from "./guards";
import { classifyRule, expandEvaluation, labelledPackets, pfCoverageProblems, probeProblems, skippedInterfaces, tokenizePfRule, type EvalInput, type ProbeResult } from "./pf-proof";

const U = 501;
const ON = "Status: Enabled for 0 days 00:10:00           Debug: Urgent";
const LABEL = 'label "sandra-stress-egress"';
const counters = (tcp: number, udp = 0) => `pass quick on lo0 all flags S/SA keep state
  [ Evaluations: 10  Packets: 4  Bytes: 400  States: 0 ]
block drop out log quick proto tcp from any to any user = ${U} ${LABEL}
  [ Evaluations: 20  Packets: ${tcp}  Bytes: 180  States: 0 ]
block drop out log quick proto udp from any to any user = ${U} ${LABEL}
  [ Evaluations: 20  Packets: ${udp}  Bytes: 0  States: 0 ]
`;
const canonical = counters(0);
const MAIN = 'scrub-anchor "com.apple/*" all fragment reassemble\nanchor "com.apple/*" all\n';
const ev = (anchorBody: string, extra: Partial<EvalInput> = {}): EvalInput => ({ main: MAIN, anchorRules: { "com.apple/sandra-stress": anchorBody }, children: { "com.apple": ["com.apple/sandra-stress"] }, ...extra });
const problems = (anchorBody: string, opts: { uids?: number[]; skipped?: string[]; status?: string; input?: Partial<EvalInput> } = {}) =>
  pfCoverageProblems({ sequence: expandEvaluation(ev(anchorBody, opts.input)), uids: opts.uids ?? [U], skippedIfaces: opts.skipped ?? ["lo0"], statusText: opts.status ?? ON });
const LO = "pass quick on lo0 all flags S/SA keep state\n";

describe("(a) the pf proof demands COMPLETE coverage of the expected set", () => {
  it("a1 Astra: a rule blocking ONLY IPv4 TCP to 1.1.1.1:443 is refused (it used to return [])", () => {
    const only = `${LO}block drop out quick proto tcp from any to 1.1.1.1 port 443 user = ${U}\n`;
    const p = problems(only).join(" | ");
    expect(p).toMatch(/unknown or restricted rule that names our user/);
    expect(p).toMatch(/inet\/udp is not covered/);
    expect(p).toMatch(/inet6\/tcp is not covered/);
  });
  it("a2 a port-restricted rule is refused", () => {
    expect(problems(`${LO}block drop out quick proto tcp from any to any port 443 user = ${U}\nblock drop out quick proto udp from any to any user = ${U}\n`).join()).toMatch(/restricted rule|not covered/);
  });
  it("a3 an inet-only rule leaves inet6 uncovered", () => {
    const p = problems(`${LO}block drop out quick inet proto { tcp, udp } all user = ${U}\n`.replace("{ tcp, udp }", "tcp") + `block drop out quick inet proto udp all user = ${U}\n`).join();
    expect(p).toMatch(/inet6\/tcp is not covered/);
    expect(p).toMatch(/inet6\/udp is not covered/);
  });
  it("a4 a tcp-only rule leaves udp uncovered", () => {
    expect(problems(`${LO}block drop out quick proto tcp from any to any user = ${U}\n`).join()).toMatch(/\/udp is not covered/);
  });
  it("a5 a non-exact user clause is refused (user != 501, user < 1000)", () => {
    expect(problems(`${LO}block drop out quick proto tcp from any to any user != ${U}\nblock drop out quick proto udp from any to any user < 1000\n`).join()).toMatch(/not covered|unknown or restricted/);
  });
  it("a6 an interface-restricted block is refused", () => {
    expect(problems(`${LO}block drop out quick on en0 proto tcp from any to any user = ${U}\nblock drop out quick on en0 proto udp from any to any user = ${U}\n`).join()).toMatch(/not covered|unknown or restricted/);
  });
  it("a7 a negated destination or a table destination is refused", () => {
    expect(problems(`${LO}block drop out quick proto tcp from any to ! 10.0.0.0/8 user = ${U}\nblock drop out quick proto udp from any to <x> user = ${U}\n`).join()).toMatch(/not covered|unknown or restricted/);
  });
  it("a8 an unknown token on our own rule (tagged, probability) is refused", () => {
    expect(problems(`${LO}block drop out quick proto tcp from any to any user = ${U} tagged FOO\nblock drop out quick proto udp from any to any user = ${U} probability 50%\n`).join()).toMatch(/unknown or restricted/);
  });
  it("a9 a quick pass in the main ruleset before the anchor wins first", () => {
    const p = problems(canonical, { input: { main: `pass out quick all flags S/SA keep state\n${MAIN}` } }).join();
    expect(p).toMatch(/a quick pass rule is reached before any covering block/);
  });
  it("a10 an earlier-sorting sibling anchor with a quick pass wins first", () => {
    const p = problems(canonical, { input: { anchorRules: { "com.apple/200.x": "pass out quick proto tcp all flags S/SA keep state\n", "com.apple/sandra-stress": canonical }, children: { "com.apple": ["com.apple/sandra-stress", "com.apple/200.x"] } } }).join();
    expect(p).toMatch(/inet\/tcp: a quick pass rule is reached/);
    expect(p).toMatch(/inet6\/tcp: a quick pass rule is reached/);
  });
  it("a11 a non-quick pass before our quick block is harmless", () => {
    expect(problems(canonical, { input: { main: `pass out all flags S/SA keep state\n${MAIN}` } })).toEqual([]);
  });
  it("a12 a skipped non-loopback interface is refused", () => {
    expect(problems(canonical, { skipped: ["lo0", "en0"] }).join()).toMatch(/skips interface en0/);
    expect(skippedInterfaces("lo0 (skip)\nen0 (skip)\nen1\n")).toEqual(["lo0", "en0"]);
    expect(skippedInterfaces("en0\n   Flags: skip\nlo0\n")).toEqual(["en0"]);
  });
  it("a13 the canonical conf rendered for 501 (tcp and udp lines, no family) is accepted", () => {
    expect(problems(canonical)).toEqual([]);
  });
  it("a14 every uid must be covered: 501 covered, 502 not", () => {
    expect(problems(canonical, { uids: [501, 502] }).join()).toMatch(/uid 502 inet\/tcp is not covered/);
  });
  it("a15 a probe whose labelled counter did not move is refused (an upstream filter that merely times out)", () => {
    const pr: ProbeResult = { name: "tcp4 9.9.9.9:80", proto: "tcp", outcome: "timeout", required: true, countersBefore: 5, countersAfter: 5 };
    expect(probeProblems([pr]).join()).toMatch(/counter did not move/);
    expect(probeProblems([{ ...pr, countersAfter: 6 }])).toEqual([]);
    expect(probeProblems([{ ...pr, countersAfter: 6, outcome: "connected" }]).join()).toMatch(/succeeded/);
    expect(labelledPackets(counters(7, 2), "tcp")).toBe(7);
    expect(labelledPackets(counters(7, 2), "udp")).toBe(2);
  });
  it("a16 no IPv6 route: structural coverage still required, and the report says the probe was skipped", () => {
    const run = scripted();
    const notes = proveOsDenial({ uids: [U], runner: run.runner, probe: run.probe, ipv6Route: () => false });
    expect(notes.join()).toMatch(/no IPv6 route \(structural coverage only\)/);
    expect(notes.join()).toMatch(/mDNSResponder/);
    expect(notes.join()).toMatch(/ICMP/);
  });
  it("a17 an unreadable anchor fails closed", () => {
    expect(() => expandEvaluation({ main: MAIN, anchorRules: {}, children: { "com.apple": ["com.apple/x"] } })).toThrow(/cannot read anchor/);
    const run = scripted({ failOn: (a) => a[0] === "-a" && a[1] === "com.apple/sandra-stress" && a[2] === "-sr" });
    expect(() => proveOsDenial({ uids: [U], runner: run.runner, probe: run.probe, ipv6Route: () => false })).toThrow(LaneRefusal);
  });
  it("a18 `from any to any` and `all` are both accepted", () => {
    expect(problems(`${LO}block drop out quick proto tcp all user = ${U}\nblock drop out quick proto udp from any to any user = ${U}\n`)).toEqual([]);
  });
  it("a19 a loopback pass that also names another interface is refused", () => {
    const p = problems(`pass quick on lo0 on en0 all\n${canonical.split("\n").slice(2).join("\n")}`).join();
    expect(p).toMatch(/no `pass quick on lo0`|quick pass rule is reached/);
  });
  it("tokenizer: a quoted label and braces tokenise; an unknown word is detected", () => {
    expect(tokenizePfRule(`block drop out quick proto { tcp, udp } all user = 501 ${LABEL}`)).toContain('"sandra-stress-egress"');
    expect(classifyRule("block out quick proto tcp from any to any user = 501 tagged X").kind).toBe("unknown-ours");
    expect(classifyRule("pass in quick proto tcp from any to any port 22").kind).toBe("irrelevant");
  });
  it("pf disabled is refused", () => {
    expect(problems(canonical, { status: "Status: Disabled" }).join()).toMatch(/not enabled/);
  });
});

/** A scripted pfctl: canonical ruleset, counters that move with each probe. */
function scripted(opts: { failOn?: (args: string[]) => boolean; tcpMoves?: boolean } = {}) {
  let tcp = 0;
  const runner: PfRunner = (args) => {
    if (opts.failOn?.(args)) throw new Error("pfctl: DIOCGETRULES: Operation not permitted");
    const j = args.join(" ");
    if (j === "-si") return ON;
    if (j === "-vsI") return "lo0 (skip)\nen0\n";
    if (j === "-sr") return MAIN;
    if (j === "-a com.apple -sA") return "com.apple/sandra-stress\n";
    if (j === "-a com.apple/sandra-stress -sr") return canonical;
    if (j === "-a com.apple/sandra-stress -vsr") return counters(tcp, tcp);
    throw new Error(`unexpected pfctl ${j}`);
  };
  const probe = (s: { proto: string }) => { if (opts.tcpMoves !== false) tcp += 1; return s.proto === "tcp" ? "timeout" : "sent"; };
  return { runner, probe };
}

describe("(a) the full proof, end to end over a scripted pfctl", () => {
  it("passes when structure holds and every probe moves its counter", () => {
    const run = scripted();
    expect(() => proveOsDenial({ uids: [U], runner: run.runner, probe: run.probe, ipv6Route: () => false })).not.toThrow();
  });
  it("is refused when the probes do not move the counters", () => {
    const run = scripted({ tcpMoves: false });
    expect(() => proveOsDenial({ uids: [U], runner: run.runner, probe: run.probe, ipv6Route: () => false })).toThrow(/counter did not move/);
  });
  it("is refused when pfctl cannot be run at all (no sudo)", () => {
    expect(() => proveOsDenial({ uids: [U], runner: () => { throw new Error("sudo: a password is required"); }, probe: () => "timeout" })).toThrow(/OS_EGRESS_UNVERIFIABLE|cannot read the pf state/);
  });
});
