import type { FaultName } from "./config";

/** The injected defect MUST be caught by at least one of these checks (it may also trip others). `duplicate_send` hits the first provider send the schedule reaches: a dial (1) or a contract send (7, 14). */
export const EXPECTED_CATCH: Record<FaultName, number[]> = {
  none: [],
  duplicate_send: [1, 7, 14],
  drop_offer: [14],
  wrong_lead_note: [12],
};

/** The control plus exactly these three distinct faults. */
export const REQUIRED_FAULTS: readonly FaultName[] = ["duplicate_send", "drop_offer", "wrong_lead_note"];

export type SelfTestReportRow = { fault?: string; ok?: boolean; faultFired?: boolean; failingChecks?: number[]; verdict?: string };

/**
 * Whether a self-test report proves the harness can fail, at this sha: exactly four rows, the control (clean: PARTIAL_PASS, nothing fired)
 * and the three DISTINCT required faults, each fired, red, and caught by a check it is meant to trip. Four "none" rows, a duplicated fault,
 * a fault that never fired or one caught only by an unrelated check all fail.
 */
export function selfTestReportOk(report: { sha?: string; ok?: boolean; rows?: SelfTestReportRow[] } | null, sha: string): boolean {
  if (!report || report.ok !== true || report.sha !== sha || sha === "unknown" || !Array.isArray(report.rows) || report.rows.length !== 4) return false;
  const names = report.rows.map((r) => r.fault).sort().join(",");
  if (names !== ["none", ...REQUIRED_FAULTS].sort().join(",")) return false;
  return report.rows.every((r) => {
    if (r.ok !== true) return false;
    if (r.fault === "none") return r.faultFired === false && r.verdict === "PARTIAL_PASS" && (r.failingChecks ?? []).length === 0;
    const expected = EXPECTED_CATCH[r.fault as FaultName] ?? [];
    return r.faultFired === true && r.verdict === "FAIL" && (r.failingChecks ?? []).some((id) => expected.includes(id));
  });
}
