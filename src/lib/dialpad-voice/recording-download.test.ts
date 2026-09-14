import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadDialpadRecording, type RecordingDecoder } from "./recording-download";

const url = "https://dialpad.com/blob/adminrecording/test-recording";
const apiKey = "secret-test-only";
// A real 100ms PCM WAV fixture. Decode every sample; do not confuse a header
// probe with successful media decoding. Production compressed formats need their
// own full-file decoder supplied by the worker.
function wav() {
  const data = Buffer.alloc(44 + 1600);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(1600, 40);
  for (let i = 0; i < 800; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), 44 + i * 2);
  return data;
}
const decode: RecordingDecoder = async (bytes, format) => {
  const b = Buffer.from(bytes);
  if (format !== "wav" || b.readUInt16LE(20) !== 1 || b.readUInt16LE(34) !== 16 ||
      b.readUInt32LE(4) + 8 !== b.length || b.readUInt32LE(40) + 44 !== b.length) throw Error("invalid PCM");
  const samples: number[] = [];
  for (let i = 44; i < b.length; i += 2) samples.push(b.readInt16LE(i) / 32768);
  return { durationSeconds: samples.length / 8000, channels: 1, sampleRate: 8000 };
};
function run(response: Response, extras: Partial<Parameters<typeof downloadDialpadRecording>[0]> = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetchImpl, result: downloadDialpadRecording({ url, apiKey, decode, fetchImpl, ...extras }) };
}
const audio = (bytes = wav(), headers = {}) => new Response(bytes, { headers: { "Content-Type": "audio/wav", ...headers } });

describe("downloadDialpadRecording", () => {
  it.each(["http://dialpad.com/blob/adminrecording/x", "https://dialpad.com.evil.test/blob/adminrecording/x", "https://user:pass@dialpad.com/blob/adminrecording/x", "https://127.0.0.1/blob/adminrecording/x", "https://dialpad.com:444/blob/adminrecording/x", "https://dialpad.com/api/v2/users", "https://dialpad.com/blob/adminrecording/../../login"])("rejects unsafe URL %s before authentication", async (badUrl) => {
    const { result, fetchImpl } = run(audio(), { url: badUrl });
    expect(await result).toEqual({ ok: false, reason: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([["/login?next=private", "login_required"], ["https://evil.test/audio", "redirect_rejected"]])("rejects redirect %s without forwarding credentials", async (location, reason) => {
    const { result, fetchImpl } = run(new Response(null, { status: 302, headers: { location } }));
    expect(await result).toEqual({ ok: false, reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual", cache: "no-store", headers: { Authorization: `Bearer ${apiKey}` } });
  });
  it("follows the proven same-host chain and cancels redirect bodies", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: "/secureblob/callrecording/segment" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/blob-server/segment?signature=opaque" } }))
      .mockResolvedValueOnce(audio());
    expect((await downloadDialpadRecording({ url: "https://dialpad.com/r/segment", apiKey, decode, fetchImpl })).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalled();
    expect(fetchImpl.mock.calls.every(([target]) => new URL(String(target)).hostname === "dialpad.com")).toBe(true);
  });
  it.each(["/r/../blob-server/x", "/r/%2e%2e/blob-server/x", "https://dialpad.com:443/r/x", "/blob-server/x#secret", "https://user@dialpad.com/r/x"])("rejects unsafe redirect %s", async location => {
    const h = run(new Response(null, { status: 302, headers: { location } }));
    expect(await h.result).toEqual({ ok: false, reason: "redirect_rejected" }); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects loops and bounds the chain to three redirects", async () => {
    const loop = run(new Response(null, { status: 302, headers: { location: url } }));
    expect(await loop.result).toEqual({ ok: false, reason: "redirect_rejected" });
    let n = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: `/blob-server/${++n}` } }));
    expect(await downloadDialpadRecording({ url, apiKey, decode, fetchImpl })).toEqual({ ok: false, reason: "redirect_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("keeps a single timeout budget across redirected requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/blob-server/x" } }))
      .mockImplementationOnce(() => new Promise(() => {}));
    expect(await downloadDialpadRecording({ url, apiKey, decode, fetchImpl, timeoutMs: 10 })).toEqual({ ok: false, reason: "timeout" });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(fetchImpl.mock.calls[1][1]?.signal);
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
  it.each(["text/html", "audio/wav"])("rejects HTML even with %s", async (mime) => {
    expect(await run(new Response("<!doctype html><html>login</html>", { headers: { "content-type": mime } })).result).toEqual({ ok: false, reason: "html_response" });
  });
  it("allows provider query parameters and octet-stream only after decoding", async () => {
    const result = await run(audio(wav(), { "Content-Type": "application/octet-stream" }), { url: url + "?signature=opaque" }).result;
    expect(result.ok).toBe(true);
    expect(await run(audio(Buffer.from("fake"), { "Content-Type": "application/octet-stream" })).result).toEqual({ ok: false, reason: "invalid_audio" });
  });
  it("bounds streamed bytes even without Content-Length", async () => {
    expect(await run(audio(), { maxBytes: 100 }).result).toEqual({ ok: false, reason: "too_large" });
  });
  it("rejects declared oversized response", async () => {
    expect(await run(audio(wav(), { "Content-Length": "9000" }), { maxBytes: 2000 }).result).toEqual({ ok: false, reason: "too_large" });
  });
  it("rejects truncated transfer", async () => {
    expect(await run(audio(wav(), { "Content-Length": "2000" })).result).toEqual({ ok: false, reason: "truncated" });
  });
  it("requires decode success, including media truncated without HTTP length", async () => {
    expect(await run(audio(wav().subarray(0, 100))).result).toEqual({ ok: false, reason: "decode_failed" });
  });
  it("sanitizes decoder and transport exceptions", async () => {
    expect(await run(audio(), { decode: async () => { throw Error(apiKey); } }).result).toEqual({ ok: false, reason: "decode_failed" });
    expect(await run(audio(), { fetchImpl: async () => { throw Error(apiKey); } }).result).toEqual({ ok: false, reason: "transport_error" });
  });
  it("rejects fake signature and mismatched MIME", async () => {
    expect(await run(audio(Buffer.from("not audio"))).result).toEqual({ ok: false, reason: "invalid_audio" });
    expect(await run(audio(wav(), { "Content-Type": "audio/mpeg" })).result).toEqual({ ok: false, reason: "invalid_audio" });
  });
  it("times out stalled transport", async () => {
    expect(await run(audio(), { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }).result).toEqual({ ok: false, reason: "timeout" });
  });
  it("requires valid decoded duration", async () => {
    expect(await run(audio(), { decode: async () => ({ durationSeconds: NaN, channels: 1, sampleRate: 8000 }) }).result).toEqual({ ok: false, reason: "decode_failed" });
  });
  it("decodes genuine synthetic PCM and returns checksum, without claiming storage", async () => {
    const b = wav();
    const result = await run(audio(b, { "Content-Length": String(b.length) })).result;
    expect(result).toMatchObject({ ok: true, verification: "decoded", format: "wav", decoded: { durationSeconds: 0.1, channels: 1, sampleRate: 8000 }, sha256: createHash("sha256").update(b).digest("hex") });
    if (result.ok) expect(result.bytes.equals(b)).toBe(true);
    expect(result).not.toHaveProperty("storageKey");
  });
});
