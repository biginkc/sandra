"use server";

import { createHash } from "node:crypto";

import { FACT_LABELS, isFactField } from "@/lib/call-facts/types";
import { reportError } from "@/lib/errors/report";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getMyLeadsQueueRow, myLeadsViewer, MyLeadsReadError } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createNextStep } from "@/lib/next-steps";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { ok: false as const, message: "That lead could not be found." };

export type CallFactActionResult =
  | { ok: true; field?: string; value?: string; duplicate?: boolean; nextStepCreated?: boolean }
  | { ok: false; message: string };

type FactRow = {
  id: string;
  property_id: string;
  status: string;
  facts: Record<string, { value?: unknown; due_at?: unknown } | undefined> | null;
  accepted: Record<string, unknown> | null;
};

// A stable uuid per (fact, field): the next-step idempotency key, so a retry after a failed accept
// replays the same appointment instead of creating a second one.
async function nextStepKey(factId: string): Promise<string> {
  const h = createHash("md5").update(`call_fact_next_step:${factId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Gate shared by both actions: flag, own queue, schema; returns the viewer and the open fact row. */
type Viewer = Awaited<ReturnType<typeof myLeadsViewer>>;
type OwnedRow = Extract<Awaited<ReturnType<typeof getMyLeadsQueueRow>>, { status: "found" }>;
type Loaded = { fail: CallFactActionResult } | { fail?: undefined; viewer: Viewer; owned: OwnedRow; fact: FactRow };

async function loadOwnedFact(input: { propertyId: string; factId: string }): Promise<Loaded> {
  if (typeof input?.propertyId !== "string" || !UUID.test(input.propertyId) || typeof input?.factId !== "string" || !UUID.test(input.factId)) {
    return { fail: NOT_FOUND };
  }
  const viewer = await myLeadsViewer();
  if (!(await getMyLeadsFlag(viewer.orgId, "call_screen"))) return { fail: NOT_FOUND };
  const owned = await getMyLeadsQueueRow({ memberId: viewer.userId, propertyId: input.propertyId });
  if (owned.status !== "found") return { fail: NOT_FOUND };
  if (!(await schemaReady("call_facts"))) return { fail: { ok: false as const, message: "Call facts are not available yet." } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (viewer.client as any)
    .from("lead_call_facts")
    .select("id, property_id, status, facts, accepted")
    .eq("id", input.factId)
    .eq("org_id", viewer.orgId)
    .eq("property_id", input.propertyId)
    .eq("processing_state", "done")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { fail: NOT_FOUND };
  return { viewer, owned, fact: data as FactRow };
}

function mapRpcError(error: { code?: string }): CallFactActionResult | null {
  if (error.code === "P0002") return NOT_FOUND;
  if (error.code === "22023") return { ok: false, message: "That suggestion is no longer available." };
  if (error.code === "42501") return { ok: false, message: "You do not have access to this lead." };
  return null;
}

/**
 * Accept one proposed fact. The value is read from the stored proposal, never from the client.
 * Nothing is written to the lead except the "From call summary" note (fn_accept_call_fact) and, for
 * `next_step`, the Phase 1 createNextStep appointment. No `properties` column is ever written.
 */
export async function acceptCallFactAction(input: { propertyId: string; factId: string; field: string }): Promise<CallFactActionResult> {
  if (!isFactField(input?.field)) return { ok: false, message: "That suggestion is no longer available." };
  const field = input.field;
  try {
    const loaded = await loadOwnedFact(input);
    if (loaded.fail) return loaded.fail;
    const { viewer, owned, fact } = loaded;
    if (fact.status === "dismissed") return { ok: false, message: "That suggestion is no longer available." };
    const stored = fact.facts?.[field]?.value;
    if (typeof stored !== "string" || stored === "") return { ok: false, message: "That suggestion is no longer available." };
    // The note and the chip show the VERBATIM value; the resolved instant (`due_at`) is separate data.
    let due: number | null = null;
    if (field === "next_step") {
      const raw = fact.facts?.next_step?.due_at;
      due = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(due) || due <= Date.now()) return { ok: false, message: "That time has already passed. Add the next step yourself." };
    }

    // Record the acceptance FIRST (it enforces ownership and refuses a dismissed fact), so a concurrent
    // dismiss can never leave an appointment behind.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (viewer.client as any).rpc("fn_accept_call_fact", {
      p_org_id: viewer.orgId,
      p_fact_id: input.factId,
      p_field: field,
      p_value: stored,
    });
    if (error) {
      const mapped = mapRpcError(error);
      if (mapped) return mapped;
      throw error;
    }
    const duplicate = ((data ?? {}) as { duplicate?: boolean }).duplicate === true;

    let nextStepCreated = false;
    if (field === "next_step" && due !== null) {
      // Runs on a replay too (idempotent by key), so a crash between the two steps self-heals.
      const created = await createNextStep({
        kind: "appointment",
        mode: "phone",
        propertyId: input.propertyId,
        contactId: owned.row.contactId ?? undefined,
        assigneeId: viewer.userId,
        dueAt: new Date(due).toISOString(),
        title: `Call ${owned.row.address}`,
        idempotencyKey: await nextStepKey(input.factId),
        origin: "app",
      });
      if (!created.ok) {
        // Undo the acceptance so the chip stays and the rep can retry.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (viewer.client as any).rpc("fn_unaccept_call_fact", { p_org_id: viewer.orgId, p_fact_id: input.factId, p_field: field });
        return { ok: false, message: `Next step not set: ${created.error.message}` };
      }
      nextStepCreated = !created.data.duplicate;
    }
    return { ok: true, field, value: stored, duplicate, nextStepCreated };
  } catch (error) {
    if (error instanceof MyLeadsReadError) return { ok: false, message: error.message };
    reportError(error instanceof Error ? error : new Error("accept call fact failed"), { tags: { surface: "call_facts", operation: "accept", field: FACT_LABELS[field] } });
    return { ok: false, message: "That suggestion could not be saved. Please retry." };
  }
}

/** Dismiss the whole proposal. Writes nothing to the lead. */
export async function dismissCallFactsAction(input: { propertyId: string; factId: string }): Promise<CallFactActionResult> {
  try {
    const loaded = await loadOwnedFact(input);
    if (loaded.fail) return loaded.fail;
    const { viewer } = loaded;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (viewer.client as any).rpc("fn_dismiss_call_facts", { p_org_id: viewer.orgId, p_fact_id: input.factId });
    if (error) {
      const mapped = mapRpcError(error);
      if (mapped) return mapped;
      throw error;
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof MyLeadsReadError) return { ok: false, message: error.message };
    reportError(error instanceof Error ? error : new Error("dismiss call facts failed"), { tags: { surface: "call_facts", operation: "dismiss" } });
    return { ok: false, message: "That could not be dismissed. Please retry." };
  }
}
