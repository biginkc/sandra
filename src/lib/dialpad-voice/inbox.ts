import "server-only";
import type {EventConfigurationDatabase} from "./event-configuration-database";
import type { Json } from "@/lib/supabase/types";
import type { DialpadVoiceReceipt } from "./webhook-receiver";
import { createDialpadVoiceAdminClient } from "./database";

/** Server-owned org configuration; never derive tenancy from the event body. */
export async function persistDialpadVoiceReceipt(orgId: string, receipt: DialpadVoiceReceipt, webhookSourceId?:string): Promise<void> {
  const client = createDialpadVoiceAdminClient<EventConfigurationDatabase>();
  const { error } = await client.from("dialpad_voice_event_inbox").upsert({
    org_id: orgId,
    webhook_source_id: webhookSourceId??null,
    envelope_sha256: receipt.envelopeHash,
    // The verifier obtained this object by JSON.parse after signature validation.
    payload: receipt.payload as Json,
  }, { onConflict: "org_id,envelope_sha256", ignoreDuplicates: true });
  if (error) throw new Error("Voice inbox unavailable");
}
