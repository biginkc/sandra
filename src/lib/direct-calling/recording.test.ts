import { describe, expect, it, vi } from "vitest";

import { createDirectRecordingHandler, parseDirectRecordingSaved } from "./recording";

const ROW = { id: "11111111-1111-4111-8111-111111111111", org_id: "22222222-2222-4222-8222-222222222222", seller_leg_id: "seller-leg" } as never;

function wav(): Uint8Array {
  const out = new Uint8Array(52);
  const chars = (value: string) => [...value].map((c) => c.charCodeAt(0));
  out.set(chars("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 40, true);
  out.set(chars("WAVE"), 8);
  out.set([...chars("fmt "), 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0], 12);
  out.set([...chars("data"), 4, 0, 0, 0], 36);
  return out;
}

function adminFixture(activityId: string | null = null) {
  const rows = new Map<string, Record<string, unknown>>();
  const upload = vi.fn(async () => ({ error: null }));
  const admin = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const id = String(args.p_provider_recording_id ?? "");
      const current = rows.get(id);
      if (name === "direct_call_recording_claim") {
        if (current?.status === "available" && current.storage_path) return { data: [{ should_capture: false, ...current }], error: null };
        if (current?.status === "pending" && current.next_attempt_at && new Date(String(current.next_attempt_at)).getTime() > Date.now()) return { data: [{ should_capture: false, ...current }], error: null };
        const next = { ...(current ?? {}), direct_call_id: args.p_direct_call_id, provider_recording_id: id, provider_call_control_id: args.p_provider_call_control_id, provider_call_leg_id: args.p_provider_call_leg_id, provider_call_session_id: args.p_provider_call_session_id, status: "pending", attempt_count: Number(current?.attempt_count ?? 0) + 1, next_attempt_at: new Date(Date.now() + 900_000).toISOString() };
        rows.set(id, next);
        return { data: [{ should_capture: true, ...next }], error: null };
      }
      if (name === "direct_call_recording_mark_available") {
        rows.set(id, { ...(current ?? {}), status: "available", storage_bucket: args.p_storage_bucket, storage_path: args.p_storage_path, duration_seconds: args.p_duration_seconds, next_attempt_at: null });
        return { data: true, error: null };
      }
      if (name === "direct_call_recording_mark_failed") {
        if (current?.status !== "available") rows.set(id, { ...(current ?? {}), status: "failed", error_code: args.p_error_code, error_message: args.p_error_message, next_attempt_at: new Date(Date.now() + 30_000).toISOString() });
        return { data: true, error: null };
      }
      if (name === "direct_call_recording_sync_activity") return { data: null, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    }),
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((_column: string, value: string) => ({
          maybeSingle: vi.fn(async () => ({ data: table === "direct_call_recordings" ? rows.get(value) ?? null : table === "call_activities" && activityId ? { id: activityId } : null, error: null })),
          single: vi.fn(async () => ({ data: rows.get(value) ?? null, error: null })),
        })),
      })),
      upsert: vi.fn((value: Record<string, unknown>) => {
        rows.set(String(value.provider_recording_id), { ...rows.get(String(value.provider_recording_id)), ...value });
        return { select: vi.fn(() => ({ single: vi.fn(async () => ({ data: value, error: null })) })) };
      }),
      update: vi.fn((value: Record<string, unknown>) => ({ eq: vi.fn(async (_column: string, id: string) => { const old = rows.get(id) ?? {}; rows.set(id, { ...old, ...value }); return { error: null }; }) })),
    })),
    storage: { from: vi.fn(() => ({ upload })) },
  };
  return { admin, rows, upload };
}

function raw(id = "event-1") {
  return JSON.stringify({ data: { id, event_type: "call.recording.saved", occurred_at: "2026-10-01T12:00:00Z", payload: { recording_id: "rec-1", call_control_id: "seller-leg", call_leg_id: "leg-1", call_session_id: "session-1" } } });
}

describe("direct recording capture", () => {
  it("parses the signed-event payload and rejects incomplete events", () => {
    expect(parseDirectRecordingSaved(raw())).toMatchObject({ recordingId: "rec-1", callControlId: "seller-leg", callLegId: "leg-1" });
    expect(parseDirectRecordingSaved(JSON.stringify({ data: { event_type: "call.answered", payload: {} } }))).toBeNull();
  });

  it("stores a bounded WAV once and treats a duplicate saved event as idempotent", async () => {
    const { admin, upload } = adminFixture();
    const getRecording = vi.fn(async () => ({ recordingId: "rec-1", status: "completed", durationMillis: 74000, downloadUrlWav: "https://cdn.telnyx.test/rec.wav" }));
    const handler = createDirectRecordingHandler({ admin, getRecording, fetchImpl: vi.fn(async () => new Response(new Blob([wav().buffer as ArrayBuffer]), { status: 200, headers: { "content-type": "audio/wav" } })) as never });
    const parsed = parseDirectRecordingSaved(raw())!;
    await handler(ROW, parsed);
    await handler(ROW, parsed);
    expect(getRecording).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("re-syncs an already available ledger when a duplicate arrives after wrap-up", async () => {
    const { admin } = adminFixture("activity-1");
    const getRecording = vi.fn(async () => ({ recordingId: "rec-1", status: "completed", durationMillis: 74000, downloadUrlWav: "https://cdn.telnyx.test/rec.wav" }));
    const handler = createDirectRecordingHandler({ admin, getRecording, fetchImpl: vi.fn(async () => new Response(new Blob([wav().buffer as ArrayBuffer]), { status: 200 })) as never });
    const parsed = parseDirectRecordingSaved(raw())!;
    await handler(ROW, parsed);
    await handler(ROW, parsed);
    expect(getRecording).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledWith("direct_call_recording_sync_activity", expect.objectContaining({ p_call_activity_id: "activity-1" }));
    expect(admin.rpc.mock.calls.filter(([name]) => name === "direct_call_recording_sync_activity")).toHaveLength(2);
  });

  it("leases concurrent duplicate deliveries so only one provider download runs", async () => {
    const { admin, upload } = adminFixture();
    const getRecording = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { recordingId: "rec-1", status: "completed", durationMillis: 74000, downloadUrlWav: "https://cdn.telnyx.test/rec.wav" };
    });
    const handler = createDirectRecordingHandler({ admin, getRecording, fetchImpl: vi.fn(async () => new Response(new Blob([wav().buffer as ArrayBuffer]), { status: 200, headers: { "content-type": "audio/wav" } })) as never });
    const parsed = parseDirectRecordingSaved(raw())!;
    await Promise.all([handler(ROW, parsed), handler(ROW, parsed)]);
    expect(getRecording).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed capture truthful and retryable", async () => {
    const { admin } = adminFixture();
    const handler = createDirectRecordingHandler({ admin, getRecording: vi.fn(async () => ({ recordingId: "rec-1", status: "completed", durationMillis: null, downloadUrlWav: "https://cdn.telnyx.test/rec.wav" })), fetchImpl: vi.fn(async () => new Response("bad", { status: 200 })) as never });
    await expect(handler(ROW, parseDirectRecordingSaved(raw())!)).rejects.toThrow("recording_wav_invalid");
  });
});
