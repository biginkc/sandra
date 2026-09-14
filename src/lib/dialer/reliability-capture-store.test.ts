import { describe, expect, it } from "vitest";
import { parseReliabilityCaptureConfig } from "./reliability-capture-store";

const now = 1_000_000;
const target = { phoneE164: "+15555550100", callerIdE164: "+15555550200" };
const config = {
  runId: "qa_run_123",
  destinationE164: target.phoneE164,
  callerIdE164: target.callerIdE164,
  expiresAtEpochMs: now + 60_000,
};

describe("scoped reliability capture configuration", () => {
  it("accepts only the exact destination and permitted caller ID", () => {
    expect(parseReliabilityCaptureConfig(JSON.stringify(config), target, now)).toEqual(config);
    expect(parseReliabilityCaptureConfig(JSON.stringify(config), { ...target, phoneE164: "+15555550300" }, now)).toBeNull();
    expect(parseReliabilityCaptureConfig(JSON.stringify(config), { ...target, callerIdE164: "+15555550300" }, now)).toBeNull();
  });

  it("rejects malformed, expired and overlong configurations", () => {
    expect(parseReliabilityCaptureConfig("not json", target, now)).toBeNull();
    expect(parseReliabilityCaptureConfig(JSON.stringify({ ...config, runId: "../escape" }), target, now)).toBeNull();
    expect(parseReliabilityCaptureConfig(JSON.stringify({ ...config, expiresAtEpochMs: now }), target, now)).toBeNull();
    expect(parseReliabilityCaptureConfig(JSON.stringify({ ...config, expiresAtEpochMs: now + 3 * 60 * 60_000 }), target, now)).toBeNull();
  });
});
