import { loadNormaRecordings, recordingJson } from "@/lib/norma/recordings";
import { createClient } from "@/lib/supabase/server";

import { streamBlandRecording } from "@/lib/norma/recording-stream";

export const maxDuration = 300;


export async function GET(request: Request, { params }: { params: Promise<{ requestId: string; attempt: string }> }) {
  const { requestId, attempt } = await params;
  if (attempt !== "1" && attempt !== "2") return recordingJson({ error: "Invalid call attempt" }, 400);
  const result = await loadNormaRecordings(await createClient(), requestId);
  if (result.status !== 200) return recordingJson({ error: result.error }, result.status);
  const recording = result.recordings.find((item) => item.attempt === Number(attempt));
  if (!recording) return recordingJson({ error: "Recording is not available for this attempt" }, 404);
  return streamBlandRecording(request, recording.callId);
}
