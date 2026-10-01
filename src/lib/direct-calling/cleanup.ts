import type { DirectCallFullRow, DirectCallStore } from "./store";
import { isLegAlreadyEnded } from "./telnyx";
import { hangupCommandId, type LegRole } from "./transitions";

/** An acknowledged-but-unconfirmed leg is re-checked against the provider at most this often. */
export const ACK_RECHECK_MS = 10_000;

export type CleanupDeps = {
  store: DirectCallStore;
  hangup: (callControlId: string, commandId: string) => Promise<void>;
  /** Provider status of one leg (GET call). `isAlive:false` (or a 404) means it is gone. */
  getCall: (callControlId: string) => Promise<{ isAlive: boolean }>;
  now: () => Date;
  report: (error: unknown, tag: string) => void;
};

export type CleanupResult = {
  /** Hangup commands sent this pass. */
  attempted: number;
  /** Legs confirmed ended this pass (404 / already-ended / status check shows dead). */
  confirmed: number;
  /** Hangups the provider accepted (2xx) this pass; the leg is NOT yet confirmed. */
  acknowledged: number;
  /** Hangups or status checks that errored; retried on the next pass. */
  failed: number;
  /** Anything (leg or orphan) still not confirmed ended. */
  pending: boolean;
};

const LEGS: Array<{
  role: LegRole;
  flag: "browser_hangup_pending" | "seller_hangup_pending";
  id: "browser_leg_id" | "seller_leg_id";
  acked: "browser_hangup_acked_at" | "seller_hangup_acked_at";
}> = [
  { role: "browser", flag: "browser_hangup_pending", id: "browser_leg_id", acked: "browser_hangup_acked_at" },
  { role: "seller", flag: "seller_hangup_pending", id: "seller_leg_id", acked: "seller_hangup_acked_at" },
];

/**
 * Drives pending leg teardown. Two separate states per leg:
 *  - hangup accepted (2xx): stops blind resends, recorded as `*_hangup_acked_at`;
 *  - confirmed ended: hangup webhook (handled by the transition), a 404/already-ended refusal, or
 *    a status GET showing the leg dead. Only then is the pending flag cleared.
 * An acknowledged leg is re-checked via GET at most every ACK_RECHECK_MS; if it is still alive
 * the hangup is sent again. Orphan legs have no ack state: each pass hangs up, then checks.
 */
export async function runLegCleanup(deps: CleanupDeps, row: DirectCallFullRow): Promise<CleanupResult> {
  const result: CleanupResult = { attempted: 0, confirmed: 0, acknowledged: 0, failed: 0, pending: false };
  const nowMs = deps.now().getTime();

  const sendHangup = async (legId: string): Promise<"accepted" | "gone" | "failed"> => {
    result.attempted += 1;
    try {
      await deps.hangup(legId, hangupCommandId(row.id, legId));
      return "accepted";
    } catch (error) {
      if (isLegAlreadyEnded(error)) return "gone";
      deps.report(error, "direct_call_hangup");
      return "failed";
    }
  };

  for (const leg of LEGS) {
    const legId = row[leg.id];
    if (!row[leg.flag] || !legId) continue;
    const ackedAt = row[leg.acked];
    let outcome: "accepted" | "gone" | "failed" | "wait" | "check_failed";
    if (!ackedAt) {
      outcome = await sendHangup(legId);
    } else if (nowMs - new Date(ackedAt).getTime() < ACK_RECHECK_MS) {
      outcome = "wait";
    } else {
      try {
        const alive = (await deps.getCall(legId)).isAlive;
        outcome = alive ? await sendHangup(legId) : "gone";
        if (alive && outcome === "accepted") await deps.store.markLegHangupAcked(row.id, leg.role, deps.now().toISOString());
      } catch (error) {
        deps.report(error, "direct_call_leg_status");
        outcome = "check_failed";
      }
    }
    if (outcome === "gone") {
      await deps.store.setLegCleanup(row.id, leg.role, false);
      result.confirmed += 1;
    } else if (outcome === "accepted") {
      if (!ackedAt) await deps.store.markLegHangupAcked(row.id, leg.role, deps.now().toISOString());
      result.acknowledged += 1;
      result.pending = true;
    } else {
      if (outcome === "failed" || outcome === "check_failed") result.failed += 1;
      result.pending = true;
    }
  }

  for (const orphanId of row.orphan_hangup_leg_ids ?? []) {
    // Always hang up first (a just-dialed leg must never be skipped on a status read), then check.
    let outcome = await sendHangup(orphanId);
    if (outcome === "accepted") {
      try {
        if (!(await deps.getCall(orphanId)).isAlive) outcome = "gone";
      } catch (error) {
        deps.report(error, "direct_call_leg_status");
      }
    }
    if (outcome === "gone") {
      await deps.store.removeOrphanLeg(row.id, orphanId);
      result.confirmed += 1;
    } else {
      if (outcome === "accepted") result.acknowledged += 1;
      else result.failed += 1;
      result.pending = true;
    }
  }
  return result;
}
