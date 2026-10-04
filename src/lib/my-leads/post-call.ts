import "server-only";

import { getMyLeadsFlag } from "./flags";
import { schemaReady } from "./schema-ready";

/**
 * The post-call prompt replaces the attempt dialog only when its kill switch is on AND the P1c
 * migration (voicemail validators, call references, note idempotency) has landed. A missing flag
 * table, row or column reads OFF, so the old dialog stays the default.
 */
export async function postCallPromptEnabled(orgId: string): Promise<boolean> {
  if (!(await getMyLeadsFlag(orgId, "post_call_prompt"))) return false;
  return schemaReady("post_call_support");
}
