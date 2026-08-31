import { createConcreteDropboxSignWebhookDependencies } from "@/lib/esign/webhook-server";
import { handleDropboxSignWebhook } from "@/lib/esign/webhook-handler";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const { secret } = await context.params;
  return handleDropboxSignWebhook({
    request,
    pathSecret: secret,
    dependencies: createConcreteDropboxSignWebhookDependencies(),
  });
}
