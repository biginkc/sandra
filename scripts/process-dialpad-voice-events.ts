import { createDialpadVoiceAdminClient } from "../src/lib/dialpad-voice/database";
import { processDialpadVoiceEvents } from "../src/lib/dialpad-voice/event-worker";
import { createVoiceEventWorkerStore } from "../src/lib/dialpad-voice/event-worker-store";
import { ingestDialpadInsights } from "../src/lib/dialpad-voice/insights";
import type { DialpadInsightsDatabase } from "../src/lib/dialpad-voice/insights-database.generated";

async function main() {
  const orgId = process.env.DIALPAD_VOICE_ORG_ID ?? "";
  const providerUserId = process.env.DIALPAD_VOICE_USER_ID ?? "";
  if (process.env.DIALPAD_VOICE_WORKER_ENABLED !== "true" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId) ||
    !/^[1-9]\d*$/.test(providerUserId)) {
    throw new Error("Voice worker disabled or unconfigured");
  }
  const client = createDialpadVoiceAdminClient();
  const insightsClient = createDialpadVoiceAdminClient<DialpadInsightsDatabase>();
  const counts = await processDialpadVoiceEvents({
    store: createVoiceEventWorkerStore(client, orgId, (receipt, event) => ingestDialpadInsights({
      client: insightsClient, orgId, providerCallId: event.callId,
      state: event.state, payload: receipt.payload, apiKey: process.env.DIALPAD_VOICE_API_KEY ?? "",
    })), orgId, providerUserId,
  });
  console.log(JSON.stringify(counts));
}

main().catch(() => {
  console.error("Dialpad voice worker did not complete; inspect configuration and durable queue status.");
  process.exitCode = 1;
});
