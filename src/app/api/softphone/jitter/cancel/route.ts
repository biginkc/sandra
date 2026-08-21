import { cancelAuthenticatedJitterCall } from "@/lib/dialer/jitter-server";

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return Response.json({ error: "Request body is too large.", error_code: "invalid_request" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON.", error_code: "invalid_request" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "A JSON object is required.", error_code: "invalid_request" }, { status: 400 });
  }
  const candidate = payload as { sessionRef?: unknown; reason?: unknown };
  if (typeof candidate.sessionRef !== "string" || typeof candidate.reason !== "string") {
    return Response.json({ error: "sessionRef and reason are required.", error_code: "invalid_request" }, { status: 400 });
  }
  const result = await cancelAuthenticatedJitterCall(
    candidate.sessionRef,
    candidate.reason,
  );
  if (!result.ok) {
    return Response.json(
      { error: result.error, error_code: result.errorCode, ...(result.reason ? { reason: result.reason } : {}) },
      { status: result.status },
    );
  }
  return Response.json(result.data);
}
