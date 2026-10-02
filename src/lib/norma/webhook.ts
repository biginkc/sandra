import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { withConvertedCallbackTime } from "./callback-wiring";
import type { DispatchResult } from "./dispatch";
import { dispatchScheduledRetry } from "./retry";
import type { CallbackTimeProvider } from "./callback-time";
import { mapBlandCallToOutcome } from "./outcome";
import { completeNormaCall } from "./rpc";
import { toUsVoiceE164 } from "./voice-phone";

/** Bland post-call payloads carry transcripts; bound generously but firmly. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_IDENTITY = 128;

/**
 * X-Webhook-Signature: hex HMAC-SHA256 of the raw request body with the
 * webhook signing secret. Constant-time compare; any malformed input is false.
 * A leading "sha256=" is tolerated (harmless; the digest still has to match).
 */
export function verifyBlandSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const provided = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

/** Read at most MAX bytes. Returns null when over the bound. */
export async function readBoundedBody(request: Request, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export type WebhookResponse = { status: number; body: Record<string, unknown> };

const respond = (status: number, body: Record<string, unknown>): WebhookResponse => ({ status, body });

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= MAX_IDENTITY ? value.trim() : null;
}

/**
 * Webhook core. Order matters: size bound -> signature over the RAW body ->
 * only then parse. Every CRM effect goes through fn_norma_complete_call, which
 * is replay-safe and serialises against the reconciliation sweep.
 *
 * Status codes: 401 bad/missing signature, 413 too large, 400 unparseable
 * (signed but malformed), 200 for anything valid-but-not-actionable (so Bland
 * does not retry forever), 500 only for infrastructure failure (Bland retries).
 */
export async function handleBlandCallWebhook(
  request: Request,
  deps: {
    client: SupabaseClient<Database>;
    secret: string | undefined;
    callbackTimeProvider?: CallbackTimeProvider | null;
    /** Runs the call-twice retry (the ordinary dispatchNormaCall). Without it the sweep dispatches the retry. */
    dispatch?: (requestId: string) => Promise<DispatchResult>;
  },
): Promise<WebhookResponse> {
  if (!deps.secret) return respond(500, { error: "not_configured" });

  const raw = await readBoundedBody(request);
  if (raw === null) return respond(413, { error: "too_large" });
  if (!verifyBlandSignature(deps.secret, raw, request.headers.get("x-webhook-signature"))) {
    return respond(401, { error: "unauthorized" });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    payload = parsed as Record<string, unknown>;
  } catch {
    return respond(400, { error: "bad_request" });
  }

  const metadata = payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {};
  const requestId = str(metadata.request_id);
  const idempotencyKey = str(metadata.idempotency_key);
  const callId = str(payload.call_id);
  // Not a Norma call (or a test event): acknowledge, do nothing.
  if (!requestId || !idempotencyKey) return respond(200, { status: "ignored", reason: "no_correlation" });
  if (!callId) return respond(200, { status: "ignored", reason: "no_call_id" });

  try {
    const { data: row, error } = await deps.client
      .from("norma_call_requests")
      .select("id, status, property_id, phone_e164, idempotency_key")
      .eq("id", requestId)
      .maybeSingle();
    if (error) throw new Error(`norma webhook lookup failed: ${error.message}`);
    if (!row || row.idempotency_key.toLowerCase() !== idempotencyKey.toLowerCase()) {
      reportError(new Error("norma webhook correlation mismatch"), { tags: { surface: "norma_webhook" }, extra: { requestId } });
      return respond(200, { status: "ignored", reason: "correlation_mismatch" });
    }
    // The dialled number must be the one we asked for.
    if (toUsVoiceE164(typeof payload.to === "string" ? payload.to : null) !== row.phone_e164) {
      reportError(new Error("norma webhook dialled-number mismatch"), { tags: { surface: "norma_webhook" }, extra: { requestId } });
      return respond(200, { status: "ignored", reason: "number_mismatch" });
    }

    // The seller's callback words become a time here, before the one CRM write.
    // Never fails or delays the completion: any problem leaves the raw words.
    // A replay of an already-completed request skips the conversion (and so
    // the AI step) entirely: the completion RPC will just report `replayed`.
    const baseMapping = mapBlandCallToOutcome(payload);
    const mapping =
      row.status === "completed"
        ? baseMapping
        : await withConvertedCallbackTime(baseMapping, {
            client: deps.client,
            propertyId: row.property_id,
            call: payload,
            provider: deps.callbackTimeProvider,
          });
    const result = await completeNormaCall(deps.client, {
      requestId: row.id,
      callId,
      outcome: mapping.outcome,
      payload: mapping.payload,
    });
    if (result.result === "applied" || result.result === "replayed") {
      // Attempt 1 was confirmed not answered: place the one retry now.
      const retry = await dispatchScheduledRetry(result, row.id, deps.dispatch);
      return respond(200, { status: result.result, ...(retry ? { retry: retry.status } : {}) });
    }
    reportError(new Error(`norma webhook completion ${result.result}`), {
      tags: { surface: "norma_webhook" },
      extra: { requestId, result: result.result },
    });
    return respond(200, { status: "ignored", reason: result.result });
  } catch (error) {
    reportError(error, { tags: { surface: "norma_webhook" }, extra: { requestId } });
    return respond(500, { error: "internal_error" });
  }
}
