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
  /** Per-leg end confirmation: hangup webhook, hangup 422/90018, or GET is_alive:false. Absent = nothing can be confirmed. */
  confirmLegEnded?: (id: string) => Promise<boolean>;
  /** Ring timeout of the probe's Dial (seconds). Unknown legs are given this + 15s to appear. Default 600 (provider max). */
  ringTimeoutSecs?: number;
  now?: () => number;
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
  private startedAt = new Map<string, { at: number; logIdx: number }>();

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
    this.startedAt.set(probeId, { at: (this.deps.now ?? Date.now)(), logIdx: this.deps.log.all().length });
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
    const { listAliveLegs, hangupLeg, confirmLegEnded } = this.deps;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.deps.now ?? Date.now;
    const pollMs = this.deps.pollMs ?? 2000;
    const start = this.startedAt.get(probeId) ?? { at: now(), logIdx: 0 };
    // A ringing leg may not appear in active_calls. A probe whose leg id is never learned is only
    // considered gone after its ring timeout + 15s, plus two empty listings after that point.
    const unknownLegMs = ((this.deps.ringTimeoutSecs ?? 600) + 15) * 1000;
    const budgetMs = (this.deps.confirmWaitMs ?? 30000) + unknownLegMs;
    const known = new Set<string>();
    const confirmed = new Set<string>();
    let waited = 0;
    let clean = 0;
    let cleanAfterGate = 0;
    let lastError: string | undefined;
    let pendingWhy = "probe leg still alive after bounded wait";
    try {
      while (listAliveLegs) {
        try {
          const keep = new Set(this.deps.protectedLegs?.() ?? []);
          const alive = (await listAliveLegs()).filter((id) => !keep.has(id));
          lastError = undefined;
          for (const id of alive) known.add(id);
          // legs learned from webhooks since the probe started (never from protected legs)
          for (const e of this.deps.log.all().slice(start.logIdx)) if (e.source === "webhook" && e.callControlId && !keep.has(e.callControlId)) known.add(e.callControlId);
          if (alive.length === 0) {
            clean++;
            if (now() - start.at >= unknownLegMs) cleanAfterGate++; else cleanAfterGate = 0;
          } else {
            clean = 0;
            cleanAfterGate = 0;
            for (const id of alive) {
              try { await hangupLeg?.(id); } catch { /* confirmed by per-leg confirmation, not by this call */ }
            }
          }
          for (const id of known) {
            if (confirmed.has(id)) continue;
            if (confirmLegEnded && (await confirmLegEnded(id).catch(() => false))) confirmed.add(id);
          }
          const unconfirmed = [...known].filter((id) => !confirmed.has(id));
          const gateOk = known.size > 0 || cleanAfterGate >= 2;
          if (clean >= 2 && unconfirmed.length === 0 && gateOk) {
            this.outstanding = undefined;
            this.startedAt.delete(probeId);
            this.deps.log.append({ source: "harness", type: "escape.probe.finish", data: { probeId, outcome, confirmed: known.size ? "every probe leg confirmed ended" : "no leg ever learned; ring timeout + 15s elapsed with two empty listings" } });
            return { released: true };
          }
          pendingWhy = unconfirmed.length ? `legs not confirmed ended: ${unconfirmed.join(",")}` : clean < 2 ? "probe leg still alive after bounded wait" : "no probe leg id learned and ring timeout + 15s has not elapsed with two empty listings";
        } catch (e) {
          clean = 0;
          cleanAfterGate = 0;
          lastError = (e as Error).message.slice(0, 200);
        }
        if (waited >= budgetMs) break;
        await sleep(pollMs);
        waited += pollMs;
      }
      this.cleanupUncertain = true;
      this.deps.log.append({ source: "harness", type: "escape.probe.cleanup_uncertain", data: { probeId, outcome, reason: listAliveLegs ? (lastError ?? pendingWhy) : "no reconciliation source", waitedMs: waited } });
      return { released: false };
    } finally {
      this.finishing = false;
    }
  }
}
