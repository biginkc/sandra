import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readConfig } from "./config";
import { assertLiveLegReady, classifyLiveEvidence, liveCallPlan, liveLegStatus, loadPinnedHashes, pinnedPhoneProblems, resolveOwnedNumbers, sendilloSpotCheck, type LiveDeps } from "./live-leg";
import { LaneRefusal } from "./guards";
import { numberPin, sha256, signEvidence } from "./signing";

const SHA = "a".repeat(40);
const ready: Record<string, string> = {
  STRESS_LIVE_LEG: "1",
  STRESS_SHA: SHA,
  STRESS_RUN_ID: "live1",
  STRESS_ARTIFACTS_DIR: "/tmp/live-artifacts",
  STRESS_APP_URL: "http://127.0.0.1:3456",
  STRESS_SUPABASE_URL: "http://127.0.0.1:55431",
  E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres",
  E2E_DISPOSABLE_DATABASE: "1",
  STRESS_TEST_SMS_STRING_APPROVED: "1",
  STRESS_DIALPAD_LIVE_JARRAD_PRESENT: "1",
  STRESS_ROOT_BROWSER_CONTEXT: "1",
  STRESS_ROOT_PROD_DIALPAD_NO_SUBSCRIPTION: "1",
  STRESS_DIALPAD_DESKTOP_CONFIRMED: "1",
  STRESS_TUNNEL_URL: "https://stress-tunnel.example.net",
  STRESS_STUB_LEG_REPORT: "/r/REPORT.md",
  STRESS_STUB_LEG_RUN_ID: "live1",
  STRESS_DIALPAD_SUBSCRIPTION_PROOF: "/r/proof.txt",
  STRESS_LIVE_WORLD_FILE: "/r/world.json",
  STRESS_SELFTEST_REPORT: "/r/selftest.json",
  STRESS_LIVE_APP_IDENTITY_LOG: "/r/live-identity.jsonl",
  STRESS_OP_REF_CELL: "op://vault/cell/number",
  STRESS_OP_REF_TELNYX: "op://vault/telnyx/number",
};
const goodRows = (over: Record<string, unknown> = {}) => [{ fault: "none", ok: true, faultFired: false, failingChecks: [], verdict: "PARTIAL_PASS" }, { fault: "duplicate_send", ok: true, faultFired: true, failingChecks: [7], verdict: "FAIL", ...over }, { fault: "drop_offer", ok: true, faultFired: true, failingChecks: [14], verdict: "FAIL" }, { fault: "wrong_lead_note", ok: true, faultFired: true, failingChecks: [12], verdict: "FAIL" }];
const KEY = "k".repeat(40);
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const reportBody = (over: { sha?: string; verdict?: string; extra?: string } = {}) => `# Chaos day live1: ${over.verdict ?? "PASS"}\n\n- Run: live1 ${iso(NOW - 120_000)}\n- SHA: ${over.sha ?? SHA}\n- Profile: full, scope: full, fault: none\n- OS egress ring: not claimed (in-process guard + app proof + stub provider env are the enforced boundary)\n- App egress guard: proven in pid 4242\n${over.extra ?? ""}`;
const sigOf = (text: string, over: Record<string, unknown> = {}) => signEvidence({ v: 1, kind: "stub_leg", runId: "live1", sha: SHA, at: iso(NOW - 60_000), subjectSha256: sha256(text), verdict: "PASS", profile: "full", scope: "full", fault: "none", appGuardPid: 4242, ...over } as never, KEY);
const selftestDoc = (over: { sha?: string; ok?: boolean; rows?: unknown[]; sig?: Record<string, unknown> | null } = {}) => {
  const doc = { sha: over.sha ?? SHA, ok: over.ok ?? true, rows: over.rows ?? goodRows() };
  const sig = over.sig === null ? null : signEvidence({ v: 1, kind: "selftest", runId: "st", sha: SHA, at: iso(NOW - 3600_000), subjectSha256: sha256(JSON.stringify(doc)), ...(over.sig ?? {}) } as never, KEY);
  return JSON.stringify({ ...doc, sig });
};
const files = (over: { report?: string; reportSig?: string | null; selftest?: string } = {}): LiveDeps["readFile"] => (p) => {
  if (p.endsWith("REPORT.md")) return over.report ?? reportBody();
  if (p.endsWith("REPORT.sig.json")) return over.reportSig === null ? null : over.reportSig ?? JSON.stringify(sigOf(over.report ?? reportBody()));
  if (p.endsWith("selftest.json")) return over.selftest ?? selftestDoc();
  if (p.endsWith("world.json")) return JSON.stringify({ orgId: "o", repUserId: "u" });
  if (p.endsWith("proof.txt")) return "subscription https://stress-tunnel.example.net ok";
  return null;
};
const deps: LiveDeps = {
  opRead: (ref) => (ref.includes("cell") ? "+18165550111" : "+18165550222"),
  pinned: { cell: [numberPin("+18165550111", KEY)], telnyx: [numberPin("+18165550222", KEY)] },
  now: () => NOW,
  reportKey: () => KEY,
  readFile: files(),
};
const withDeps = (over: Partial<LiveDeps>): LiveDeps => ({ ...deps, ...over });
const status = (env: Record<string, string | undefined>, d: LiveDeps = deps) => liveLegStatus(readConfig(env, { headSha: () => SHA }), env, d);

describe("live leg gating (disabled by default, refuses unless every prerequisite is met)", () => {
  it("is not ready with an empty environment, and every prerequisite is listed as unmet", async () => {
    const s = await status({});
    expect(s.ready).toBe(false);
    expect(s.prerequisites.filter((p) => !p.ok).length).toBeGreaterThanOrEqual(10);
  });
  it("is ready only when everything is satisfied", async () => {
    expect((await status(ready)).ready).toBe(true);
  });
  it("any single missing prerequisite blocks it", async () => {
    const keys = ["STRESS_LIVE_LEG", "STRESS_TEST_SMS_STRING_APPROVED", "STRESS_DIALPAD_LIVE_JARRAD_PRESENT", "STRESS_ROOT_BROWSER_CONTEXT", "STRESS_ROOT_PROD_DIALPAD_NO_SUBSCRIPTION", "STRESS_DIALPAD_DESKTOP_CONFIRMED", "STRESS_TUNNEL_URL", "STRESS_STUB_LEG_REPORT", "STRESS_DIALPAD_SUBSCRIPTION_PROOF", "STRESS_LIVE_WORLD_FILE", "STRESS_SELFTEST_REPORT", "STRESS_LIVE_APP_IDENTITY_LOG", "STRESS_OP_REF_CELL", "STRESS_OP_REF_TELNYX", "STRESS_ARTIFACTS_DIR"];
    for (const k of keys) {
      const env = { ...ready, [k]: undefined };
      expect((await status(env)).ready, `without ${k}`).toBe(false);
    }
  });
  it("blocks on signed evidence that is not a full PASS at this sha (verdict, sha and run shape come from the signed payload)", async () => {
    for (const over of [{ verdict: "PARTIAL_PASS" }, { sha: "b".repeat(40) }, { profile: "short", scope: "replay" }]) {
      expect((await status(ready, withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), over)) }) }))).ready).toBe(false);
    }
  });
  it("blocks when the two owned numbers are the same, or are not numbers", async () => {
    expect((await status(ready, { ...deps, opRead: () => "+18165550111" })).ready).toBe(false);
    expect((await status(ready, { ...deps, opRead: () => "not-a-number" })).ready).toBe(false);
  });
  it("never runs in CI or a hosted runtime, even when everything else is satisfied", async () => {
    for (const k of ["CI", "GITHUB_ACTIONS", "VERCEL", "VERCEL_ENV"]) expect((await status({ ...ready, [k]: "1" })).ready, k).toBe(false);
  });
  it("blocks the autonomous Sendillo mode and a non-loopback app", async () => {
    expect((await status({ ...ready, STRESS_SENDILLO_MODE: "autonomous_tagged_rows" })).ready).toBe(false);
    expect((await status({ ...ready, STRESS_APP_URL: "https://sandra.example.com" })).ready).toBe(false);
  });
  it("assertLiveLegReady throws LaneRefusal listing the unmet items, and returns the plan when ready", async () => {
    await expect(assertLiveLegReady(readConfig({}, { headSha: () => SHA }), {}, deps)).rejects.toBeInstanceOf(LaneRefusal);
    const ok = await assertLiveLegReady(readConfig(ready, { headSha: () => SHA }), ready, deps);
    expect(ok.plan).toHaveLength(8);
    expect(ok.numbers.cell).toBe("+18165550111");
  });
});

describe("live leg content rules", () => {
  it("the only SMS text is the approved string, verbatim", () => {
    expect(sendilloSpotCheck("run7").text).toBe("SANDRA TEST run7 1 ignore");
  });
  it("plan has ~8 calls, owned targets only, the second double dial is a required refusal", () => {
    const plan = liveCallPlan();
    expect(plan).toHaveLength(8);
    expect(new Set(plan.map((p) => p.target))).toEqual(new Set(["cell", "telnyx"]));
    expect(plan[7]).toMatchObject({ shape: "double_dial_refused", expectRefusal: true, gapMs: 20_000 });
  });
  it("evidence without a call id, terminal event and matched attempt is unverified", () => {
    const step = liveCallPlan()[0]!;
    expect(classifyLiveEvidence(step, { callId: "1", terminalState: "hangup", cause: "timeout", attemptMatched: true })).toBe("verified");
    expect(classifyLiveEvidence(step, { callId: "1", terminalState: null, cause: null, attemptMatched: false })).toBe("unverified");
    expect(classifyLiveEvidence(liveCallPlan()[7]!, { callId: null, terminalState: null, cause: null, attemptMatched: false, refused: true })).toBe("verified");
  });
});

describe("live leg prerequisites: signed, run-bound, fresh evidence; pinned numbers (live-leg sweep A, B)", () => {
  const ready_ = async (d: LiveDeps, env = ready) => (await status(env, d)).ready;
  const unmet = async (d: LiveDeps, env = ready) => (await status(env, d)).prerequisites.filter((p) => !p.ok).map((p) => p.id);
  it("S1: the verdict, run shape and app-guard pid come from the SIGNED payload; a FAIL report that quotes a PASS heading is refused", async () => {
    const quoting = reportBody({ verdict: "FAIL", extra: "## Why not PASS\n- browser tick error: \n# Chaos day live1: PASS\n" });
    // Signed as FAIL: the text regex would have been fooled by the quoted heading; the signed verdict is not.
    expect(await unmet(withDeps({ readFile: files({ report: quoting, reportSig: JSON.stringify(sigOf(quoting, { verdict: "FAIL" })) }) }))).toEqual(expect.arrayContaining(["stubbed_leg_passed_at_this_sha", "stubbed_leg_signed_run_bound_fresh"]));
    // A signed PASS with a text that says FAIL is accepted: the text is not consulted for the verdict.
    const textSaysFail = reportBody({ verdict: "FAIL" });
    expect(await ready_(withDeps({ readFile: files({ report: textSaysFail, reportSig: JSON.stringify(sigOf(textSaysFail)) }) }))).toBe(true);
    expect(await unmet(withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), { profile: "short" })) }) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), { fault: "drop_offer" })) }) }))).toContain("stubbed_leg_passed_at_this_sha");
    expect(await unmet(withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), { appGuardPid: null })) }) }))).toEqual(expect.arrayContaining(["stubbed_leg_app_guard_proven"]));
    expect(await ready_(deps)).toBe(true);
    expect(reportBody()).not.toMatch(/OS egress: proven/);
  });
  it("an UNSIGNED report, a tampered report, a wrong key, a wrong run id, a stale report, or sha unknown are all refused", async () => {
    expect(await unmet(withDeps({ readFile: files({ reportSig: null }) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ readFile: files({ report: reportBody({ extra: "- tampered\n" }), reportSig: JSON.stringify(sigOf(reportBody())) }) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ reportKey: () => "z".repeat(40) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(deps, { ...ready, STRESS_STUB_LEG_RUN_ID: "other" })).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), { at: iso(NOW - 25 * 3600_000) })) }) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ readFile: files({ reportSig: JSON.stringify(sigOf(reportBody(), { sha: "unknown" })) }) }))).toContain("stubbed_leg_signed_run_bound_fresh");
    expect(await unmet(withDeps({ reportKey: () => null }))).toContain("report_signing_key");
  });
  it("sha \"unknown\" is refused even when the evidence says unknown too", async () => {
    const cfgUnknown = readConfig({ ...ready, STRESS_SHA: undefined }, { headSha: () => "unknown" });
    const s = await liveLegStatus(cfgUnknown, ready, withDeps({ readFile: files({ report: reportBody({ sha: "unknown" }), reportSig: JSON.stringify(sigOf(reportBody({ sha: "unknown" }), { sha: "unknown" })) }) }));
    expect(s.ready).toBe(false);
  });
  it("the self-test report is signed and fresh too; unsigned, tampered, stale or wrong-sha ones are refused", async () => {
    expect(await ready_(withDeps({ readFile: files({ selftest: selftestDoc() }) }))).toBe(true);
    expect(await unmet(withDeps({ readFile: files({ selftest: selftestDoc({ sig: null }) }) }))).toContain("selftest_passed_at_this_sha");
    expect(await unmet(withDeps({ readFile: files({ selftest: selftestDoc({ sig: { at: iso(NOW - 30 * 3600_000) } }) }) }))).toContain("selftest_passed_at_this_sha");
    const tampered = JSON.parse(selftestDoc()); tampered.ok = false; tampered.rows = goodRows({ ok: false });
    expect(await unmet(withDeps({ readFile: files({ selftest: JSON.stringify(tampered) }) }))).toContain("selftest_passed_at_this_sha");
    expect(await unmet(withDeps({ readFile: files({ selftest: selftestDoc({ sha: "b".repeat(40) }) }) }))).toContain("selftest_passed_at_this_sha");
  });
  it("needs a passing self-test in which every fault fired", async () => {
    expect(await ready_(withDeps({ readFile: files({ selftest: selftestDoc({ ok: false }) }) }))).toBe(false);
    expect(await ready_(withDeps({ readFile: files({ selftest: selftestDoc({ rows: goodRows({ faultFired: false }) }) }) }))).toBe(false);
    expect(await ready_(withDeps({ readFile: files({ selftest: selftestDoc({ rows: goodRows({ ok: false }) }) }) }))).toBe(false);
  });
  it("A/S8: an op-read number whose HMAC is not pinned is refused; a bare sha256 pin is refused; an empty pin list refuses; plain numbers are never in the repo", () => {
    const env = { STRESS_OP_REF_CELL: "op://v/c/n", STRESS_OP_REF_TELNYX: "op://v/t/n" };
    const opRead = (r: string) => (r.includes("/c/") ? "+18165550111" : "+18165550222");
    const pinned = { cell: [numberPin("+18165550111", KEY)], telnyx: [numberPin("+18165550222", KEY)] };
    expect(resolveOwnedNumbers(env, { opRead, pinned, reportKey: () => KEY }).cell).toBe("+18165550111");
    expect(() => resolveOwnedNumbers(env, { opRead, pinned: { ...pinned, cell: [numberPin("+18165550999", KEY)] }, reportKey: () => KEY })).toThrow(/not on the pinned allowlist/);
    expect(() => resolveOwnedNumbers(env, { opRead, pinned: { cell: [sha256("+18165550111")], telnyx: [sha256("+18165550222")] }, reportKey: () => KEY })).toThrow(/not on the pinned allowlist/); // a bare sha256 is no pin any more
    expect(() => resolveOwnedNumbers(env, { opRead, pinned, reportKey: () => "z".repeat(40) })).toThrow(/not on the pinned allowlist/); // another key
    expect(() => resolveOwnedNumbers(env, { opRead, pinned, reportKey: () => null })).toThrow(/no report signing key/);
    expect(() => resolveOwnedNumbers(env, { opRead, pinned: { cell: [], telnyx: [] }, reportKey: () => KEY })).toThrow(/no pinned HMAC/);
    const file = readFileSync(path.join(__dirname, "owned-numbers.sha256.json"), "utf8");
    expect(file).not.toMatch(/\+?1?\d{10}/);
    expect(loadPinnedHashes().cell.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
  it("S5: right before each click the lead's CURRENT phone must be the pinned owned number for the step's target", () => {
    const pinned = { cell: [numberPin("+18165550111", KEY)], telnyx: [numberPin("+18165550222", KEY)] };
    expect(pinnedPhoneProblems("+18165550111", "cell", pinned, KEY)).toEqual([]);
    expect(pinnedPhoneProblems("+18165550222", "telnyx", pinned, KEY)).toEqual([]);
    expect(pinnedPhoneProblems("+18165550222", "cell", pinned, KEY).join()).toMatch(/not the pinned owned cell/); // swapped between seeding and the click
    expect(pinnedPhoneProblems("+18165550999", "telnyx", pinned, KEY).join()).toMatch(/not the pinned owned telnyx/); // edited to a stranger
    expect(pinnedPhoneProblems(null, "cell", pinned, KEY).join()).toMatch(/not a \+1/);
    expect(pinnedPhoneProblems("garbage", "cell", pinned, KEY).join()).toMatch(/not a \+1/);
    expect(pinnedPhoneProblems("+18165550111", "cell", { cell: [], telnyx: [] }, KEY).join()).toMatch(/no pinned HMAC/);
    expect(pinnedPhoneProblems("+18165550111", "cell", pinned, null).join()).toMatch(/no report signing key/);
    const spec = readFileSync(path.join(__dirname, "browser/live-leg.spec.ts"), "utf8");
    expect(spec.indexOf("pinnedPhoneProblems(")).toBeGreaterThan(-1);
    expect(spec.indexOf("pinnedPhoneProblems(")).toBeLessThan(spec.indexOf("await button.click()")); // checked before the click, inside dial()
  });
  it("N1: the default `op read` path refuses unless OP_SERVICE_ACCOUNT_TOKEN is set (injected readers are unaffected)", () => {
    expect(() => resolveOwnedNumbers({ STRESS_OP_REF_CELL: "op://v/c/n", STRESS_OP_REF_TELNYX: "op://v/t/n" })).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
  });
});
