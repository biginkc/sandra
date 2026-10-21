import { describe, expect, it } from "vitest";

import {
  assertCanaryRow, assertCanaryTargetPhone, canaryNames, isWatchDone, parseCanaryArgs,
} from "./canary-voicemail-drop-guards";

const runId = "rvm-2026-10-21t15-00-00-000";
const names = canaryNames(runId);

describe("phone allowlist", () => {
  it("accepts only the canary cell in any format", () => {
    for (const p of ["+13107540662", "3107540662", "(310) 754-0662", "1-310-754-0662"]) {
      expect(assertCanaryTargetPhone(p)).toBe("+13107540662");
    }
  });
  it("refuses every other phone", () => {
    for (const p of ["+13107540663", "+18164876899", "", null, "310754066", "+443107540662"]) {
      expect(() => assertCanaryTargetPhone(p)).toThrow(/only \+13107540662/);
    }
  });
});

describe("canary-only rows", () => {
  const ids = { propertyId: "p1", contactId: "c1" };
  it("accepts rows carrying this run's marker", () => {
    expect(() => assertCanaryRow("contact", { last_name: names.contactLastName, phone_1: "3107540662" }, runId)).not.toThrow();
    expect(() => assertCanaryRow("property", { address: names.propertyAddress }, runId)).not.toThrow();
    expect(() => assertCanaryRow("sequence", { name: names.sequenceName }, runId)).not.toThrow();
    expect(() => assertCanaryRow("call_activity", { jitter_attempt_id: names.callAttemptId, provider: "prod_canary" }, runId)).not.toThrow();
    expect(() => assertCanaryRow("voicemail_drop", { property_id: "p1", contact_id: "c1", to_phone: "+13107540662" }, runId, ids)).not.toThrow();
  });
  it("refuses real rows and other runs", () => {
    expect(() => assertCanaryRow("property", { id: "x", address: "123 Main St" }, runId)).toThrow(/not a canary row/);
    expect(() => assertCanaryRow("property", { address: canaryNames("rvm-other-run1").propertyAddress }, runId)).toThrow();
    expect(() => assertCanaryRow("sequence", { name: "Seller follow-up" }, runId)).toThrow();
    expect(() => assertCanaryRow("contact", { last_name: names.contactLastName, phone_1: "8165550100" }, runId)).toThrow(/only/);
    expect(() => assertCanaryRow("contact", { last_name: names.contactLastName, phone_1: "3107540662", phone_2: "8165550100" }, runId)).toThrow();
    expect(() => assertCanaryRow("call_activity", { jitter_attempt_id: names.callAttemptId, provider: "dialpad" }, runId)).toThrow();
    expect(() => assertCanaryRow("enrollment", { property_id: "real" }, runId, ids)).toThrow();
    expect(() => assertCanaryRow("voicemail_drop", { property_id: "p1", contact_id: "c1", to_phone: "+18165550100" }, runId, ids)).toThrow();
    expect(() => assertCanaryRow("contact", null, runId)).toThrow(/missing/);
  });
});

describe("args", () => {
  it("requires script text on create and has no default", () => {
    expect(() => parseCanaryArgs([])).toThrow(/--script/);
    expect(() => parseCanaryArgs(["--script", "  "])).toThrow(/--script/);
    expect(parseCanaryArgs(["--script", "Approved words", "--run-id", runId])).toMatchObject({ mode: "create", script: "Approved words", runId });
  });
  it("needs a run id for other modes and rejects mixing", () => {
    expect(() => parseCanaryArgs(["--cleanup"])).toThrow(/run id/);
    expect(() => parseCanaryArgs(["--watch", "--cleanup", "--run-id", runId])).toThrow(/one mode/);
    expect(() => parseCanaryArgs(["--watch", "--run-id", runId, "--script", "x"])).toThrow();
    expect(parseCanaryArgs(["--after-callback", `--run-id=${runId}`]).mode).toBe("after-callback");
  });
});

describe("watch completion", () => {
  it("waits for proof on delivered drops", () => {
    expect(isWatchDone({ status: "queued", proof_storage_path: null }, "active")).toBe(false);
    expect(isWatchDone({ status: "delivered", proof_storage_path: null }, "completed")).toBe(false);
    expect(isWatchDone({ status: "delivered", proof_storage_path: "a/b.mp3" }, "completed")).toBe(true);
    expect(isWatchDone({ status: "failed", proof_storage_path: null }, "completed")).toBe(true);
    expect(isWatchDone(null, "active")).toBe(false);
    expect(isWatchDone(null, "completed")).toBe(true);
  });
});
