/**
 * Deterministic synthetic double for the reply-send transport
 * (`createSendilloReplyTransport`, ./reply-provider.ts). Mirrors the
 * module-state/factory/reset pattern of
 * `src/lib/messaging/providers/mock.ts` — module-level state shared across
 * every call, a reset hook for tests, and force-outcome control via a
 * per-destination registration (mock.ts's persona idiom) rather than
 * parsing the message body, since the reply body here is frozen/reviewed
 * text the caller does not control.
 *
 * `createSyntheticReplyTransport` has the SAME factory signature as
 * `createSendilloReplyTransport(apiKey, transport?)` so it is a drop-in for
 * the reply-dispatch send seam (Lane 1 PR-F) — the `transport` parameter is
 * accepted but unused (never calls fetch; this is a pure fake).
 *
 * `buildSyntheticReplyCallback` emits the exact JSON envelope the ingress
 * route (`src/app/api/webhooks/sendillo/reply-status/route.ts`) expects,
 * for a given externalId + terminal status, so a synthetic accept ->
 * synthetic callback round-trip can be driven end-to-end in tests without
 * ever touching the real Sendillo API.
 */
import type { FrozenReply, ReplyProviderResult } from "./reply-provider";

const PHONE = /^\+[1-9][0-9]{7,14}$/;

export type SyntheticReplyLogEntry = {
  externalId: string;
  from: string;
  to: string;
  body: string;
  createdAt: Date;
  result: ReplyProviderResult;
};

/** One-shot forced outcome for the NEXT send to a given `to` number. Popped
 *  (removed) the moment it is consumed, so subsequent sends to the same
 *  number revert to the default accepted behavior. */
export type SyntheticReplyOverride =
  | { kind: "accepted"; providerStatus?: string }
  | { kind: "not_attempted"; reason: "invalid_input" | "cancelled_before_dispatch" }
  | { kind: "uncertain"; reason: "transport_or_timeout" | "response_too_large" | "unverified_http_rejection" | "missing_acceptance_reference" | "contradictory_response"; reportedExternalId?: string };

const log: SyntheticReplyLogEntry[] = [];
const overrides = new Map<string, SyntheticReplyOverride>();
let counter = 0;

/** Reset every piece of synthetic state. Call from `beforeEach` in tests. */
export function resetSyntheticReplyState(): void {
  log.length = 0;
  overrides.clear();
  counter = 0;
}

/** Force the outcome of the NEXT send to `to`. Consumed on first use. */
export function registerSyntheticReplyOverride(to: string, override: SyntheticReplyOverride): void {
  overrides.set(to, override);
}

/** Full send log, in call order. */
export function getSyntheticReplyLog(): SyntheticReplyLogEntry[] {
  return log.map((entry) => ({ ...entry }));
}

/**
 * Same factory signature as `createSendilloReplyTransport(apiKey,
 * transport?)`. `transport` is accepted only for signature compatibility —
 * this double never calls it.
 */
export function createSyntheticReplyTransport(apiKey: string, _transport: typeof fetch = fetch) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw Error("Reply provider configuration missing");
  return async (input: FrozenReply, cancellation: AbortSignal): Promise<ReplyProviderResult> => {
    if (!input || typeof input.body !== "string" || !input.body.trim() || input.body.length > 1600 || !PHONE.test(input.from) || !PHONE.test(input.to)) {
      return { kind: "not_attempted", reason: "invalid_input" };
    }
    if (cancellation.aborted) return { kind: "not_attempted", reason: "cancelled_before_dispatch" };

    const override = overrides.get(input.to);
    if (override) overrides.delete(input.to);

    const externalId = `synthetic_${input.to}_${++counter}`;
    let result: ReplyProviderResult;
    if (!override) {
      result = { kind: "accepted", provider: "sendillo", externalId, providerStatus: "sent" };
    } else if (override.kind === "accepted") {
      result = { kind: "accepted", provider: "sendillo", externalId, providerStatus: override.providerStatus ?? "sent" };
    } else if (override.kind === "not_attempted") {
      result = { kind: "not_attempted", reason: override.reason };
    } else {
      result = { kind: "uncertain", reason: override.reason, ...(override.reportedExternalId !== undefined ? { reportedExternalId: override.reportedExternalId } : {}) };
    }

    log.push({ externalId, from: input.from, to: input.to, body: input.body, createdAt: new Date(), result });
    return result;
  };
}

/**
 * Build the exact JSON body the reply-status ingress route parses:
 * `{ event: "message.delivered" | "message.failed", data: { messageId,
 * ...} }`, mirroring the envelope shape `parseWebhookEnvelope` uses for the
 * Outbox's own status webhooks (sendillo.ts) — event name at the top level,
 * message fields nested under `data`. This is a NEW, reply-specific shape
 * (never reused against the Outbox parser); the ingress route owns its own
 * bounded parser for it.
 */
export function buildSyntheticReplyCallback(externalId: string, terminal: "delivered" | "delivery_failed", extra?: Record<string, unknown>): { event: string; data: Record<string, unknown> } {
  return {
    event: terminal === "delivered" ? "message.delivered" : "message.failed",
    data: { messageId: externalId, ...(extra ?? {}) },
  };
}
