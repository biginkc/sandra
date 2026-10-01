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

export interface ProbeGateDeps {
  budget: Budget;
  log: EventLog;
  targets: () => ProbeTarget[];
  /** Server-side reconciliation: ids of every leg currently alive on the test connection and app. Throws if it cannot tell. */
  listAliveLegs?: () => Promise<string[]>;
  /** Best-effort server-side hangup of a leg found alive. */
  hangupLeg?: (id: string) => Promise<void>;
  /** Legs that are NOT probe legs (e.g. the owned source call for the transfer probe). */
  protectedLegs?: () => string[];
  /** Bounded wait for confirmation that no probe leg is alive. */
  confirmWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ProbeGate {
  readonly runId = randomBytes(8).toString("hex");
  private armedRun: string | undefined;
  private outstanding: string | undefined;
  private finishing = false;
  private cleanupUncertain = false;
  private seq = 0;

  constructor(private deps: ProbeGateDeps) {}

  /** Called by the F2 flow only after containment readiness was verified for this run. */
  arm(): void {
    this.armedRun = this.runId;
  }
  disarm(): void {
    this.armedRun = undefined;
  }

  status(): { ready: boolean; busy: boolean; locked: boolean } {
    return { ready: this.armedRun === this.runId && !this.cleanupUncertain, busy: this.outstanding !== undefined, locked: this.cleanupUncertain };
  }

  /** Labels only; targets are released per probe by start(). */
  labels(): string[] {
    return [...this.deps.targets().map((t) => t.label), "transfer"];
  }

  /** Reserves budget and returns the target. Throws (and records the refusal) instead of allowing a bypass. */
  start(label: string): { probeId: string; target: string; targetLabel: string } {
    const refuse = (why: string): never => {
      this.deps.log.append({ source: "harness", type: "escape.probe.refused", data: { label, why } });
      throw new Error(why);
    };
    if (this.cleanupUncertain) refuse("probe cleanup uncertain; no further probes this run");
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
    this.deps.log.append({ source: "harness", type: "escape.probe.start", data: { probeId, label, targetLabel: hit.label, attempts: this.deps.budget.attempts, estSpendUsd: this.deps.budget.estSpendUsd } });
    return { probeId, target: hit.target, targetLabel: hit.label };
  }

  /**
   * The browser reporting "finished" does NOT release the gate. The gate stays held until
   * server-side reconciliation shows no probe leg alive (two consecutive clean listings). Legs
   * found alive get a server hangup. If that cannot be confirmed within the bounded wait, the gate
   * stays closed for good (escape.probe.cleanup_uncertain); teardown's normal cleanup still runs.
   */
  async finish(probeId: string, outcome?: string): Promise<{ released: boolean }> {
    if (this.outstanding !== probeId || this.finishing) return { released: false };
    this.finishing = true;
    this.deps.log.append({ source: "harness", type: "escape.probe.browser_finished", data: { probeId, outcome } });
    const { listAliveLegs, hangupLeg } = this.deps;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.deps.pollMs ?? 2000;
    const budgetMs = this.deps.confirmWaitMs ?? 30000;
    let waited = 0;
    let clean = 0;
    let lastError: string | undefined;
    try {
      while (listAliveLegs) {
        try {
          const keep = new Set(this.deps.protectedLegs?.() ?? []);
          const alive = (await listAliveLegs()).filter((id) => !keep.has(id));
          lastError = undefined;
          if (alive.length === 0) {
            if (++clean >= 2) {
              this.outstanding = undefined;
              this.deps.log.append({ source: "harness", type: "escape.probe.finish", data: { probeId, outcome, confirmed: "no probe leg alive" } });
              return { released: true };
            }
          } else {
            clean = 0;
            for (const id of alive) {
              try { await hangupLeg?.(id); } catch { /* confirmed by the next listing, not by this call */ }
            }
          }
        } catch (e) {
          clean = 0;
          lastError = (e as Error).message.slice(0, 200);
        }
        if (waited >= budgetMs) break;
        await sleep(pollMs);
        waited += pollMs;
      }
      this.cleanupUncertain = true;
      this.deps.log.append({ source: "harness", type: "escape.probe.cleanup_uncertain", data: { probeId, outcome, reason: listAliveLegs ? (lastError ?? "probe leg still alive after bounded wait") : "no reconciliation source", waitedMs: waited } });
      return { released: false };
    } finally {
      this.finishing = false;
    }
  }
}
