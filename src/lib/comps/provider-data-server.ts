import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { projectProviderData } from "./provider-data";

/** RLS read must authorize this exact comp before its service-only source data is projected. */
export async function loadProviderData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  memberClient: any, orgId: string, compId: string,
  admin = createAdminClient,
) {
  const allowed = await memberClient.from("lead_comps").select("id, property_id").eq("org_id", orgId).eq("id", compId).maybeSingle();
  if (allowed.error || !allowed.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (admin() as any).from("lead_comps").select("raw").eq("org_id", orgId).eq("property_id", allowed.data.property_id).eq("id", compId).maybeSingle();
  if (result.error || !result.data) return null;
  return projectProviderData(result.data.raw);
}
