import { loadNormaRecordings, recordingJson } from "@/lib/norma/recordings";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const client = await createClient();
  const result = await loadNormaRecordings(client, requestId);
  if (result.status !== 200) return recordingJson({ error: result.error }, result.status);
  const states = await client.from("norma_attempt_recordings").select("attempt,provider_call_id,state").eq("request_id", requestId);
  // Availability is advisory: a ledger outage must not hide authorized playback.
  if (states.error) console.warn("[norma_recordings] Availability lookup failed", { requestId });
  return recordingJson({ recordings: result.recordings.map(({ attempt, callId }) => ({
    attempt,
    state: (states.error ? undefined : states.data?.find((row) => row.attempt === attempt && row.provider_call_id === callId)?.state) ?? "unchecked",
  })) });
}
