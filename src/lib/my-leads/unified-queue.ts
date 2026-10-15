import "server-only";

import { getMyLeadsFlag } from "./flags";
import { schemaReady } from "./schema-ready";

/**
 * True only when the org's `unified_queue` switch is on AND the classifier, pin and Dismiss
 * functions exist. Any error or throw reads as OFF, so the old page keeps rendering. Kept free of
 * queries.ts imports so queries.ts (the sidebar badge) can use it without a cycle.
 */
export async function unifiedQueueEnabled(orgId: string): Promise<boolean> {
  try {
    if (!(await getMyLeadsFlag(orgId, "unified_queue"))) return false;
    return await schemaReady("unified_queue");
  } catch {
    return false;
  }
}
