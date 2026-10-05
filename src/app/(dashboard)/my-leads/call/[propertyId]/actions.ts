"use server";

import { compLead, type CompLeadResult } from "@/lib/comps";
import { reportError } from "@/lib/errors/report";
import { myLeadsViewer, MyLeadsReadError } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompLeadActionResult = { ok: true; result: CompLeadResult } | { ok: false; message: string };

/**
 * "Comp this lead" (§3.4). Auth through `myLeadsViewer`, the property must be visible through
 * the caller's RLS client, then `compLead(..., { trigger: 'manual', inline: true })`. Returns
 * the disabled state unless the `lead_comps` schema is ready (readiness `lead_comps`).
 */
export async function compLeadAction(propertyId: string): Promise<CompLeadActionResult> {
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) return { ok: false, message: "That lead could not be found." };
  try {
    const viewer = await myLeadsViewer();
    const { data, error } = await viewer.client
      .from("properties")
      .select("id, org_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (error || !data || data.org_id !== viewer.orgId) return { ok: false, message: "That lead could not be found." };
    if (!(await schemaReady("lead_comps"))) return { ok: true, result: { status: "disabled" } };
    const result = await compLead(propertyId, { trigger: "manual", requestedBy: viewer.userId, inline: true });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MyLeadsReadError) return { ok: false, message: error.message };
    reportError(error instanceof Error ? error : new Error("comp lead failed"), { tags: { surface: "comps", operation: "comp_lead_action" } });
    return { ok: false, message: "Comps could not be requested. Please retry." };
  }
}
