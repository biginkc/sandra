import { classifyLiveEvidence, type LiveCallStep, type LiveEvidence } from "./live-leg";

/**
 * Live-leg step driver. Pure orchestration over a PORT: it never touches a browser, a database or a provider itself.
 * The port is wired to the REAL app UI of the isolated instance in browser/live-leg.spec.ts, and that spec only runs
 * when STRESS_LIVE_LEG=1, `assertLiveLegReady` passes, and it is not CI. Unit tests drive this with a fake port.
 *
 * What the app's UI can and cannot do (verified in the code, not assumed):
 *  - Call click: yes. The server may refuse it (20 s in flight, 4/min); a refusal prepares no intent.
 *  - Cancel before answer: NO control. `cancelDialpadCallAction` refuses once the dial reached Dialpad ("already sent to
 *    Dialpad and cannot be cancelled here"). That step is therefore NOT dialled and is reported `unverified`.
 */

export type DialClick = { refused: boolean; note?: string; /** When the Call button was clicked (ms epoch), measured at the click, not from a sleep. */ clickedAtMs?: number };
export type LivePort = {
  /** Click Call for the lead that holds this step's target number. `refused` is judged from the database (no new authorized intent). */
  dial(step: LiveCallStep): Promise<DialClick>;
  /** Wait (poll) until the intent opened by the latest dial has a terminal Dialpad event, or the timeout passes. */
  awaitTerminal(step: LiveCallStep, timeoutMs: number): Promise<boolean>;
  /** Evidence rows for the latest dial of this step (call id, terminal state and cause from the webhook, matched attempt). */
  evidence(step: LiveCallStep): Promise<LiveEvidence>;
  /** True when an authorized intent for this step's click exists NOW (checked again after the first call settles): a late intent is a DOUBLE DIAL, never a refusal. */
  lateDial?(step: LiveCallStep): Promise<boolean>;
  /** Re-runs the app-identity check (pid, start time, guard line, uid, no .env*) and THROWS when it fails. Called before EVERY dial. */
  recheck?(): Promise<void>;
  sleep(ms: number): Promise<void>;
  killRequested(): boolean;
  log(line: string): void;
};

export type LiveStepResult = { n: number; shape: LiveCallStep["shape"]; verdict: "verified" | "unverified" | "not_driven" | "violation"; detail: string; evidence?: LiveEvidence };

export const SECOND_DIAL_WINDOW_MS = 20_000;
export const TERMINAL_WAIT_MS = 5 * 60_000;
/** The second dial of the pair must land inside the app's 20 s in-flight window. */
export const DOUBLE_DIAL_DELAY_MS = 4_000;

export async function driveLiveLeg(plan: readonly LiveCallStep[], port: LivePort): Promise<LiveStepResult[]> {
  const results: LiveStepResult[] = [];
  let previous: LiveStepResult | null = null;
  let firstClickAt: number | null = null;
  let pendingFirst: LiveCallStep | null = null; // step 7 waits for its terminal event after step 8 has been refused
  for (const step of plan) {
    if (port.killRequested()) { port.log(`kill requested: stopping before step ${step.n}`); break; }
    if (step.shape === "cancel_before_answer") {
      const r: LiveStepResult = { n: step.n, shape: step.shape, verdict: "not_driven", detail: "the app has no cancel control once Dialpad has the dial; not dialled, reported unverified (never a pass)" };
      results.push(r); previous = r; port.log(`step ${step.n} ${step.shape}: not driven`);
      continue;
    }
    if (step.shape === "double_dial_refused" && !step.expectRefusal) {
      // First of the pair: dial and do NOT wait; the very next step must be refused while this call is in flight.
      if (previous && step.gapMs > 0) await port.sleep(planGapBefore(plan, step));
      await port.recheck?.();
      const click = await port.dial(step);
      firstClickAt = click.clickedAtMs ?? null;
      pendingFirst = step;
      port.log(`step ${step.n} ${step.shape}: first dial ${click.refused ? "REFUSED (unexpected)" : "started"}`);
      if (click.refused) { results.push({ n: step.n, shape: step.shape, verdict: "unverified", detail: `first dial of the pair was refused: ${click.note ?? ""}` }); pendingFirst = null; }
      previous = results[results.length - 1] ?? null;
      continue;
    }
    if (step.shape === "double_dial_refused" && step.expectRefusal) {
      await port.sleep(Math.min(step.gapMs, DOUBLE_DIAL_DELAY_MS));
      await port.recheck?.();
      const click = await port.dial(step);
      const ev: LiveEvidence = { callId: null, terminalState: null, cause: null, attemptMatched: false, refused: click.refused };
      // The 20 s window is measured from the FIRST CLICK to the SECOND CLICK (not from a sleep): a second click outside it proves nothing about the intent rule.
      const gapMs = firstClickAt !== null && click.clickedAtMs !== undefined ? click.clickedAtMs - firstClickAt : null;
      const inWindow = gapMs === null || gapMs <= SECOND_DIAL_WINDOW_MS;
      const r: LiveStepResult = { n: step.n, shape: step.shape, verdict: inWindow ? classifyLiveEvidence(step, ev) : "unverified", detail: !inWindow ? `second click came ${gapMs} ms after the first (window ${SECOND_DIAL_WINDOW_MS} ms)` : click.refused ? "second dial refused by the intent rule" : "second dial was NOT refused", evidence: ev };
      results.push(r); previous = r; port.log(`step ${step.n}: ${r.detail}`);
      if (pendingFirst) {
        // Settle the first call of the pair: its own evidence, judged like any other call.
        const first = pendingFirst; pendingFirst = null;
        const settled = await port.awaitTerminal(first, TERMINAL_WAIT_MS);
        // A refusal is only a refusal if NO intent for the second click ever appears, even late: re-check now that the first call has settled.
        if (r.verdict === "verified" && (await port.lateDial?.(step)) === true) { r.verdict = "violation"; r.detail = "DOUBLE DIAL: an authorized intent for the second click appeared late"; }
        const fev = await port.evidence(first);
        const fr: LiveStepResult = { n: first.n, shape: first.shape, verdict: settled ? classifyLiveEvidence(first, fev) : "unverified", detail: settled ? "first call of the pair settled" : "first call of the pair never reached a terminal event", evidence: fev };
        const idx = results.findIndex((x) => x.n === first.n);
        if (idx >= 0) results[idx] = fr; else results.splice(results.length - 1, 0, fr);
      }
      continue;
    }
    if (previous && step.gapMs > 0) await port.sleep(planGapBefore(plan, step));
    await port.recheck?.();
    const click = await port.dial(step);
    if (click.refused) { const r: LiveStepResult = { n: step.n, shape: step.shape, verdict: "unverified", detail: `dial refused: ${click.note ?? "no reason shown"}` }; results.push(r); previous = r; continue; }
    const settled = await port.awaitTerminal(step, TERMINAL_WAIT_MS);
    const ev = await port.evidence(step);
    const verdict = settled ? classifyLiveEvidence(step, ev) : "unverified";
    const r: LiveStepResult = { n: step.n, shape: step.shape, verdict, detail: settled ? `terminal event ${ev.terminalState ?? "none"}` : "no terminal event before the timeout", evidence: ev };
    results.push(r); previous = r; port.log(`step ${step.n} ${step.shape}: ${verdict}`);
  }
  return results;
}

/** The gap a step waits BEFORE it dials is the gap of the step in front of it, so the plan's `gapMs` reads "wait after this call". */
function planGapBefore(plan: readonly LiveCallStep[], step: LiveCallStep): number {
  const i = plan.findIndex((s) => s.n === step.n);
  return i > 0 ? plan[i - 1]!.gapMs : 0;
}

/**
 * `cancel_before_answer` has no UI control after dispatch, so it is NOT driven: it is excluded from the required count and reported explicitly. A live
 * run is ok when every REQUIRED step is verified, nothing is unverified or a violation, and nothing is missing; the not-driven steps must be exactly
 * the cancel shape (anything else not driven is a failure).
 */
export function summarizeLive(results: readonly LiveStepResult[], plan: readonly LiveCallStep[]): { ok: boolean; required: number; verified: number; unverified: number; violations: number; notDriven: number; notDrivenReported: string[]; missing: number } {
  const requiredSteps = plan.filter((s) => s.shape !== "cancel_before_answer");
  const verified = results.filter((r) => r.verdict === "verified").length;
  const unverified = results.filter((r) => r.verdict === "unverified").length;
  const violations = results.filter((r) => r.verdict === "violation").length;
  const notDriven = results.filter((r) => r.verdict === "not_driven");
  const unexpectedNotDriven = notDriven.filter((r) => r.shape !== "cancel_before_answer").length;
  const missing = plan.length - results.length;
  const ok = verified === requiredSteps.length && unverified === 0 && violations === 0 && unexpectedNotDriven === 0 && missing === 0;
  return { ok, required: requiredSteps.length, verified, unverified, violations, notDriven: notDriven.length, notDrivenReported: notDriven.map((r) => `step ${r.n} ${r.shape}: ${r.detail}`), missing };
}
