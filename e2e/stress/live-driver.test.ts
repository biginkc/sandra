import { describe, expect, it } from "vitest";

import { driveLiveLeg, summarizeLive, type LivePort } from "./live-driver";
import { liveCallPlan, type LiveCallStep, type LiveEvidence } from "./live-leg";

const GOOD: LiveEvidence = { callId: "9001", terminalState: "ended", cause: "missed", attemptMatched: true };

function fakePort(over: Partial<LivePort> & { refuseWhen?: (s: LiveCallStep, dials: number) => boolean; evidenceFor?: (s: LiveCallStep) => LiveEvidence; settle?: boolean } = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let dials = 0;
  const port: LivePort = {
    async dial(step) { dials += 1; calls.push(`dial:${step.n}`); return { refused: over.refuseWhen?.(step, dials) ?? false, note: "refused" }; },
    async awaitTerminal(step) { calls.push(`wait:${step.n}`); return over.settle ?? true; },
    async evidence(step) { calls.push(`evidence:${step.n}`); return over.evidenceFor?.(step) ?? GOOD; },
    async sleep(ms) { sleeps.push(ms); },
    killRequested: over.killRequested ?? (() => false),
    log: () => {},
  };
  return { port, calls, sleeps };
}

describe("live leg driver", () => {
  it("drives the plan, never dials the cancel shape (no UI cancel exists) and reports it as not driven", async () => {
    const f = fakePort({ refuseWhen: (s) => s.expectRefusal === true });
    const plan = liveCallPlan();
    const res = await driveLiveLeg(plan, f.port);
    expect(res).toHaveLength(8);
    expect(f.calls.filter((c) => c === "dial:5" || c === "dial:6")).toEqual([]);
    expect(res.filter((r) => r.verdict === "not_driven").map((r) => r.n)).toEqual([5, 6]);
    const s = summarizeLive(res, plan);
    expect(s.ok).toBe(false); // a not-driven step is never a pass
    expect(s).toMatchObject({ verified: 6, notDriven: 2, unverified: 0, missing: 0 });
  });
  it("waits the plan gap between calls and fires the second double dial inside the 20 s window", async () => {
    const f = fakePort({ refuseWhen: (s) => s.expectRefusal === true });
    await driveLiveLeg(liveCallPlan(), f.port);
    expect(f.sleeps.filter((ms) => ms === 4 * 60_000).length).toBe(4); // before steps 2, 3, 4 and 7 (5 and 6 are not dialled)
    expect(f.sleeps.some((ms) => ms > 0 && ms < 20_000)).toBe(true);
    const order = f.calls.filter((c) => c.startsWith("dial:7") || c.startsWith("dial:8") || c === "wait:7");
    expect(order).toEqual(["dial:7", "dial:8", "wait:7"]); // pair dialled back to back; the first settles after the refusal
  });
  it("a second dial that is NOT refused is unverified", async () => {
    const f = fakePort({ refuseWhen: () => false });
    const res = await driveLiveLeg(liveCallPlan(), f.port);
    expect(res.find((r) => r.n === 8)!.verdict).toBe("unverified");
  });
  it("a call with no terminal event, or thin evidence, is unverified, not a pass", async () => {
    const none = await driveLiveLeg(liveCallPlan().slice(0, 1), fakePort({ settle: false }).port);
    expect(none[0]!.verdict).toBe("unverified");
    const thin = await driveLiveLeg(liveCallPlan().slice(0, 1), fakePort({ evidenceFor: () => ({ callId: "1", terminalState: null, cause: null, attemptMatched: false }) }).port);
    expect(thin[0]!.verdict).toBe("unverified");
  });
  it("a refused first dial is reported, and the kill switch stops the run before the next step", async () => {
    const refused = await driveLiveLeg(liveCallPlan().slice(0, 1), fakePort({ refuseWhen: () => true }).port);
    expect(refused[0]!.verdict).toBe("unverified");
    let n = 0;
    const f = fakePort({ killRequested: () => (n += 1) > 2 });
    const res = await driveLiveLeg(liveCallPlan(), f.port);
    expect(res).toHaveLength(2);
    expect(summarizeLive(res, liveCallPlan()).missing).toBe(6);
  });
});
