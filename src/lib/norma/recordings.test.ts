import { describe, expect, it } from "vitest";
import { normaRecordings } from "./recordings";

describe("Norma recording identities", () => {
  it("supports legacy requests without retry columns", () => {
    expect(normaRecordings({ bland_call_id: "call-1" })).toEqual([{ attempt: 1, callId: "call-1" }]);
  });
  it("keeps each retry recording with its actual attempt", () => {
    expect(normaRecordings({ attempt: 2, first_bland_call_id: "call-1", bland_call_id: "call-2" })).toEqual([
      { attempt: 1, callId: "call-1" }, { attempt: 2, callId: "call-2" },
    ]);
  });
  it("retains attempt one while attempt two has not bound a call", () => {
    expect(normaRecordings({ attempt: 2, first_bland_call_id: "call-1", bland_call_id: null })).toEqual([{ attempt: 1, callId: "call-1" }]);
  });
  it.each([null, "", "https://evil.test/audio", "../../key", "x".repeat(129)])("rejects unsafe or absent provider identity %s", (id) => {
    expect(normaRecordings({ bland_call_id: id, recording_url: "https://evil.test/audio" })).toEqual([]);
  });
});
