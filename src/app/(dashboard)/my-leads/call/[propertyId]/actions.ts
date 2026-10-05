"use server";

import { compLead, type CompLeadResult } from "@/lib/comps";
import { reportError } from "@/lib/errors/report";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getMyLeadsQueueRow, myLeadsViewer, MyLeadsReadError } from "@/lib/my-leads/queries";
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
    // Gate before any property read, schema check or paid comp: the call_screen flag, then the lead
    // must be in the caller's own queue.
    if (!(await getMyLeadsFlag(viewer.orgId, "call_screen"))) return { ok: false, message: "That lead could not be found." };
    const owned = await getMyLeadsQueueRow({ memberId: viewer.userId, propertyId });
    if (owned.status !== "found") return { ok: false, message: "That lead could not be found." };
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

export type SaveValuationResult = { ok: true; arv: number | null; rehab: number | null } | { ok: false; message: string };

/**
 * Jarrad's typed ARV and rehab for the numbers card (§3.10) → `fn_set_lead_valuation_inputs`
 * through the caller's RLS client (the function checks membership itself). Requires the `call_screen` flag,
 * the lead in the caller's own queue, and the `lead_comps` schema. Never writes `properties.arv`.
 */
export async function setValuationInputsAction(input: {
  propertyId: string;
  arv: number | null;
  rehab: number | null;
}): Promise<SaveValuationResult> {
  if (typeof input?.propertyId !== "string" || !UUID.test(input.propertyId)) return { ok: false, message: "That lead could not be found." };
  const valid = (v: number | null, min: number) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= min && v <= 1e12);
  if (!valid(input.arv, 0.01) || !valid(input.rehab, 0)) return { ok: false, message: "Enter a valid dollar amount." };
  try {
    const viewer = await myLeadsViewer();
    // Same gates as the call screen route: the flag, then the lead must be in the caller's own queue.
    if (!(await getMyLeadsFlag(viewer.orgId, "call_screen"))) return { ok: false, message: "That lead could not be found." };
    const owned = await getMyLeadsQueueRow({ memberId: viewer.userId, propertyId: input.propertyId });
    if (owned.status !== "found") return { ok: false, message: "That lead could not be found." };
    if (!(await schemaReady("lead_comps"))) return { ok: false, message: "Numbers are not available yet." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (viewer.client as any).rpc("fn_set_lead_valuation_inputs", {
      p_org_id: viewer.orgId,
      p_property_id: input.propertyId,
      p_arv: input.arv,
      p_rehab: input.rehab,
    });
    if (error) {
      if (error.code === "P0002") return { ok: false, message: "That lead could not be found." };
      if (error.code === "22023") return { ok: false, message: "Enter a valid dollar amount." };
      if (error.code === "42501") return { ok: false, message: "You do not have access to this lead." };
      throw error;
    }
    const out = (data ?? {}) as { arv?: unknown; rehab?: unknown };
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { ok: true, arv: num(out.arv), rehab: num(out.rehab) };
  } catch (error) {
    if (error instanceof MyLeadsReadError) return { ok: false, message: error.message };
    reportError(error instanceof Error ? error : new Error("valuation save failed"), { tags: { surface: "call_screen", operation: "set_valuation_inputs" } });
    return { ok: false, message: "The numbers could not be saved. Please retry." };
  }
}
