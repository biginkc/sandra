import { createDialpadVoiceAdminClient } from "../src/lib/dialpad-voice/database";
import type { DialpadVoiceDatabase } from "../src/lib/dialpad-voice/database.generated";
import { recoverDialpadPredispatch } from "../src/lib/dialpad-voice/start-recovery";

type RecoveryDatabase = Omit<DialpadVoiceDatabase, "public"> & {
  public: Omit<DialpadVoiceDatabase["public"], "Functions"> & {
    Functions: DialpadVoiceDatabase["public"]["Functions"] & {
      fn_recover_dialpad_pre_dispatch: {
        Args: { p_org_id: string; p_limit: number };
        Returns: { recovered: number; resumed: number };
      };
    };
  };
};

async function main() {
  if (process.env.DIALPAD_VOICE_RECOVERY_WORKER_ENABLED !== "true") {
    throw new Error("Recovery disabled");
  }
  const orgId = process.env.DIALPAD_VOICE_ORG_ID ?? "";
  const client = createDialpadVoiceAdminClient<RecoveryDatabase>();
  console.log(JSON.stringify(await recoverDialpadPredispatch(client, orgId)));
}
main().catch(() => {
  console.error("Dialpad recovery did not complete; inspect configuration and durable reservation state.");
  process.exitCode = 1;
});
