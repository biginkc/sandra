import { describe, expect, it, vi } from "vitest";

import { sweepDirectRecordingCaptures } from "./recording-sweep";

const CALL = { id: "11111111-1111-4111-8111-111111111111", org_id: "22222222-2222-4222-8222-222222222222", seller_leg_id: "seller-leg", status: "ended" };

function wav(): Uint8Array {
  const out = new Uint8Array(52);
  const chars = (value: string) => [...value].map((c) => c.charCodeAt(0));
  out.set(chars("RIFF"), 0); new DataView(out.buffer).setUint32(4, 40, true); out.set(chars("WAVE"), 8);
  out.set([...chars("fmt "), 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0], 12);
  out.set([...chars("data"), 4, 0, 0, 0], 36);
  return out;
}

describe("direct recording retry sweep", () => {
  it("replays due rows through the same leased capture handler", async () => {
    const ledger = {
      status: "failed" as const,
      direct_call_id: CALL.id,
      provider_recording_id: "rec-1",
      provider_call_control_id: "seller-leg",
      provider_call_leg_id: "leg-1",
      provider_call_session_id: "session-1",
    };
    const linkLedger = { ...ledger, status: "available" as const, provider_recording_id: "rec-available" };
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "direct_call_recordings") {
          let mode: "capture" | "link" = "capture";
          const query = { select: () => query, in: () => (mode = "capture", query), eq: () => (mode = "link", query), lt: () => query, lte: () => query, order: () => query, limit: async () => ({ data: mode === "capture" ? [ledger] : [linkLedger], error: null }) };
          return query;
        }
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: CALL, error: null }) };
        return query;
      }),
      rpc: vi.fn(async (name: string) => {
        if (name === "direct_call_recording_claim") return { data: [{ should_capture: true, status: "pending", storage_path: null }], error: null };
        if (name === "direct_call_recording_mark_available") return { data: true, error: null };
        if (name === "direct_call_recording_sync_activity") return { data: null, error: null };
        return { data: true, error: null };
      }),
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
    };
    const getRecording = vi.fn(async () => ({ recordingId: "rec-1", status: "completed", durationMillis: 1_000, downloadUrlWav: "https://cdn.telnyx.test/rec.wav" }));
    const summary = await sweepDirectRecordingCaptures({
      admin,
      getRecording,
      fetchImpl: vi.fn(async () => new Response(new Blob([wav().buffer as ArrayBuffer]), { status: 200 })) as never,
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    expect(summary).toEqual({ candidates: 2, attempted: 2, succeeded: 2, failed: 0 });
    expect(getRecording).toHaveBeenCalledWith("rec-1");
    expect(getRecording).toHaveBeenCalledTimes(1);
  });
});
