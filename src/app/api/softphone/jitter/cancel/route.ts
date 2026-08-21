import { cancelAuthenticatedJitterCall } from "@/lib/dialer/jitter-server";

const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return Response.json({ error: "Request body is too large.", error_code: "invalid_request" }, { status: 413 });
  }
  let rawBody: string | null;
  try {
    rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
  } catch {
    return Response.json({ error: "Invalid JSON.", error_code: "invalid_request" }, { status: 400 });
  }
  if (rawBody === null) {
    return Response.json({ error: "Request body is too large.", error_code: "invalid_request" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON.", error_code: "invalid_request" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "A JSON object is required.", error_code: "invalid_request" }, { status: 400 });
  }
  const candidate = payload as { callId?: unknown; reason?: unknown };
  if (typeof candidate.callId !== "string" || !isCancelReason(candidate.reason)) {
    return Response.json({ error: "callId and a valid reason are required.", error_code: "invalid_request" }, { status: 400 });
  }
  const result = await cancelAuthenticatedJitterCall(candidate.callId, candidate.reason);
  if (!result.ok) {
    return Response.json(
      { error: result.error, error_code: result.errorCode },
      { status: result.status },
    );
  }
  return Response.json(result.data);
}

function isCancelReason(value: unknown): value is "hangup" | "failed" | "abandoned" {
  return value === "hangup" || value === "failed" || value === "abandoned";
}

async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}
