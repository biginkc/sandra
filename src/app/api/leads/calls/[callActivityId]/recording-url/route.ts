import { createClient } from "@/lib/supabase/server";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

type RecordingLookup = {
  id: string;
  provider: string;
  jitter_attempt_id: string;
  jitter_session_id: string | null;
  call_recordings: Array<{ status: string }> | { status: string } | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
}

function recordingStatuses(value: RecordingLookup["call_recordings"]): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((recording) => recording.status);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ callActivityId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return json({ error: "Not signed in", error_code: "unauthorized" }, 401);
  }

  const { callActivityId } = await params;
  if (!callActivityId.trim()) {
    return json({ error: "Call activity is required", error_code: "invalid_call_activity" }, 400);
  }

  const { data, error } = await supabase
    .from("call_activities")
    .select("id, provider, jitter_attempt_id, jitter_session_id, call_recordings(status)")
    .eq("id", callActivityId)
    .maybeSingle();

  if (error) {
    return json({ error: "Could not load recording", error_code: "lookup_failed" }, 500);
  }
  if (!data) {
    return json({ error: "Call recording not found", error_code: "not_found" }, 404);
  }

  const call = data as unknown as RecordingLookup;
  if (call.provider !== "jitter") {
    return json(
      { error: "Recording playback is unavailable for this provider", error_code: "unsupported_provider" },
      409,
    );
  }

  const statuses = recordingStatuses(call.call_recordings);
  if (!statuses.includes("available")) {
    const failed = statuses.includes("failed");
    return json(
      {
        error: failed ? "Recording failed" : "Recording is not available yet",
        error_code: failed ? "recording_failed" : "recording_not_available",
      },
      409,
    );
  }

  const attemptId = call.jitter_attempt_id.trim();
  const scopeId = call.jitter_session_id?.trim() ?? "";
  if (!attemptId || !scopeId) {
    return json(
      { error: "Call recording identity is incomplete", error_code: "missing_jitter_identity" },
      409,
    );
  }

  const baseUrl = process.env.JITTER_API_BASE_URL?.trim();
  const playbackToken = process.env.JITTER_SANDRA_PLAYBACK_TOKEN?.trim();
  if (!baseUrl || !playbackToken) {
    return json(
      { error: "Recording playback is not configured", error_code: "playback_not_configured" },
      503,
    );
  }

  let playbackUrl: URL;
  try {
    playbackUrl = new URL(
      `/api/internal/sandra/recordings/${encodeURIComponent(attemptId)}`,
      baseUrl,
    );
    if (playbackUrl.protocol !== "https:") {
      throw new Error("Unsupported Jitter URL protocol");
    }
  } catch {
    return json(
      { error: "Recording playback is not configured", error_code: "playback_not_configured" },
      503,
    );
  }
  playbackUrl.searchParams.set("scopeId", scopeId);

  let upstream: Response;
  try {
    upstream = await fetch(playbackUrl, {
      cache: "no-store",
      headers: { authorization: `Bearer ${playbackToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return json(
        { error: "Recording service timed out", error_code: "jitter_timeout" },
        504,
      );
    }
    return json(
      { error: "Recording service is unavailable", error_code: "jitter_unavailable" },
      502,
    );
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json(
      { error: "Recording service returned an invalid response", error_code: "invalid_jitter_response" },
      502,
    );
  }
  return json(body, upstream.status);
}
