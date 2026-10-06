/**
 * OS pf proof: COMPLETE coverage of the expected set, not "a block rule exists". Pure over pfctl text (the runner in egress.ts collects it).
 *
 * A rule only counts if it is understood: lines are tokenised against a small allow-list and anything else is UNKNOWN (fail closed when it could
 * matter). The expected set is every egress cell for every uid that must be covered: {inet, inet6} x {tcp, udp} (pf cannot tie ICMP to a uid: out of
 * scope, recorded in the report). A cell is covered only by a COVERING BLOCK that is REACHED: no earlier quick pass (outside lo0) wins first, across
 * the main ruleset and every anchor spliced in evaluation order.
 */

export const PF_LABEL = "sandra-stress-egress";
export type Af = "inet" | "inet6";
export type Proto = "tcp" | "udp";
export const CELL_AFS: readonly Af[] = ["inet", "inet6"];
export const CELL_PROTOS: readonly Proto[] = ["tcp", "udp"];

const ALLOWED = new Set(["block", "pass", "drop", "return", "out", "in", "log", "(all)", "quick", "on", "!", "lo0", "inet", "inet6", "proto", "tcp", "udp", "{", "}", ",", "all", "from", "to", "any", "user", "=", "label", "flags", "keep", "state", "no"]);

export function tokenizePfRule(line: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|\(all\)|[{},!=<>]|[^\s{},!=<>"]+/g;
  for (let m = re.exec(line.trim()); m; m = re.exec(line.trim())) out.push(m[0]);
  return out;
}

const isKnownToken = (t: string) => ALLOWED.has(t) || /^\d+$/.test(t) || /^"[^"]*"$/.test(t) || /^[A-Z]+\/[A-Z]+$/.test(t);

export type Rule =
  | { kind: "block"; covering: boolean; afs: Af[]; protos: Proto[]; uid: number | null; raw: string; label: string | null }
  | { kind: "pass"; quick: boolean; lo0Only: boolean; direction: "out" | "in" | "both"; afs: Af[]; protos: Proto[]; uid: number | null; unknown: boolean; raw: string }
  | { kind: "anchor"; path: string; raw: string }
  | { kind: "unknown-ours"; raw: string }
  | { kind: "irrelevant"; raw: string };

const mentionsOurs = (tokens: string[]) => tokens.includes("user") || tokens.some((t) => t === `"${PF_LABEL}"`);

/** Classify one pfctl rule line. `unknown-ours` = a rule that names a user or our label but has tokens we do not understand (restricted by port, address, interface...). */
export function classifyRule(line: string): Rule {
  const raw = line.trim();
  if (/^(scrub|no scrub|nat|no nat|rdr|no rdr|binat|dummynet|scrub-anchor|nat-anchor|rdr-anchor|dummynet-anchor)\b/.test(raw)) return { kind: "irrelevant", raw };
  const am = /^anchor\s+"([^"]+)"/.exec(raw);
  if (am) return { kind: "anchor", path: am[1]!, raw };
  if (!/^(block|pass)\b/.test(raw)) return { kind: "irrelevant", raw };
  const t = tokenizePfRule(raw);
  const action = t[0] as "block" | "pass";
  const known = t.every(isKnownToken);
  const outDir = t.includes("out");
  const inDir = t.includes("in");
  const direction: "out" | "in" | "both" = outDir ? "out" : inDir ? "in" : "both";
  const quick = t.includes("quick");
  const onIdx = t.indexOf("on");
  const lo0Only = onIdx >= 0 && t[onIdx + 1] === "lo0";
  const negatedIface = onIdx >= 0 && t[onIdx + 1] === "!" && t[onIdx + 2] === "lo0";
  const afs: Af[] = t.includes("inet6") ? ["inet6"] : t.includes("inet") ? ["inet"] : ["inet", "inet6"];
  const pi = t.indexOf("proto");
  let protos: Proto[] = ["tcp", "udp"];
  if (pi >= 0) {
    const next = t[pi + 1];
    if (next === "{") { const close = t.indexOf("}", pi); protos = t.slice(pi + 2, close).filter((x): x is Proto => x === "tcp" || x === "udp"); }
    else protos = next === "tcp" || next === "udp" ? [next] : []; // any other proto (icmp...) covers neither cell
  }
  const ui = t.indexOf("user");
  const uid = ui >= 0 && t[ui + 1] === "=" && /^\d+$/.test(t[ui + 2] ?? "") ? Number(t[ui + 2]) : null;
  const userClauseOk = ui < 0 || uid !== null;

  if (direction === "in") return { kind: "irrelevant", raw }; // egress only
  if (!known) {
    if (action === "pass" && quick) return { kind: "pass", quick, lo0Only: false, direction, afs, protos, uid, unknown: true, raw };
    if (mentionsOurs(t)) return { kind: "unknown-ours", raw };
    return { kind: "irrelevant", raw };
  }
  if (action === "pass") return { kind: "pass", quick, lo0Only, direction, afs, protos, uid, unknown: false, raw };
  // block: a covering block is quick, out/both, not restricted to an interface other than `! lo0`, src/dst any (the allow-list admits no address, port or table), exact or no user.
  const ifaceOk = onIdx < 0 || negatedIface;
  const label = /label\s+"([^"]*)"/.exec(raw)?.[1] ?? null;
  return { kind: "block", covering: quick && ifaceOk && userClauseOk, afs, protos, uid, raw, label };
}

export type EvalInput = { main: string; anchorRules: Readonly<Record<string, string>>; children: Readonly<Record<string, readonly string[]>> };

/** Splices every anchor in place, in pf's evaluation order (`path/*` = the children in alphabetical order, non-recursive; nested anchors expanded the same way). Throws on an unreadable anchor (fail closed). */
export function expandEvaluation(input: EvalInput): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, depth: number) => {
    if (depth > 8) throw new Error("anchor nesting too deep");
    for (const line of text.split("\n")) {
      if (!line.trim() || line.trim().startsWith("[")) continue; // counter lines
      const rule = classifyRule(line);
      if (rule.kind !== "anchor") { out.push(rule); continue; }
      out.push(rule);
      const paths = rule.path.endsWith("/*")
        ? [...(input.children[rule.path.slice(0, -2)] ?? (() => { throw new Error(`cannot list anchors under ${rule.path}`); })())].sort().map((c) => (c.startsWith(rule.path.slice(0, -1)) ? c : `${rule.path.slice(0, -1)}${c}`))
        : [rule.path];
      for (const p of paths) {
        const body = input.anchorRules[p];
        if (body === undefined) throw new Error(`cannot read anchor ${p}`);
        walk(body, depth + 1);
      }
    }
  };
  walk(input.main, 0);
  return out;
}

export type CoverageInput = { sequence: readonly Rule[]; uids: readonly number[]; skippedIfaces: readonly string[]; statusText: string };

export function pfCoverageProblems(i: CoverageInput): string[] {
  const p: string[] = [];
  if (!/Status:\s*Enabled/i.test(i.statusText)) p.push("pf is not enabled (`pfctl -si` does not say Enabled)");
  for (const f of i.skippedIfaces) if (f !== "lo0") p.push(`pf skips interface ${f} (set skip): its traffic is not filtered at all`);
  const loSkipped = i.skippedIfaces.includes("lo0");
  const hasLoPass = i.sequence.some((r) => r.kind === "pass" && r.quick && r.lo0Only && !r.unknown);
  if (!hasLoPass && !loSkipped) p.push("no `pass quick on lo0` rule (the app, proxy, stub and database are loopback)");
  for (const r of i.sequence) if (r.kind === "unknown-ours") p.push(`unknown or restricted rule that names our user/label (not trusted): ${r.raw}`);
  for (const uid of i.uids) {
    for (const af of CELL_AFS) for (const proto of CELL_PROTOS) {
      let covered = false;
      for (const r of i.sequence) {
        const matchesCell = (rr: { afs: Af[]; protos: Proto[] }) => rr.afs.includes(af) && rr.protos.includes(proto);
        if (r.kind === "pass" && r.quick && !r.lo0Only && r.direction !== "in" && (r.uid === null || r.uid === uid) && (r.unknown || matchesCell(r))) {
          p.push(`uid ${uid} ${af}/${proto}: a quick pass rule is reached before any covering block (${r.raw})`);
          covered = true; // reported; stop scanning this cell
          break;
        }
        if (r.kind === "block" && r.covering && matchesCell(r) && (r.uid === uid || r.uid === null)) { covered = true; break; }
      }
      if (!covered) p.push(`uid ${uid} ${af}/${proto} is not covered by a blocking out rule that applies to any destination`);
    }
  }
  return p;
}

export type ProbeResult = { name: string; proto: Proto; outcome: string; required: boolean; countersBefore: number | null; countersAfter: number | null };

/** The labelled covering blocks' packet counters for a protocol, from `pfctl -a <anchor> -vsr` text. */
export function labelledPackets(rulesText: string, proto: Proto): number {
  let total = 0;
  const lines = rulesText.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!.trim();
    if (!/^block\b/.test(l) || !l.includes(`label "${PF_LABEL}"`) || !new RegExp(`\\bproto ${proto}\\b`).test(l)) continue;
    const m = /Packets:\s*(\d+)/.exec(lines[i + 1] ?? "");
    if (m) total += Number(m[1]);
  }
  return total;
}

export function probeProblems(probes: readonly ProbeResult[]): string[] {
  const p: string[] = [];
  for (const pr of probes) {
    if (!pr.required) continue;
    if (pr.proto === "tcp" && pr.outcome === "connected") p.push(`probe ${pr.name}: a non-loopback connection succeeded`);
    else if (pr.proto === "tcp" && pr.outcome !== "timeout") p.push(`probe ${pr.name}: saw "${pr.outcome}", not a firewall-style timeout`);
    if (pr.countersBefore === null || pr.countersAfter === null || pr.countersAfter <= pr.countersBefore) p.push(`probe ${pr.name}: the labelled ${pr.proto} block counter did not move (before ${pr.countersBefore}, after ${pr.countersAfter})`);
  }
  return p;
}

/** Parses `pfctl -vsI` for skipped interfaces (`en0 (skip)` or a `Flags: skip` line under an interface). */
export function skippedInterfaces(text: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    const inline = /^(\S+)\s+\(skip\)/.exec(l);
    if (inline) { out.push(inline[1]!); continue; }
    if (/^\S+$/.test(raw) && l) current = l;
    else if (current && /skip/i.test(l) && /flags/i.test(l)) out.push(current);
  }
  return out;
}

export const OS_EGRESS_NOTES = {
  dns: "DNS lookups on macOS are answered by mDNSResponder (its own uid) and are not stopped by a uid rule; no provider API is reachable that way and the in-process guard denies dns from the app.",
  icmp: "ICMP cannot be tied to a uid in pf and is out of scope (no provider API is reachable over ICMP).",
  inet6NoRoute: "inet6 probe: no IPv6 route (structural coverage only).",
} as const;
