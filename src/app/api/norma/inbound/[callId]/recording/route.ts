import { createClient } from "@/lib/supabase/server";
import { recordingJson } from "@/lib/norma/recordings";
import { streamBlandRecording } from "@/lib/norma/recording-stream";
export const maxDuration = 300;
export async function GET(request: Request, { params }: { params: Promise<{ callId: string }> }) {
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return recordingJson({ error: "Not signed in" }, 401);
  const { callId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) return recordingJson({ error: "Invalid call" }, 400);
  const { data, error } = await client.from("norma_inbound_calls").select("provider_call_id").eq("id",callId).maybeSingle();
  if (error) return recordingJson({ error: "Unable to load recording" },500);
  if (!data) return recordingJson({ error: "Call not found" },404);
  return streamBlandRecording(request,data.provider_call_id);
}
