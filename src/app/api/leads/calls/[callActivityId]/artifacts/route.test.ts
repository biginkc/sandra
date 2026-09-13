const { recordingStatusResolver } = vi.hoisted(() => ({ recordingStatusResolver: vi.fn() }));
vi.mock("@/lib/dialpad-voice/recording-status", () => ({ resolveDialpadRecordingStatus: recordingStatusResolver }));
vi.mock("@/lib/dialpad-voice/insights-status", () => ({ resolveDialpadInsightStatus: async (_client: unknown, _org: string, _call: string, _state: string, stored: string | null | undefined) => stored ?? "pending" }));
const { ownedSegments } = vi.hoisted(() => ({ ownedSegments: vi.fn() }));
vi.mock("@/lib/dialpad-voice/recording-playback", () => ({ loadOwnedDialpadSegments: ownedSegments, publicRecordingSegments: (rows: Array<{id:string;decoded_duration_seconds:number}>) => rows.map(r => ({ artifactId:r.id,durationSeconds:r.decoded_duration_seconds })) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, maybeSingle, eq, from } = vi.hoisted(() => ({ getUser: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: () => query, eq: eq.mockImplementation(() => query), maybeSingle };
  return { auth: { getUser }, from: from.mockReturnValue(query) };
} }));
import { GET } from "./route";
const request = () => GET(new Request("https://example.test"), { params: Promise.resolve({ callActivityId: "call-id" }) });
beforeEach(() => { vi.clearAllMocks(); recordingStatusResolver.mockImplementation(async (_client: unknown, _org: string, _call: string, complete: boolean) => complete ? "available" : "pending"); getUser.mockResolvedValue({ data: { user: { id: "member" } } }); });
describe("authorized call artifacts", () => {
  it("rejects anonymous access before any data lookup", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await request()).status).toBe(401); expect(from).not.toHaveBeenCalled();
  });
  it("treats RLS-inaccessible and missing calls identically", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await request(); expect(response.status).toBe(404);
    expect(eq).toHaveBeenCalledWith("id", "call-id"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps working audio and transcript independent from failed summary and omits diagnostics", async () => {
    maybeSingle.mockResolvedValue({ error: null, data: {
      recording_status: "none", transcript_status: "available", summary_status: "failed",
      call_recordings: [{ status: "available", duration_seconds: 51, storage_path: "private" }],
      call_transcripts: [{ status: "available", text: "Seller transcript", summary_status: "failed", summary: "stale", summary_error_message: "secret provider error" }],
    } });
    expect(await (await request()).json()).toEqual({ recordingStatus: "available", durationSeconds: 51, transcriptStatus: "available", transcript: "Seller transcript", summaryStatus: "failed", summary: null });
  });
  it("does not disclose database failures", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "sensitive diagnostic" } });
    const response = await request(); expect(response.status).toBe(500); expect(await response.text()).not.toContain("sensitive");
  });
});

describe("Dialpad artifact availability", () => {
  it("does not claim external available recording is retained", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "call-id", org_id: "org", provider: "dialpad", provider_call_id: "provider-call", recording_status: "available", call_recordings: [{ status: "available", duration_seconds: 10 }], call_transcripts: [] } });
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }) };
    ownedSegments.mockResolvedValue({ segments: [], admin: { from: () => query, rpc: async () => ({ data: false, error: null }) } });
    const body = await (await request()).json();
    expect(body.recordingStatus).toBe("pending"); expect(body.recordingSegments).toEqual([]);
    expect(ownedSegments).toHaveBeenCalledWith("org", "provider-call");
  });
  it("does not read service artifacts for RLS-hidden parent", async () => {
    maybeSingle.mockResolvedValue({ data: null }); expect((await request()).status).toBe(404); expect(ownedSegments).not.toHaveBeenCalled();
  });
});


describe("Dialpad manifest completeness", () => {
  function setup(complete: boolean | null, segments: Array<{id: string; decoded_duration_seconds: number}>, error: unknown = null) {
    maybeSingle.mockResolvedValue({ data: { id: "call-id", org_id: "org", provider: "dialpad", provider_call_id: "provider-call", call_recordings: [], call_transcripts: [] } });
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }) };
    const rpc = vi.fn().mockResolvedValue({ data: complete, error });
    ownedSegments.mockResolvedValue({ segments, admin: { from: () => query, rpc } });
    return rpc;
  }
  it("does not present one retained segment as the complete call", async () => {
    const rpc = setup(false, [{ id: "segment-1", decoded_duration_seconds: 10 }]);
    const body = await (await request()).json();
    expect(body.recordingStatus).toBe("pending"); expect(body.recordingComplete).toBe(false);
    expect(body.durationSeconds).toBeNull(); expect(body.recordingSegments).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("fn_dialpad_recording_complete", { p_org_id: "org", p_call_id: "provider-call" });
  });
  it("makes all retained manifest segments available without inventing aggregate duration", async () => {
    setup(true, [{ id: "segment-1", decoded_duration_seconds: 10 }, { id: "segment-2", decoded_duration_seconds: 12 }]);
    const body = await (await request()).json();
    expect(body.recordingStatus).toBe("available"); expect(body.recordingComplete).toBe(true);
    expect(body.durationSeconds).toBeNull(); expect(body.recordingSegments).toHaveLength(2);
  });
  it("shows duration for one complete retained segment", async () => {
    setup(true, [{ id: "segment-1", decoded_duration_seconds: 10 }]);
    expect(await (await request()).json()).toMatchObject({ recordingComplete: true, recordingStatus: "available", durationSeconds: 10 });
  });
  it("fails closed when completeness cannot be read", async () => {
    setup(null, [{ id: "segment-1", decoded_duration_seconds: 10 }], { message: "private" });
    const response = await request(); expect(response.status).toBe(503);expect(await response.text()).not.toContain("private");
  });
});


it("reports recording failure while preserving already playable partial segments", async () => {
  maybeSingle.mockResolvedValue({ data: { id: "call-id", org_id: "org", provider: "dialpad", provider_call_id: "provider-call", call_recordings: [], call_transcripts: [] } });
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }) };
  ownedSegments.mockResolvedValue({ segments: [{ id: "partial", decoded_duration_seconds: 10 }], admin: { from: () => query, rpc: async () => ({ data: false }) } });
  recordingStatusResolver.mockResolvedValue("failed");
  const body = await (await request()).json();
  expect(body).toMatchObject({ recordingStatus: "failed", recordingComplete: false, durationSeconds: null, recordingSegments: [{ artifactId: "partial", durationSeconds: 10 }] });
  expect(recordingStatusResolver).toHaveBeenCalledWith(expect.anything(), "org", "provider-call", false);
});
