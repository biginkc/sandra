/** Strict positive-integer parsing for rep counts read from the environment: 0, negatives, fractions and NaN are refused, never run as zero work. */
export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`);
  return n;
}

/** Full-run volume floors (stress design v1): a full run below these is not the gate. */
export const FULL_FLOORS = { repeats: 20, raceReps: 200, bindReps: 20, scaleSamples: 10, lateFailureReps: 50 } as const;

/** Boundary families of the refresh lane (kept here, dependency-free, so the report can require each one). races.ts asserts it matches. */
export const REFRESH_FAMILY_IDS = [
  "callback_due_soon", "snooze_expiring", "missed_callback_7d", "offer_chain_follow_up", "offer_legacy_follow_up", "texted_last_three_business_days",
  "drip_next_run_overdue", "drip_claim_stale", "call_in_progress_stale", "campaign_overdue", "pending_text_stale", "ledger_in_flight_stale",
  "obligation_lease_expiry", "failed_text_ages_out", "pin_expiry",
] as const;

/** Every lane a full run must contain, with its minimum executed runs. A missing or short lane fails the run by name. */
export function requiredFullLanes(): Array<{ id: string; minRuns: number }> {
  return [
    ...REFRESH_FAMILY_IDS.map((f) => ({ id: `refresh:${f}`, minRuns: FULL_FLOORS.repeats })),
    { id: "race:bind_rpc_failure", minRuns: FULL_FLOORS.bindReps },
    { id: "race:stamped_send_vs_inbound", minRuns: FULL_FLOORS.raceReps },
    { id: "race:late_delivery_failed", minRuns: FULL_FLOORS.lateFailureReps },
    { id: "race:cleanup", minRuns: 1 },
    { id: "race:dispatch_stamped_send_vs_inbound", minRuns: FULL_FLOORS.raceReps },
    { id: "race:dispatch_bind_failure", minRuns: FULL_FLOORS.bindReps },
  ];
}
