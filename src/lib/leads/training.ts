import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type TrainingTarget = {
  propertyId?: string | null;
  contactId?: string | null;
};

/** Read durable record identity; disabling phone training must not enable outreach. */
export async function isTrainingTarget(
  client: SupabaseClient<Database>,
  target: TrainingTarget,
): Promise<boolean> {
  if (target.propertyId) {
    const { data, error } = await client.from("properties")
      .select("is_training").eq("id", target.propertyId).maybeSingle();
    if (error) throw new Error("Could not verify the lead's training status.");
    if (!data) throw new Error("Lead not found.");
    if (data.is_training) return true;
  }
  if (target.contactId) {
    const { data, error } = await client.from("properties")
      .select("id").eq("homeowner_contact_id", target.contactId)
      .eq("is_training", true).limit(1);
    if (error) throw new Error("Could not verify the contact's training status.");
    return Boolean(data?.length);
  }
  return false;
}

export async function assertNotTrainingTarget(
  client: SupabaseClient<Database>,
  target: TrainingTarget,
): Promise<void> {
  if (await isTrainingTarget(client, target)) {
    throw new Error("Customer actions are unavailable for an internal training lead.");
  }
}
