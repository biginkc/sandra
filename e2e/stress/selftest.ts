import { type StressConfig, type FaultName } from "./config";
import { runChaos } from "./engine";

/**
 * Harness self-test. Before the real run, three fault-injection builds (duplicate a send, drop an
 * offer, attach a note to the wrong lead) must each turn the run RED, and a control run with no
 * fault must NOT. A harness that cannot fail proves nothing.
 *
 * Each run starts from empty tenant tables (the same `reset_tenant_tables()` the e2e lanes use) so
 * the fresh-database proof holds. Short profile: self-test runs can never produce PASS.
 */

export type SelfTestRow = { fault: FaultName; expectedRed: boolean; verdict: string; failingChecks: number[]; ok: boolean; note: string };

/** The injected defect MUST be caught by at least one of these checks (it may also trip others). `duplicate_send` hits the first provider send the schedule reaches: a dial (1) or a contract send (7, 14). */
export const EXPECTED_CATCH: Record<FaultName, number[]> = {
  none: [],
  duplicate_send: [1, 7, 14],
  drop_offer: [14],
  wrong_lead_note: [12],
};

export async function runSelfTest(base: StressConfig): Promise<{ ok: boolean; rows: SelfTestRow[] }> {
  const rows: SelfTestRow[] = [];
  const order: FaultName[] = ["none", "duplicate_send", "drop_offer", "wrong_lead_note"];
  for (const fault of order) {
    const cfg: StressConfig = { ...base, fault, knownFindings: [...new Set([...base.knownFindings, "second_tab_duplicate_note"])], runId: `${base.runId}-${fault === "none" ? "control" : fault.replace(/_/g, "")}`.slice(0, 24), runTag: "" };
    cfg.runTag = `STRESS-${cfg.runId}`;
    const r = await runChaos({ cfg, profile: "short", resetFirst: true, env: { ...process.env, STRESS_ALLOW_PARTIAL: "1" } });
    const failing = r.summary.checks.filter((c) => !c.ok && !c.deferred).map((c) => c.id);
    const expectedRed = fault !== "none";
    const red = r.summary.verdict === "FAIL";
    const caught = EXPECTED_CATCH[fault].some((id) => failing.includes(id));
    const ok = expectedRed ? red && caught : r.summary.verdict === "PARTIAL_PASS";
    rows.push({ fault, expectedRed, verdict: r.summary.verdict, failingChecks: failing, ok, note: expectedRed ? (caught ? "caught by the intended check" : `NOT caught by any of checks ${EXPECTED_CATCH[fault].join(",")}`) : r.summary.reasons.join("; ") || "clean control held" });
  }
  return { ok: rows.every((r) => r.ok), rows };
}
