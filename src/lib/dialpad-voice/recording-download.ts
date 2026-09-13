import "server-only";
import { createHash } from "node:crypto";

export type RecordingDownloadFailure =
  | "invalid_configuration" | "invalid_url" | "login_required" | "redirect_rejected"
  | "http_error" | "html_response" | "invalid_audio" | "too_large"
  | "truncated" | "decode_failed" | "timeout" | "transport_error";
export type AudioFormat = "wav" | "mp3" | "ogg" | "flac";
export interface DecodedAudio {
  durationSeconds: number;
  channels: number;
  sampleRate: number;
}
export type RecordingDownloadResult =
  | { ok: false; reason: RecordingDownloadFailure }
  | { ok: true; verification: "decoded"; bytes: Buffer; sha256: string;
      format: AudioFormat; mimeType: string; decoded: DecodedAudio };

/** Implement with a real full-file decoder, not a metadata probe. Must reject
 * malformed/truncated media and honor signal (e.g. kill its decoder subprocess).
 * No production decoder is supplied here; callers cannot skip this gate. */
export type RecordingDecoder = (
  bytes: Uint8Array, format: AudioFormat, signal: AbortSignal,
) => Promise<DecodedAudio>;

function audioFormat(bytes: Buffer): AudioFormat | undefined {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (bytes.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (bytes.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "mp3";
}
const MIME_TYPES: Record<AudioFormat, string[]> = {
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  mp3: ["audio/mpeg", "audio/mp3"],
  ogg: ["audio/ogg", "application/ogg"],
  flac: ["audio/flac", "audio/x-flac"],
};

/** Retrieves and decodes bytes in memory. This is NOT durable storage or proof
 * of provider entitlement. Only pass URLs obtained from authenticated call data.
 * No redirects are followed: a future signed-storage redirect needs a separately
 * reviewed, credential-free fetch policy. Errors never echo URLs or credentials. */
export async function downloadDialpadRecording(options: {
  url: string;
  apiKey: string;
  decode: RecordingDecoder;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<RecordingDownloadResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fail = (reason: RecordingDownloadFailure): RecordingDownloadResult => ({ ok: false, reason });
  if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || typeof options.decode !== "function" ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return fail("invalid_configuration");
  let url: URL;
  try { url = new URL(options.url); } catch { return fail("invalid_url"); }
  if (url.protocol !== "https:" || url.hostname !== "dialpad.com" || url.port ||
      url.username || url.password || url.hash ||
      !/^\/(?:secureblob|blob)\/(?:callrecording|adminrecording)\/[A-Za-z0-9_./~-]+$/.test(url.pathname)) return fail("invalid_url");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RecordingDownloadResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(fail("timeout")); }, timeoutMs);
  });
  const work = async (): Promise<RecordingDownloadResult> => {
    try {
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        headers: { Authorization: `Bearer ${options.apiKey}`, "Accept-Encoding": "identity" },
        redirect: "manual", cache: "no-store", signal: controller.signal,
      });
      reader = response.body?.getReader();
      if (response.status >= 300 && response.status < 400) {
        let login = false;
        try { login = new URL(response.headers.get("location") ?? "", url).pathname === "/login"; } catch { /* reject all redirects */ }
        return fail(login ? "login_required" : "redirect_rejected");
      }
      if (response.status !== 200) return fail("http_error");
      const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (mime === "text/html" || mime === "application/xhtml+xml") return fail("html_response");
      if (mime !== "application/octet-stream" && !Object.values(MIME_TYPES).flat().includes(mime)) return fail("invalid_audio");
      const lengthHeader = response.headers.get("content-length");
      const expected = lengthHeader === null ? null : Number(lengthHeader);
      if (expected !== null && (!/^\d+$/.test(lengthHeader!) || !Number.isSafeInteger(expected))) return fail("truncated");
      if (expected !== null && expected > maxBytes) return fail("too_large");
      if (!reader) return fail("truncated");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        if (controller.signal.aborted) return fail("timeout");
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) return fail("too_large");
        chunks.push(Buffer.from(value));
      }
      if (size === 0 || (expected !== null && size !== expected)) return fail("truncated");
      const bytes = Buffer.concat(chunks, size);
      if (/^\s*</.test(bytes.subarray(0, 128).toString("utf8"))) return fail("html_response");
      const format = audioFormat(bytes);
      if (!format || (mime !== "application/octet-stream" && !MIME_TYPES[format].includes(mime))) return fail("invalid_audio");
      let decoded: DecodedAudio;
      try { decoded = await options.decode(bytes, format, controller.signal); }
      catch { return fail("decode_failed"); }
      if (controller.signal.aborted) return fail("timeout");
      if (!decoded || !Number.isFinite(decoded.durationSeconds) || decoded.durationSeconds <= 0 ||
          !Number.isSafeInteger(decoded.channels) || decoded.channels < 1 || decoded.channels > 32 ||
          !Number.isSafeInteger(decoded.sampleRate) || decoded.sampleRate < 1) return fail("decode_failed");
      return { ok: true, verification: "decoded", bytes, format, mimeType: mime,
        sha256: createHash("sha256").update(bytes).digest("hex"), decoded };
    } catch { return fail(controller.signal.aborted ? "timeout" : "transport_error"); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not turn a bounded operation into an unbounded wait.
    void reader?.cancel().catch(() => undefined);
  }
}
