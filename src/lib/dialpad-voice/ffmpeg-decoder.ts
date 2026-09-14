import "server-only";
import { spawn } from "node:child_process";
import type { RecordingDecoder } from "./recording-download";

/** Fully decodes input into normalized mono 16kHz signed PCM. Duration measures
 * decoded output, not source headers. PCM is counted and discarded, never kept.
 * Deployments must provision ffmpeg; absence/failure is not verification success. */
export function createFfmpegRecordingDecoder(options: {
  executable?: string;
  maxDurationSeconds?: number;
  timeoutMs?: number;
} = {}): RecordingDecoder {
  const executable = options.executable ?? "ffmpeg";
  const maxDurationSeconds = options.maxDurationSeconds ?? 4 * 60 * 60;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (bytes, _format, signal) => {
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 86400 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || signal.aborted) {
      throw new Error("Audio decode unavailable");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [
        "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
        "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:a:0",
        "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
      ], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let decodedBytes = 0;
      let settled = false;
      const finish = (valid: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (!valid) {
          child.kill("SIGKILL");
          reject(new Error("Audio decode failed"));
        } else resolve({ durationSeconds: decodedBytes / 32000, channels: 1, sampleRate: 16000 });
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", abort);
      child.stdin.on("error", abort);
      child.stdout.on("error", abort);
      child.stderr.on("error", abort);
      // Drain diagnostic output without exposing filenames, content or messages.
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        decodedBytes += chunk.length;
        if (decodedBytes > maxDurationSeconds * 32000) finish(false);
      });
      child.on("close", (code) => finish(code === 0 && decodedBytes > 0 && decodedBytes % 2 === 0 && !signal.aborted));
      if (signal.aborted) abort();
      else child.stdin.end(bytes);
    });
  };
}
