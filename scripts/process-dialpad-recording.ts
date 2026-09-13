import { createDialpadVoiceAdminClient } from "../src/lib/dialpad-voice/database";
import { createFfmpegRecordingDecoder } from "../src/lib/dialpad-voice/ffmpeg-decoder";
import { processDialpadRecording } from "../src/lib/dialpad-voice/recording-worker";

async function main() {
  const orgId = process.env.DIALPAD_VOICE_ORG_ID ?? "";
  const providerUserId = process.env.DIALPAD_VOICE_USER_ID ?? "";
  const apiKey = process.env.DIALPAD_VOICE_API_KEY ?? "";
  const bucket = process.env.DIALPAD_VOICE_RECORDING_BUCKET ?? "";
  if (process.env.DIALPAD_VOICE_RECORDING_WORKER_ENABLED !== "true" || !apiKey || !bucket ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId) || !/^[1-9]\d*$/.test(providerUserId)) {
    throw new Error("Recording worker disabled or unconfigured");
  }
  const result = await processDialpadRecording({
    client: createDialpadVoiceAdminClient(), orgId, providerUserId, apiKey, bucket,
    decode: createFfmpegRecordingDecoder({ executable: process.env.DIALPAD_FFMPEG_PATH || "ffmpeg" }),
  });
  console.log(JSON.stringify({ result }));
}
main().catch(() => {
  console.error("Dialpad recording worker did not complete; inspect configuration and durable queue status.");
  process.exitCode = 1;
});
