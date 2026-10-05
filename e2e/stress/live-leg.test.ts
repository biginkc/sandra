import { describe, expect, it } from "vitest";

import { readConfig } from "./config";
import { assertLiveLegReady, classifyLiveEvidence, liveCallPlan, liveLegStatus, sendilloSpotCheck, type LiveDeps } from "./live-leg";
import { LaneRefusal } from "./guards";

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
  STRESS_DIALPAD_SUBSCRIPTION_PROOF: "/r/proof.txt",
  STRESS_OP_REF_CELL: "op://vault/cell/number",
  STRESS_OP_REF_TELNYX: "op://vault/telnyx/number",
};
const deps: LiveDeps = {
  opRead: (ref) => (ref.includes("cell") ? "+18165550111" : "+18165550222"),
  readFile: (p) => (p.endsWith("REPORT.md") ? `# Chaos day live1: PASS\n\n- SHA: ${SHA}\n- Profile: full, scope: full, fault: none\n` : p.endsWith("proof.txt") ? "subscription https://stress-tunnel.example.net ok" : null),
};
const status = (env: Record<string, string | undefined>, d: LiveDeps = deps) => liveLegStatus(readConfig(env), env, d);

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
    const keys = ["STRESS_LIVE_LEG", "STRESS_TEST_SMS_STRING_APPROVED", "STRESS_DIALPAD_LIVE_JARRAD_PRESENT", "STRESS_ROOT_BROWSER_CONTEXT", "STRESS_ROOT_PROD_DIALPAD_NO_SUBSCRIPTION", "STRESS_DIALPAD_DESKTOP_CONFIRMED", "STRESS_TUNNEL_URL", "STRESS_STUB_LEG_REPORT", "STRESS_DIALPAD_SUBSCRIPTION_PROOF", "STRESS_OP_REF_CELL", "STRESS_OP_REF_TELNYX", "STRESS_ARTIFACTS_DIR"];
    for (const k of keys) {
      const env = { ...ready, [k]: undefined };
      expect((await status(env)).ready, `without ${k}`).toBe(false);
    }
  });
  it("blocks on a stubbed-leg report that is not a full PASS at this sha", async () => {
    for (const body of [`# Chaos day x: PARTIAL_PASS\n- SHA: ${SHA}\n- Profile: full, scope: full, fault: none\n`, `# Chaos day x: PASS\n- SHA: ${"b".repeat(40)}\n- Profile: full, scope: full, fault: none\n`, `# Chaos day x: PASS\n- SHA: ${SHA}\n- Profile: short, scope: replay, fault: none\n`]) {
      expect((await status(ready, { ...deps, readFile: (p) => (p.endsWith("REPORT.md") ? body : "https://stress-tunnel.example.net") })).ready).toBe(false);
    }
  });
  it("blocks when the two owned numbers are the same, or are not numbers", async () => {
    expect((await status(ready, { ...deps, opRead: () => "+18165550111" })).ready).toBe(false);
    expect((await status(ready, { ...deps, opRead: () => "not-a-number" })).ready).toBe(false);
  });
  it("blocks the autonomous Sendillo mode and a non-loopback app", async () => {
    expect((await status({ ...ready, STRESS_SENDILLO_MODE: "autonomous_tagged_rows" })).ready).toBe(false);
    expect((await status({ ...ready, STRESS_APP_URL: "https://sandra.example.com" })).ready).toBe(false);
  });
  it("assertLiveLegReady throws LaneRefusal listing the unmet items, and returns the plan when ready", async () => {
    await expect(assertLiveLegReady(readConfig({}), {}, deps)).rejects.toBeInstanceOf(LaneRefusal);
    const ok = await assertLiveLegReady(readConfig(ready), ready, deps);
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
