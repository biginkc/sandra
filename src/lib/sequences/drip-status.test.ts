import { expect, it } from "vitest";
import { dripBucket, DRIP_BUCKET_LABELS } from "./drip-status";

it.each([
  [{ status: "active" }, "waiting"],
  [{ status: "paused", pause_reason: "inbound_reply" }, "replied"],
  [{ status: "paused", pause_reason: "rep_sms_human_takeover" }, "replied"],
  [{ status: "paused", pause_reason: "provider_failed" }, "couldnt_send"],
  [{ status: "paused", pause_reason: "reconciliation_required" }, "couldnt_send"],
  [{ status: "opted_out" }, "stopped"],
  [{ status: "completed", canceled: true }, "stopped"],
  [{ status: "completed", inboundAfterLastRun: false }, "finished_no_reply"],
  [{ status: "completed", inboundAfterLastRun: true }, null],
  [{ status: "paused", pause_reason: "manual" }, null],
] as const)("maps %j to %s", (input, expected) => {
  expect(dripBucket(input)).toBe(expected);
  if (expected) expect(DRIP_BUCKET_LABELS[expected]).toBeTruthy();
});
