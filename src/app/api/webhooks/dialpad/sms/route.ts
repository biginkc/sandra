import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { getWebhookProvider } from "@/lib/messaging/registry";

export async function POST(request: Request) {
  return handleInboundWebhook(request, {
    includeFullUrl: false,
    provider: getWebhookProvider("dialpad"),
  });
}
