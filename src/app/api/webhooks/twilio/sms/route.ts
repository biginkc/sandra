import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { getWebhookProvider } from "@/lib/messaging/registry";

/**
 * Twilio inbound-SMS webhook.
 *
 * Mirrors the DialPad route 1:1 except for two provider-specific bits:
 *   - The full request URL is passed to `verifyWebhookSignature` because
 *     Twilio's HMAC-SHA1 scheme folds the URL into the canonical string.
 *   - Error tags are scoped to `twilio_webhook_*` so logs disambiguate.
 *
 * The shared handler stays provider-agnostic, but this route pins the
 * Twilio adapter so signature verification and payload parsing match the
 * webhook source rather than whichever outbound provider happens to be
 * configured globally.
 *
 * Follow-up: factor the shared inbound logic into a helper so dialpad +
 * twilio routes are thin wrappers. Deferred until both providers prove
 * stable in parallel.
 *
 * Flow:
 *   1. Read raw body (signature needs bytes, not parsed form).
 *   2. Provider.verifyWebhookSignature(rawBody, headers, fullUrl) — 401
 *      on mismatch.
 *   3. Persist a `webhook_events` row; unique (provider, event_type,
 *      external_id) gives exactly-once processing on retries.
 *   4. STOP/HELP/DNC/wrong-number routing, otherwise persist as inbound
 *      message + downstream side effects (qualify, notify, AI responder).
 *
 * Replies 200 after a valid signature even on downstream DB errors so
 * Twilio stops retrying. The error is logged for reconciliation.
 */

export async function POST(request: Request) {
  return handleInboundWebhook(request, {
    includeFullUrl: true,
    provider: getWebhookProvider("twilio"),
  });
}
