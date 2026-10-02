import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DIRECT_RECORDINGS_BUCKET } from "@/lib/direct-calling/recording";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

type RecordingLookup = {
  id: string;
  org_id?: string;
  provider: string;
  jitter_attempt_id: string;
  jitter_session_id: string | null;
  operator_user_id?: string | null;
  direct_call_id?: string | null;
  call_recordings: Array<{ status: string; storage_bucket?: string | null; storage_path?: string | null }> | { status: string; storage_bucket?: string | null; storage_path?: string | null } | null;
};

type DirectCallLookup = {
  id: string;
  org_id: string;
  operator_user_id: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
}

function recordingStatuses(value: RecordingLookup["call_recordings"]): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((recording) => recording.status);
}

function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function timeoutResponse(): Response {
  return json(
    { error: "Recording service timed out", error_code: "jitter_timeout" },
    504,
  );
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
    .select("id, org_id, provider, jitter_attempt_id, jitter_session_id, operator_user_id, direct_call_id, call_recordings(status,storage_bucket,storage_path)")
    .eq("id", callActivityId)
    .maybeSingle();

  if (error) {
    return json({ error: "Could not load recording", error_code: "lookup_failed" }, 500);
  }
  if (!data) {
    return json({ error: "Call recording not found", error_code: "not_found" }, 404);
  }

  const call = data as unknown as RecordingLookup;
  // Existing Jitter playback is authorized by its established broker/RLS
  // boundary, which includes manager/coach access. Direct recordings are
  // private to the authenticated operator who owns the direct call. The
  // activity operator is mutable CRM metadata, so never use it as the
  // ownership authority for a direct recording.
  let directCall: DirectCallLookup | null = null;
  if (call.direct_call_id) {
    const { data: directCallData, error: directCallError } = await supabase
      .from("direct_calls")
      .select("id, org_id, operator_user_id")
      .eq("id", call.direct_call_id)
      .maybeSingle();
    if (directCallError) {
      return json({ error: "Could not load recording", error_code: "lookup_failed" }, 500);
    }
    directCall = directCallData as DirectCallLookup | null;
    if (
      !directCall ||
      directCall.id !== call.direct_call_id ||
      (call.org_id && directCall.org_id !== call.org_id) ||
      directCall.operator_user_id !== user.id
    ) {
      return json({ error: "Call recording not found", error_code: "not_found" }, 404);
    }
  }
  // Batch calls and embedded-softphone calls both store their audio in
  // Jitter; playback resolves through the same internal endpoint.
  if (!call.direct_call_id && call.provider !== "jitter" && call.provider !== "sandra_softphone") {
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

  if (call.direct_call_id && directCall) {
    const recording = (Array.isArray(call.call_recordings) ? call.call_recordings : call.call_recordings ? [call.call_recordings] : [])
      .find((item) => item.status === "available");
    if (!recording?.storage_path || recording.storage_bucket !== DIRECT_RECORDINGS_BUCKET) {
      return json({ error: "Direct recording identity is incomplete", error_code: "missing_direct_recording" }, 409);
    }
    const pathParts = recording.storage_path.split("/");
    if (pathParts.length < 3 || pathParts[1] !== directCall.id || pathParts[0] !== directCall.org_id || recording.storage_path.includes("..") || recording.storage_path.startsWith("/")) {
      return json({ error: "Direct recording identity is invalid", error_code: "invalid_direct_recording" }, 409);
    }
    const { data: signed, error: signError } = await createAdminClient().storage
      .from(DIRECT_RECORDINGS_BUCKET)
      .createSignedUrl(recording.storage_path, 60);
    if (signError || !signed?.signedUrl) {
      return json({ error: "Recording playback is unavailable", error_code: "playback_unavailable" }, 502);
    }
    return json({ signedUrl: signed.signedUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() });
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
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (isDeadlineError(error)) return timeoutResponse();
    return json(
      { error: "Recording service is unavailable", error_code: "jitter_unavailable" },
      502,
    );
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch (error) {
    if (isDeadlineError(error)) return timeoutResponse();
    return json(
      { error: "Recording service returned an invalid response", error_code: "invalid_jitter_response" },
      502,
    );
  }
  return json(body, upstream.status);
}
