import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type NormaRecording = { attempt: 1 | 2; callId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Use stored call identities only. Never accept a provider URL or call ID from the browser. */
export function normaRecordings(row: Record<string, unknown>): NormaRecording[] {
  const result: NormaRecording[] = [];
  const add = (attempt: 1 | 2, id: unknown) => {
    if (typeof id === "string" && CALL_ID.test(id)) result.push({ attempt, callId: id });
  };
  if (row.attempt === 2) {
    add(1, row.first_bland_call_id);
    add(2, row.bland_call_id);
  } else if (row.attempt === undefined || row.attempt === 1) {
    add(1, row.bland_call_id);
  }
  return result;
}

export async function loadNormaRecordings(client: SupabaseClient<Database>, requestId: string) {
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return { status: 401 as const, error: "Not signed in" };
  if (!UUID.test(requestId)) return { status: 400 as const, error: "Invalid call request" };
  // This is the session client, not service-role. Existing Norma RLS requires
  // active organization access. Select * supports both pre-retry and retry schemas;
  // only validated call identities leave this server-side helper.
  const { data, error } = await client.from("norma_call_requests").select("*").eq("id", requestId).maybeSingle();
  if (error) return { status: 500 as const, error: "Could not load call recordings" };
  if (!data) return { status: 404 as const, error: "Call request not found" };
  return { status: 200 as const, recordings: normaRecordings(data as unknown as Record<string, unknown>) };
}

export const RECORDING_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
export function recordingJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: RECORDING_HEADERS });
}
