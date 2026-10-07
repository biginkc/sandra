import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, maybeSingle, from, eq, select } = vi.hoisted(() => ({
  getUser: vi.fn(), maybeSingle: vi.fn(), from: vi.fn(), eq: vi.fn(), select: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: select.mockImplementation(() => query), eq: eq.mockImplementation(() => query), maybeSingle };
  from.mockReturnValue(query);
  return { auth: { getUser }, from };
} }));
import { GET as list } from "./route";
import { GET as audio } from "./[attempt]/route";
const ID = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();
const request = (attempt = "1", headers: Record<string, string> = {}, requestId = ID) => audio(new Request("https://sandra.test/audio", { headers }), { params: Promise.resolve({ requestId, attempt }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("BLAND_API_KEY", "private-test-key");
  getUser.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
  maybeSingle.mockResolvedValue({ data: { id: ID, bland_call_id: "call-1" }, error: null });
  fetchMock.mockImplementation(async () => new Response("audio-bytes", { headers: { "content-type": "audio/mpeg" } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Norma recording playback authorization and transport", () => {
  it("requires a session before querying call identities", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await request()).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails closed on authentication errors", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "member" } }, error: { message: "expired" } });
    expect((await request()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses session RLS and does not fetch audio for an invisible request", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await request()).status).toBe(404);
    expect(from).toHaveBeenCalledWith("norma_call_requests");
    expect(eq).toHaveBeenCalledWith("id", ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not expose database errors", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "private-database-details" } });
    const r = await request();
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("private-database-details");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("validates request IDs and attempt selection", async () => {
    expect((await request("1", {}, "not-a-uuid")).status).toBe(400);
    expect((await request("3")).status).toBe(400);
    expect((await request("2")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("lists only attempt numbers, without provider IDs, URLs, or call contents", async () => {
    maybeSingle.mockResolvedValue({ data: { id: ID, attempt: 2, first_bland_call_id: "call-1", bland_call_id: "call-2", summary: "private summary", recording_url: "https://evil.test/audio" }, error: null });
    const r = await list(new Request("https://sandra.test"), { params: Promise.resolve({ requestId: ID }) });
    expect(await r.json()).toEqual({ recordings: [{ attempt: 1 }, { attempt: 2 }] });
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fetches a fixed provider endpoint and streams audio without exposing its key or URL", async () => {
    const r = await request();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("audio-bytes");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledWith("https://api.bland.ai/v1/recordings/call-1", expect.objectContaining({
      redirect: "error", cache: "no-store", headers: { authorization: "Bearer private-test-key", "content-type": "audio/mpeg", "accept-encoding": "identity" },
    }));
    expect([...r.headers.values()].join(" ")).not.toMatch(/private-test-key|bland.ai/);
  });
  it("fetches the first attempt rather than the current attempt when requested", async () => {
    maybeSingle.mockResolvedValue({ data: { attempt: 2, first_bland_call_id: "first", bland_call_id: "second" }, error: null });
    await (await request("1")).text();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.bland.ai/v1/recordings/first");
  });
  it("supports single audio ranges and preserves a partial response", async () => {
    fetchMock.mockResolvedValue(new Response("part", { status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-3/10", "accept-ranges": "bytes" } }));
    const r = await request("1", { range: "bytes=0-3" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(fetchMock.mock.calls[0][1].headers.range).toBe("bytes=0-3");
    expect(await r.text()).toBe("part");
  });
  it("rejects multipart or malformed ranges before provider access", async () => {
    expect((await request("1", { range: "bytes=0-3,8-9" })).status).toBe(416);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("handles delayed recording availability and provider failure without leaking provider output", async () => {
    for (const status of [404, 401, 429, 500, 302]) {
      fetchMock.mockResolvedValue(new Response("private provider details", { status }));
      const r = await request();
      expect(r.status).toBe(status === 404 ? 404 : 502);
      expect(await r.text()).not.toContain("private provider details");
    }
  });
  it("rejects successful JSON/HTML responses and oversized declared audio", async () => {
    for (const headers of [{ "content-type": "application/json" }, { "content-type": "text/html" }, { "content-type": "audio/mpeg", "content-length": String(64 * 1024 * 1024 + 1) }] as Record<string, string>[]) {
      fetchMock.mockResolvedValue(new Response("unexpected", { headers }));
      expect((await request()).status).toBe(502);
    }
  });
  it("rejects compressed responses even when their declared length fits", async () => {
    fetchMock.mockResolvedValue(new Response("audio", { headers: { "content-type": "audio/mpeg", "content-encoding": "gzip", "content-length": "5" } }));
    expect((await request()).status).toBe(502);
  });
  it("preserves an unsatisfiable range without exposing provider output", async () => {
    fetchMock.mockResolvedValue(new Response("private", { status: 416, headers: { "content-range": "bytes */123" } }));
    const result = await request("1", { range: "bytes=999-" });
    expect(result.status).toBe(416);
    expect(result.headers.get("content-range")).toBe("bytes */123");
    expect(await result.text()).not.toContain("private");
  });
  it("clears the header timeout while audio continues streaming", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response("audio", { headers: { "content-type": "audio/mpeg" } });
    });
    const result = await request();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(signal?.aborted).toBe(false);
    expect(await result.text()).toBe("audio");
  });
  it("bounds audio streams without a content-length header", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < 65; i++) controller.enqueue(chunk);
      controller.close();
    } });
    fetchMock.mockResolvedValue(new Response(body, { headers: { "content-type": "audio/mpeg" } }));
    const result = await request();
    await expect(result.arrayBuffer()).rejects.toThrow("Recording exceeds the playback size limit");
  });
  it("handles network timeout and missing configuration", async () => {
    fetchMock.mockRejectedValue(new Error("private upstream details"));
    expect((await request()).status).toBe(502);
    vi.stubEnv("BLAND_API_KEY", "");
    fetchMock.mockClear();
    expect((await request()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
