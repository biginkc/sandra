import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadInsightsDatabase } from "@/lib/dialpad-voice/insights-database.generated";
import { loadOwnedDialpadSegments, publicRecordingSegments } from "@/lib/dialpad-voice/recording-playback";
import { resolveDialpadRecordingStatus } from "@/lib/dialpad-voice/recording-status";
import { resolveDialpadInsightStatus } from "@/lib/dialpad-voice/insights-status";
import { createClient } from "@/lib/supabase/server";

// Additive RPC contract; shared generated schemas are owned by another change.
type ArtifactReadDatabase = Omit<DialpadInsightsDatabase, "public"> & {
  public: Omit<DialpadInsightsDatabase["public"], "Functions"> & {
    Functions: DialpadInsightsDatabase["public"]["Functions"] & {
      fn_dialpad_recording_complete: { Args: { p_org_id: string; p_call_id: string }; Returns: boolean };
    };
  };
};

const headers = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const status = (value: string | null) => ["available", "pending", "failed", "none"].includes(value ?? "") ? value : "unknown";

/** Read using the signed-in user's RLS scope; never return storage paths or provider errors. */
export async function GET(_request: Request, { params }: { params: Promise<{ callActivityId: string }> }) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);
  const { callActivityId } = await params;
  const { data, error } = await client.from("call_activities")
    .select("id,org_id,provider,provider_call_id,recording_status,transcript_status,summary_status,call_recordings(status,duration_seconds),call_transcripts(status,summary_status,summary,text)")
    .eq("id", callActivityId).maybeSingle();
  if (error) return json({ error: "Unable to load call details" }, 500);
  if (!data) return json({ error: "Call not found" }, 404);
  const recordings = data.call_recordings ?? [];
  const transcripts = data.call_transcripts ?? [];
  const recording = recordings.find(r => r.status === "available") ?? recordings[0];
  const transcript = transcripts.find(t => t.status === "available") ?? transcripts[0];
  if (data.provider === "dialpad") {
    if (!data.org_id || !data.provider_call_id) return json({ error: "Call identity unavailable" }, 409);
    try {
      const { segments, admin } = await loadOwnedDialpadSegments(data.org_id, data.provider_call_id);
      const insightClient = admin as unknown as SupabaseClient<ArtifactReadDatabase>;
      const insight = await insightClient.from("dialpad_call_insights").select("transcript_status,transcript_text,summary_status,summary_text")
        .eq("org_id", data.org_id).eq("provider_call_id", data.provider_call_id).eq("call_activity_id", data.id).maybeSingle();
      if (insight.error) return json({ error: "Unable to load call insights" }, 503);
      const completeness = await insightClient.rpc("fn_dialpad_recording_complete", {
        p_org_id: data.org_id, p_call_id: data.provider_call_id,
      });
      if (completeness.error || typeof completeness.data !== "boolean") return json({ error: "Unable to verify recording completeness" }, 503);
      const recordingComplete = completeness.data && segments.length > 0;
      const stored = insight.data;
      const [recordingStatus, transcriptStatus, summaryStatus] = await Promise.all([
        resolveDialpadRecordingStatus(insightClient, data.org_id, data.provider_call_id, recordingComplete),
        resolveDialpadInsightStatus(insightClient, data.org_id, data.provider_call_id, "call_transcription", stored?.transcript_status),
        resolveDialpadInsightStatus(insightClient, data.org_id, data.provider_call_id, "recap_summary", stored?.summary_status),
      ]);
      return json({ recordingStatus, recordingComplete, durationSeconds: recordingComplete && segments.length === 1 ? segments[0].decoded_duration_seconds : null,
        recordingSegments: publicRecordingSegments(segments), transcriptStatus,
        transcript: stored?.transcript_status === "available" ? stored.transcript_text : null,
        summaryStatus, summary: stored?.summary_status === "available" ? stored.summary_text : null });
    } catch { return json({ error: "Unable to load retained recordings" }, 503); }
  }
  return json({
    recordingStatus: status(recording?.status ?? data.recording_status),
    durationSeconds: recording?.duration_seconds ?? null,
    transcriptStatus: status(transcript?.status ?? data.transcript_status),
    transcript: transcript?.status === "available" ? transcript.text : null,
    summaryStatus: status(transcript?.summary_status ?? data.summary_status),
    summary: transcript?.summary_status === "available" ? transcript.summary : null,
  });
}
