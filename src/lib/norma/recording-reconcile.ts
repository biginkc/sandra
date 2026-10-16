import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type RecordingState = "pending" | "reported_available" | "not_recorded" | "unavailable" | "failed";
type Claim = Database["public"]["Functions"]["fn_norma_claim_recordings"]["Returns"][number];

/** Provider evidence is advisory availability, never a persistent playback URL. */
export function recordingEvidence(body: unknown, call: Claim): RecordingState | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (value.call_id !== call.provider_call_id || value.inbound !== false || value.to !== call.phone_e164) return null;
  if (value.metadata && typeof value.metadata === "object") {
    const requestId = (value.metadata as Record<string, unknown>).request_id;
    if (requestId !== undefined && requestId !== call.request_id) return null;
  }
  if (typeof value.recording_url === "string" && value.recording_url.trim()) return "reported_available";
  if (value.completed === true && value.record === false) return "not_recorded";
  return "pending";
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0; let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function reconcileRecordings(client: SupabaseClient<Database>, key: string, fetcher: typeof fetch = fetch) {
  const { data: claims, error } = await client.rpc("fn_norma_claim_recordings", {});
  if (error) throw new Error("Recording claim failed");
  const result = { checked: 0, available: 0, denied: 0, unavailable: 0, failed: 0 };
  const leaseId = claims?.[0]?.lease_id;
  if (!leaseId) return result;
  let denied = false;
  try {
    for (const call of claims ?? []) {
      const started = await client.rpc("fn_norma_start_recording_lookup", { p_lease_id: leaseId });
      if (started.error) throw new Error("Recording lookup admission failed");
      if (!started.data) break;
      result.checked++;
      let state: RecordingState = call.lookup_attempts >= 6 ? "failed" : "pending";
      try {
        const response = await fetcher(`https://api.bland.ai/v1/calls/${encodeURIComponent(call.provider_call_id)}`, {
          method: "GET", headers: { authorization: `Bearer ${key}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 401 || response.status === 403) {
          denied = true; result.denied++; await response.body?.cancel(); break;
        }
        if (response.ok) {
          const evidence = recordingEvidence(await boundedJson(response), call);
          if (evidence) state = evidence === "pending" && call.lookup_attempts >= 6 ? "unavailable" : evidence;
        } else {
          if (response.status === 404 && call.lookup_attempts >= 6) state = "unavailable";
          await response.body?.cancel();
        }
      } catch { /* Network/JSON errors use the same persisted, bounded retry budget. */ }
      if (denied) break; // Even response cancellation failure must preserve the refusal.
      const saved = await client.rpc("fn_norma_checkpoint_recording", {
        p_request_id: call.request_id, p_attempt: call.attempt, p_call_id: call.provider_call_id,
        p_lookup_attempts: call.lookup_attempts, p_lease_id: leaseId, p_state: state,
      });
      if (saved.error) throw new Error("Recording checkpoint failed");
      if (!saved.data) break; // Lease expired or another result won; stop further provider work.
      if (state === "reported_available") result.available++;
      if (state === "unavailable") result.unavailable++;
      if (state === "failed") result.failed++;
    }
  } finally {
    const finished = await client.rpc("fn_norma_finish_recording_lookup", { p_lease_id: leaseId, p_denied: denied });
    if (finished.error) throw new Error("Recording lookup release failed");
  }
  return result;
}
