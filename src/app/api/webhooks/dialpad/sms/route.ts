import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { getWebhookProvider } from "@/lib/messaging/registry";

// Must stay <= WEBHOOK_PROCESSING_LEASE_MS (src/lib/messaging/webhook-lease.ts; asserted in
// webhook-lease.test.ts): a newer text still inside its webhook is treated as in flight for that
// long (routing v2 A-2), so a webhook may never run longer than the lease.
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleInboundWebhook(request, {
    includeFullUrl: false,
    provider: getWebhookProvider("dialpad"),
  });
}
