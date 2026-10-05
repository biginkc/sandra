import { loadNormaRecordings, recordingJson } from "@/lib/norma/recordings";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const result = await loadNormaRecordings(await createClient(), requestId);
  if (result.status !== 200) return recordingJson({ error: result.error }, result.status);
  return recordingJson({ recordings: result.recordings.map(({ attempt }) => ({ attempt })) });
}
