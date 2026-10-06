import { authorizeDialpadAudio } from "@/lib/recordings/dialpad-audio-playback";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createClient } from "@/lib/supabase/server";

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
    .select("id,org_id,provider,recording_status,transcript_status,summary_status,call_recordings(status,duration_seconds),call_transcripts(status,summary_status,summary,text)")
    .eq("id", callActivityId).maybeSingle();
  if (error) return json({ error: "Unable to load call details" }, 500);
  if (!data) return json({ error: "Call not found" }, 404);
  // A Dialpad call has Sandra-stored audio only through the SQL authorization; anyone it denies sees no recording.
  // Before the migration lands the Dialpad branch is skipped and the pre-migration answer is returned.
  let dialpadAudio: Awaited<ReturnType<typeof authorizeDialpadAudio>> = null;
  const dialpadAudioLive = data.provider === "dialpad" && (await schemaReady("dialpad_call_audio"));
  if (dialpadAudioLive) {
    try {
      dialpadAudio = await authorizeDialpadAudio({ actorId: user.id, orgId: data.org_id, callActivityId: data.id });
    } catch {
      return json({ error: "Unable to load call details" }, 500);
    }
  }
  const recordings = data.call_recordings ?? [];
  const transcripts = data.call_transcripts ?? [];
  const recording = recordings.find(r => r.status === "available") ?? recordings[0];
  const transcript = transcripts.find(t => t.status === "available") ?? transcripts[0];
  return json({
    recordingStatus: dialpadAudioLive ? (dialpadAudio ? "available" : "none") : status(recording?.status ?? data.recording_status),
    durationSeconds: dialpadAudioLive ? (dialpadAudio?.durationMs ? Math.round(dialpadAudio.durationMs / 1000) : null) : recording?.duration_seconds ?? null,
    transcriptStatus: status(transcript?.status ?? data.transcript_status),
    transcript: transcript?.status === "available" ? transcript.text : null,
    summaryStatus: status(transcript?.summary_status ?? data.summary_status),
    summary: transcript?.summary_status === "available" ? transcript.summary : null,
  });
}
