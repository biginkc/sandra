import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { resumeByProperty } from "@/lib/sequences/enrollment";

/**
 * Webhook-side lead resume. resumeFailedSoftphoneCall needs the caller's browser session, which a provider
 * webhook does not have, so this runs the same underlying resume (resumeByProperty, unchanged) with the
 * service client and the operator as the acting user. No resume rule is added or altered.
 */
export async function resumeLeadForOperator(propertyId: string, operatorUserId: string): Promise<void> {
  await resumeByProperty(createAdminClient(), { propertyId, actor: { actorType: "user", actorId: operatorUserId } });
}
