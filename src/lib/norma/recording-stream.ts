import { reportError } from "@/lib/errors/report";
import { RECORDING_HEADERS, recordingJson } from "./recordings";
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** Caller must authorize the stored call identity before invoking this fixed-host proxy. */
export async function streamBlandRecording(request: Request, callId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(callId)) return recordingJson({ error: "Invalid recording identity" }, 400);
  const key = process.env.BLAND_API_KEY?.trim();
  if (!key) return recordingJson({ error: "Recording playback is not configured" }, 503);
  const range = request.headers.get("range");
  if (range && !/^bytes=(?:\d{1,18}-\d{0,18}|-\d{1,18})$/.test(range)) {
    return recordingJson({ error: "Invalid audio range" }, 416);
  }
  let upstream: Response;
  const headerTimeout = new AbortController();
  const timeout = setTimeout(() => headerTimeout.abort(), 15_000);
  try {
    upstream = await fetch(`https://api.bland.ai/v1/recordings/${encodeURIComponent(callId)}`, {
      // Bland uses Content-Type on this GET to choose the returned audio format.
      headers: { authorization: `Bearer ${key}`, "content-type": "audio/mpeg", "accept-encoding": "identity", ...(range ? { range } : {}) },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, headerTimeout.signal]),
    });
  } catch {
    return recordingJson({ error: "Recording service is unavailable. Try again." }, 502);
  } finally {
    clearTimeout(timeout);
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    const response = recordingJson({ error: "Audio range is not available" }, 416);
    const contentRange = upstream.headers.get("content-range");
    if (contentRange && /^bytes \*\/\d{1,18}$/.test(contentRange)) response.headers.set("content-range", contentRange);
    return response;
  }
  // fetch may decompress the body while retaining encoded length/range headers.
  const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    await upstream.body?.cancel();
    return recordingJson({ error: "Recording service returned an unsupported encoding" }, 502);
  }
  if (upstream.status === 429) {
    reportError(new Error("Bland recording playback rate limited"), { tags: { surface: "norma_recording", httpStatus: 429 } });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    return recordingJson({ error: upstream.status === 404 ? "Recording is not available yet. Try again later." : "Recording service is unavailable. Try again." }, upstream.status === 404 ? 404 : 502);
  }
  const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"].includes(contentType)) {
    await upstream.body.cancel();
    return recordingJson({ error: "Recording service returned an invalid audio response" }, 502);
  }
  const length = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) {
    await upstream.body.cancel();
    return recordingJson({ error: "Recording exceeds the playback size limit" }, 502);
  }
  let bytes = 0;
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_AUDIO_BYTES) controller.error(new Error("Recording exceeds the playback size limit"));
      else controller.enqueue(chunk);
    },
  }));
  const headers = new Headers({ ...RECORDING_HEADERS, "content-type": contentType });
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: upstream.status === 206 ? 206 : 200, headers });
}
