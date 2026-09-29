import { expect, it } from "vitest";
import { dripBucket, dripStatus, DRIP_BUCKET_LABELS, latestEnrollmentBucket, pauseReasonText, type DripBucket } from "./drip-status";

// Expected buckets follow the widened sequence stats migration. The local
// integration parity test checks this table against both SQL RPCs.
it.each([
  ["active", null, false, false, "waiting"],
  ["paused", "inbound_reply", false, false, "replied"],
  ["paused", "rep_sms_human_takeover", false, false, "replied"],
  ["paused", "provider_failed", false, false, "couldnt_send"],
  ["paused", "reconciliation_required", false, false, "couldnt_send"],
  ["paused", "template_missing", false, false, "couldnt_send"],
  ["paused", "step_misconfigured", false, false, "couldnt_send"],
  ["paused", "no_phone", false, false, "couldnt_send"],
  ["paused", "no_approved_sender", false, false, "couldnt_send"],
  ["paused", "no approved sender for first-touch sequence send", false, false, "couldnt_send"],
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

it("buckets only the latest enrollment after a completed drip is restarted", () => {
  const completed = { id: "a", enrolled_at: "2026-09-01", status: "completed" };
  const current = { id: "b", enrolled_at: "2026-09-02", status: "active" };
  expect(latestEnrollmentBucket([completed, current])).toBe("waiting");
  expect(latestEnrollmentBucket([completed, { ...current, status: "paused", pause_reason: "provider_failed" }])).toBe("couldnt_send");
  expect(latestEnrollmentBucket([completed, { ...current, status: "paused", pause_reason: "manual" }])).toBeNull();
});
