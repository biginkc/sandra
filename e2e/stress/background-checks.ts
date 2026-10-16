/**
 * Tracks every in-flight background check promise. On finish the timer is cleared and every outstanding check is AWAITED; every failure (a violated
 * invariant, or a check that could not run) is then folded into the run's errors, so a slow check that completes after the final read cannot be dropped.
 */
export class BackgroundChecks {
  private inFlight = new Set<Promise<void>>();
  readonly failures: string[] = [];
  private closed = false;
  /** Start one check. A closed tracker starts nothing. `check` returns the failure text(s), or throws (recorded as "could not run"). */
  start(check: () => Promise<string[]>): void {
    if (this.closed) return;
    const p = (async () => {
      try { this.failures.push(...(await check())); } catch (e) { this.failures.push(`invariant check failed to run: ${(e as Error).message}`); }
    })();
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }
  /** Stop accepting checks, await all outstanding ones, and return every failure found (each once). */
  async settle(): Promise<string[]> {
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
    return [...new Set(this.failures)];
  }
}
