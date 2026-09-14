import "server-only";
import { createHash } from "node:crypto";
import { verifyDialpadVoiceEvent } from "./webhook-auth";

export interface DialpadVoiceReceipt {
  envelopeHash: string;
  providerCallId: string;
  payload: Record<string, unknown>;
}

function providerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

/** No success response until durable persistence completes. persist must enforce
 * receipt uniqueness; its configured org must never come from provider payload.
 * Unidentified targets are retained for reconciliation, not assigned to a lead.
 */
export function createDialpadVoiceReceiver(options: {
  secret: string;
  providerUserId?: string;
  persist: (receipt: DialpadVoiceReceipt) => Promise<void>;
}) {
  return async function receive(request: Request): Promise<Response> {
    if (!options.secret.trim() || (options.providerUserId!==undefined&&!providerId(options.providerUserId))) return new Response(null, { status: 503 });
    if (!request.body) return new Response(null, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
    } catch {
      return new Response(null, { status: 400 });
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    const payload = verifyDialpadVoiceEvent(raw, options.secret);
    if (!payload) return new Response(null, { status: 401 });
    const callId = providerId(payload.call_id);
    if (!callId || typeof payload.state !== "string" || !payload.state.trim()) return new Response(null, { status: 400 });
    const target = payload.target;
    if (target && typeof target === "object" && !Array.isArray(target)) {
      const targetRecord = target as Record<string, unknown>;
      const targetId = providerId(targetRecord.id);
      const targetType = typeof targetRecord.type === "string" ? targetRecord.type.trim().toLowerCase() : null;
      // Missing/unknown types and related group legs need reconciliation. Only
      // positively identified other users are outside this single-rep receiver.
      if (options.providerUserId && targetId && targetType === "user" && targetId !== options.providerUserId) {
        return new Response(null, { status: 204 });
      }
    }
    try {
      await options.persist({
        envelopeHash: createHash("sha256").update(raw).digest("hex"),
        providerCallId: callId,
        payload,
      });
    } catch {
      // Deliberately return retryable failure without exposing payload or DB errors.
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  };
}
