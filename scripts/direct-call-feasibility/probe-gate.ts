// Server-side gate for F2 escape probes. The browser page cannot start a probe on its own:
// the gate must be armed by the F2 flow for the current run (after containment is shown),
// each probe reserves budget (attempt + estimated spend), and only one probe may be outstanding.
import { randomBytes } from "node:crypto";
import type { Budget } from "./budget";
import type { EventLog } from "./event-log";

export interface ProbeTarget {
  label: string;
  target: string;
}

export class ProbeGate {
  readonly runId = randomBytes(8).toString("hex");
  private armedRun: string | undefined;
  private outstanding: string | undefined;
  private seq = 0;

  constructor(private deps: { budget: Budget; log: EventLog; targets: () => ProbeTarget[] }) {}

  /** Called by the F2 flow only after containment readiness was verified for this run. */
  arm(): void {
    this.armedRun = this.runId;
  }
  disarm(): void {
    this.armedRun = undefined;
  }

  status(): { ready: boolean; busy: boolean } {
    return { ready: this.armedRun === this.runId, busy: this.outstanding !== undefined };
  }

  /** Labels only; targets are released per probe by start(). */
  labels(): string[] {
    return [...this.deps.targets().map((t) => t.label), "transfer"];
  }

  /** Reserves budget and returns the target. Throws (and records the refusal) instead of allowing a bypass. */
  start(label: string): { probeId: string; target: string } {
    const refuse = (why: string): never => {
      this.deps.log.append({ source: "harness", type: "escape.probe.refused", data: { label, why } });
      throw new Error(why);
    };
    if (this.armedRun !== this.runId) refuse("containment not confirmed for this run");
    if (this.outstanding) refuse("another probe is still outstanding");
    const targets = this.deps.targets();
    const hit = label === "transfer" ? targets[0] : targets.find((t) => t.label === label);
    if (!hit) return refuse("unknown probe label");
    try {
      this.deps.budget.reserveAttempt();
    } catch (e) {
      return refuse(`budget: ${(e as Error).message}`);
    }
    const probeId = `probe-${this.runId}-${++this.seq}`;
    this.outstanding = probeId;
    this.deps.log.append({ source: "harness", type: "escape.probe.start", data: { probeId, label, attempts: this.deps.budget.attempts, estSpendUsd: this.deps.budget.estSpendUsd } });
    return { probeId, target: hit!.target };
  }

  finish(probeId: string, outcome?: string): boolean {
    if (this.outstanding !== probeId) return false;
    this.outstanding = undefined;
    this.deps.log.append({ source: "harness", type: "escape.probe.finish", data: { probeId, outcome } });
    return true;
  }
}
