import { persistDialpadVoiceReceipt } from "@/lib/dialpad-voice/inbox";
import { createDialpadVoiceReceiver } from "@/lib/dialpad-voice/webhook-receiver";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // Provision the migration and subscription only as part of the gated pilot.
  if (process.env.DIALPAD_VOICE_EVENTS_ENABLED !== "true") return new Response(null, { status: 404 });
  const orgId = process.env.DIALPAD_VOICE_ORG_ID ?? "";
  const providerUserId = process.env.DIALPAD_VOICE_USER_ID ?? "";
  const secret = process.env.DIALPAD_VOICE_WEBHOOK_SECRET ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    return new Response(null, { status: 503 });
  }
  return createDialpadVoiceReceiver({
    secret,
    providerUserId,
    persist: (receipt) => persistDialpadVoiceReceipt(orgId, receipt),
  })(request);
}
