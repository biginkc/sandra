 
// Attempt and spend control. Spend is a conservative ESTIMATE (reserved up front
// per attempt at full leg duration). The provider-side daily cap is a backstop.
import fs from "node:fs";
import path from "node:path";
import type { Limits } from "./env";

export class BudgetError extends Error {}

interface State {
  attempts: number;
  estSpendUsd: number;
}

export class Budget {
  private state: State = { attempts: 0, estSpendUsd: 0 };
  private stopped = false;
  private file?: string;

  /** One attempt = one Dial request (one leg). */
  constructor(private limits: Limits, dir?: string, private legsPerAttempt = 1) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, "budget.json");
      if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as State;
    }
  }

  get attempts(): number {
    return this.state.attempts;
  }
  get estSpendUsd(): number {
    return this.state.estSpendUsd;
  }

  /** Estimated worst-case cost of one attempt: all legs at the max duration. */
  attemptCostUsd(): number {
    return this.limits.estCostPerLegMinuteUsd * (this.limits.maxLegSecs / 60) * this.legsPerAttempt;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Call before any new attempt. Throws instead of allowing it when a limit would be crossed. */
  reserveAttempt(): void {
    if (this.stopped) throw new BudgetError("attempts stopped");
    if (this.state.attempts >= this.limits.maxAttempts) {
      throw new BudgetError(`attempt limit reached (${this.limits.maxAttempts})`);
    }
    const next = this.state.estSpendUsd + this.attemptCostUsd();
    if (next > this.limits.maxSpendUsd) {
      throw new BudgetError(`estimated spend would exceed $${this.limits.maxSpendUsd}`);
    }
    this.state = { attempts: this.state.attempts + 1, estSpendUsd: next };
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
}
