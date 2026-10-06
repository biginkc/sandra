import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, maybeSingle, authorize } = vi.hoisted(() => ({ getUser: vi.fn(), maybeSingle: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: () => query, eq: () => query, maybeSingle };
  return { auth: { getUser }, from: () => query };
} }));
vi.mock("@/lib/recordings/dialpad-audio-playback", () => ({ authorizeDialpadAudio: authorize }));

import { GET } from "./route";

const row = (over: Record<string, unknown> = {}) => ({
  id: "call-1", org_id: "org-1", provider: "dialpad", recording_status: "none", transcript_status: "none", summary_status: "none",
  call_recordings: [], call_transcripts: [], ...over,
});
const request = () => GET(new Request("https://example.test"), { params: Promise.resolve({ callActivityId: "call-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "member" } } });
  maybeSingle.mockResolvedValue({ error: null, data: row() });
});

describe("Dialpad call artifacts", () => {
  it("reports the recording as available, with its duration, only when the SQL authorization grants it", async () => {
    authorize.mockResolvedValue({ audioId: "a1", path: "p", sha256: null, durationMs: 36400, mode: "rep" });
    const body = await (await request()).json();
    expect(body).toMatchObject({ recordingStatus: "available", durationSeconds: 36 });
    expect(authorize).toHaveBeenCalledWith({ actorId: "member", orgId: "org-1", callActivityId: "call-1" });
    expect(JSON.stringify(body)).not.toContain("\"p\"");
  });

  it("reports no recording for anyone the authorization denies, whatever the call_recordings rows say", async () => {
    authorize.mockResolvedValue(null);
    maybeSingle.mockResolvedValue({ error: null, data: row({ recording_status: "available", call_recordings: [{ status: "available", duration_seconds: 99 }] }) });
    expect(await (await request()).json()).toMatchObject({ recordingStatus: "none", durationSeconds: null });
  });

  it("a failed authorization lookup is a 500 without detail", async () => {
    authorize.mockRejectedValue(new Error("sensitive"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive");
  });

  it("does not consult the Dialpad authorization for other providers", async () => {
    maybeSingle.mockResolvedValue({ error: null, data: row({ provider: "jitter", call_recordings: [{ status: "available", duration_seconds: 51 }] }) });
    expect(await (await request()).json()).toMatchObject({ recordingStatus: "available", durationSeconds: 51 });
    expect(authorize).not.toHaveBeenCalled();
  });
});
