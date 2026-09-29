import { expect, it } from "vitest";
import { dripBucket, dripStatus, DRIP_BUCKET_LABELS, pauseReasonText, type DripBucket } from "./drip-status";

// Expected buckets are hand-computed from sequence_overview_stats in
// 20260929120000_sequence_stats.sql. Null means the SQL counts no bucket.
it.each([
  ["active", null, false, false, "waiting"],
  ["paused", "inbound_reply", false, false, "replied"],
  ["paused", "rep_sms_human_takeover", false, false, "replied"],
  ["paused", "provider_failed", false, false, "couldnt_send"],
  ["paused", "reconciliation_required", false, false, "couldnt_send"],
  ["paused", "template_missing", false, false, null],
  ["paused", "step_misconfigured", false, false, null],
  ["paused", "no_phone", false, false, null],
  ["paused", "no approved sender for first-touch sequence send", false, false, null],
  ["paused", "manual", false, false, null],
  ["paused", null, false, false, null],
  ["opted_out", null, false, false, "stopped"],
  ["completed", null, true, false, "stopped"],
  ["completed", null, false, false, "finished_no_reply"],
  ["completed", null, false, true, null],
] as const)("matches SQL for %s / %s / canceled=%s / inbound=%s", (status, reason, canceled, inbound, expected: DripBucket | null) => {
  expect(dripBucket({ status, pause_reason: reason, canceled, inboundAfterLastRun: inbound })).toBe(expected);
  expect(dripStatus(status, reason, canceled, inbound)).toBe(expected ? DRIP_BUCKET_LABELS[expected] : null);
  if (status === "paused" && reason) expect(pauseReasonText(reason)).toBeTruthy();
});
