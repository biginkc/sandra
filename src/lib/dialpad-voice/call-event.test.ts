import { describe, expect, it } from "vitest";
import { normalizeDialpadCallEvent as normalize } from "./call-event";

const event = { call_id: "4904023124647936", event_timestamp: "1789300000000", state: "connected", target: { id: 123, type: "user" }, direction: "outbound" };
describe("normalizeDialpadCallEvent", () => {
  it("preserves exact string IDs, milliseconds and null durations without inferring a reached outcome", () => {
    const result = normalize({ ...event, call_id: "9007199254740993", duration: null });
    expect(result).toMatchObject({ callId: "9007199254740993", targetId: "123", eventTimestampMs: 1789300000000, durationMs: null, totalDurationMs: null, terminal: false });
    expect(result).not.toHaveProperty("reached");
    expect(result).not.toHaveProperty("leadId");
  });
  it("rejects rounded numeric IDs and unsafe or malformed timestamps", () => {
    for (const patch of [{ call_id: 9007199254740992 }, { target: { id: 9007199254740992 } }, { event_timestamp: Infinity }, { event_timestamp: "1.5" }, { event_timestamp: "" }, { event_timestamp: -1 }]) {
      expect(() => normalize({ ...event, ...patch })).toThrow("Invalid Dialpad call event");
    }
  });
  it("keeps connected and total duration distinct with fractional milliseconds", () => {
    expect(normalize({ ...event, duration: 13303.755, total_duration: "19303.775", date_started: "1000", date_connected: 2000, date_ended: 3000 })).toMatchObject({ durationMs: 13303.755, totalDurationMs: 19303.775, startedAtMs: 1000, connectedAtMs: 2000, endedAtMs: 3000 });
    expect(() => normalize({ ...event, duration: NaN })).toThrow();
  });
  it("recognizes terminal states but does not treat artifact readiness as a new terminal event", () => {
    for (const state of ["hangup", "missed"]) expect(normalize({ ...event, state }).terminal).toBe(true);
    for (const state of ["recording", "call_transcription", "voicemail", "future_state"]) expect(normalize({ ...event, state }).terminal).toBe(false);
  });
  it("accepts only UUID correlation, without interpreting arbitrary custom data as attribution", () => {
    const uuid = "A0B1C2D3-1111-4222-8333-123456789ABC";
    expect(normalize({ ...event, custom_data: uuid }).intentId).toBe(uuid.toLowerCase());
    for (const custom_data of ["lead-123", '{"leadId":"123"}', "", null]) expect(normalize({ ...event, custom_data }).intentId).toBeNull();
  });
  it("retains every untrusted recording segment without declaring its URL downloadable", () => {
    const result = normalize({ ...event, state: "recording", recording_details: [{ id: "opaque-recording", url: "https://untrusted.test/audio", recording_type: "admincallrecording", duration: "12.5", start_time: 1000 }, { id: 456 }] });
    expect(result.recordings).toEqual([{ id: "opaque-recording", url: "https://untrusted.test/audio", recordingType: "admincallrecording", durationMs: 12.5, startTimeMs: 1000 }, { id: "456", url: null, recordingType: null, durationMs: null, startTimeMs: null }]);
  });
  it("leaves ordering and enrichment merging to persistence without modifying input", () => {
    const late = Object.freeze({ ...event, state: "recording", event_timestamp: 3000 });
    const terminal = normalize({ ...event, state: "hangup", event_timestamp: 2000 });
    expect(normalize(late).eventTimestampMs).toBe(3000);
    expect(terminal.terminal).toBe(true);
  });
});
