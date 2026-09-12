import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, maybeSingle, eq, from } = vi.hoisted(() => ({ getUser: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: () => query, eq: eq.mockImplementation(() => query), maybeSingle };
  return { auth: { getUser }, from: from.mockReturnValue(query) };
} }));
import { GET } from "./route";
const request = () => GET(new Request("https://example.test"), { params: Promise.resolve({ callActivityId: "call-id" }) });
beforeEach(() => { vi.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id: "member" } } }); });
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
