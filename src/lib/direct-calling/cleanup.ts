import type { DirectCallFullRow, DirectCallStore } from "./store";
import { isLegAlreadyEnded } from "./telnyx";
import { hangupCommandId, type LegRole } from "./transitions";

export type CleanupDeps = {
  store: DirectCallStore;
  hangup: (callControlId: string, commandId: string) => Promise<void>;
  report: (error: unknown, tag: string) => void;
};

export type CleanupResult = { attempted: number; confirmed: number; pending: boolean };

const LEGS: Array<{ role: LegRole; flag: "browser_hangup_pending" | "seller_hangup_pending"; id: "browser_leg_id" | "seller_leg_id" }> = [
  { role: "browser", flag: "browser_hangup_pending", id: "browser_leg_id" },
  { role: "seller", flag: "seller_hangup_pending", id: "seller_leg_id" },
];

/**
 * Hangs up every leg whose teardown is still pending and clears the flag only once the
 * provider confirms (accepted hangup, or a 404 / "already ended" refusal). A failed hangup
 * leaves the flag set so webhook redelivery, status polling or an operator hangup retries it.
 */
export async function runLegCleanup(deps: CleanupDeps, row: DirectCallFullRow): Promise<CleanupResult> {
  let attempted = 0;
  let confirmed = 0;
  let pending = false;
  for (const leg of LEGS) {
    const legId = row[leg.id];
    if (!row[leg.flag] || !legId) continue;
    attempted += 1;
    try {
      await deps.hangup(legId, hangupCommandId(row.id, legId));
    } catch (error) {
      if (!isLegAlreadyEnded(error)) {
        deps.report(error, "direct_call_hangup");
        pending = true;
        continue;
      }
    }
    await deps.store.setLegCleanup(row.id, leg.role, false);
    confirmed += 1;
  }
  return { attempted, confirmed, pending };
}
