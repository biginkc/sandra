import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFfmpegRecordingDecoder } from "./ffmpeg-decoder";

const executable = process.env.FFMPEG_PATH ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
function wav() {
  const b = Buffer.alloc(1644);
  b.write("RIFF"); b.writeUInt32LE(1636, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(1600, 40);
  for (let i = 0; i < 800; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), 44 + 2 * i);
  return b;
}
const signal = () => new AbortController().signal;
describe("ffmpeg full audio decoder", () => {
  it("decodes real synthetic WAV into normalized PCM duration", async () => {
    expect(await createFfmpegRecordingDecoder({ executable })(wav(), "wav", signal())).toEqual({ durationSeconds: 0.1, channels: 1, sampleRate: 16000 });
  });
  it("rejects truncated media via actual decoder", async () => {
    await expect(createFfmpegRecordingDecoder({ executable })(wav().subarray(0, 101), "wav", signal())).rejects.toThrow("Audio decode failed");
  });
  it("rejects decoder nonzero exit for invalid media", async () => {
    await expect(createFfmpegRecordingDecoder({ executable })(Buffer.from("invalid audio"), "wav", signal())).rejects.toThrow("Audio decode failed");
  });
  it("bounds decoded output duration", async () => {
    await expect(createFfmpegRecordingDecoder({ executable, maxDurationSeconds: 0.01 })(wav(), "wav", signal())).rejects.toThrow("Audio decode failed");
  });
  it("kills decoding on immediate abort", async () => {
    const controller = new AbortController();
    const pending = createFfmpegRecordingDecoder({ executable })(wav(), "wav", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Audio decode failed");
  });
  it("rejects pre-aborted work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createFfmpegRecordingDecoder({ executable })(wav(), "wav", controller.signal)).rejects.toThrow("Audio decode unavailable");
  });
  it("sanitizes missing executable errors", async () => {
    await expect(createFfmpegRecordingDecoder({ executable: "/missing/private-secret" })(wav(), "wav", signal())).rejects.toThrow(/^Audio decode failed$/);
  });
});
