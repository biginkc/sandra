import { readBoundedBody, verifyBlandSignature, type WebhookResponse } from "./webhook";

export type InboundCall = {
  callId: string; from: string; to: string; completed: boolean;
  recordingState: "pending" | "reported_available" | "not_recorded";
};
const phone = /^\+[1-9][0-9]{7,14}$/;
/** Treat provider direction as mandatory; never guess from missing outbound correlation. */
export function parseInboundCall(value: unknown): InboundCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.inbound !== true || row.is_proxy_agent_call === true) return null;
  if (typeof row.call_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.call_id)) return null;
  if (typeof row.from !== "string" || !phone.test(row.from) || typeof row.to !== "string" || !phone.test(row.to)) return null;
  if (typeof row.completed !== "boolean") return null;
  // Keep only evidence of availability. Never persist or fetch the provider-supplied URL.
  const reported = typeof row.recording_url === "string" && row.recording_url.trim().length > 0;
  return { callId: row.call_id, from: row.from, to: row.to, completed: row.completed,
    recordingState: reported ? "reported_available" : row.record === false ? "not_recorded" : "pending" };
}

export async function handleInboundCall(request: Request, deps: {
  secret: string | undefined; ingest: (call: InboundCall) => Promise<string | null>;
}): Promise<WebhookResponse> {
  if (!deps.secret) return { status: 503, body: { error: "not_configured" } };
  const raw = await readBoundedBody(request);
  if (raw === null) return { status: 413, body: { error: "too_large" } };
  if (!verifyBlandSignature(deps.secret, raw, request.headers.get("x-webhook-signature"))) return { status: 401, body: { error: "unauthorized" } };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad_request" } }; }
  const call = parseInboundCall(parsed);
  if (!call) return { status: 400, body: { error: "invalid_inbound_call" } };
  try {
    const id = await deps.ingest(call);
    // Retry a signed event until destination setup is repaired rather than silently dropping it.
    if (!id) return { status: 503, body: { error: "destination_not_configured" } };
    return { status: 200, body: { status: "accepted" } };
  } catch {
    return { status: 500, body: { error: "ingestion_failed" } };
  }
}
