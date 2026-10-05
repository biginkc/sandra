"use server";

import { revalidatePath } from "next/cache";

import { authenticateLeadEsignActor, createBoundLeadEsignCore } from "@/app/(dashboard)/leads/[id]/lead-esign-bindings";
import { reportError } from "@/lib/errors/report";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getMyLeadsQueueRow, myLeadsViewer, MyLeadsReadError } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";

import type { ContractCardState, OfferConflictRow, OfferRecoveryResult } from "../types";
import { voidContractAction } from "@/app/(dashboard)/leads/[id]/lead-esign-actions";
import { updateLeadAssignee } from "@/app/(dashboard)/leads/actions";
import {
  abandonOfferIntent, createOfferIntent, precheckOffer, projectOfferNow, resolveOfferIntent,
} from "@/lib/my-leads/offer-projection";
import { loadContractCardData } from "./contract-card-context";
import { loadProjectionView } from "./contract-card-projection";
import {
  createContractCardCore,
  type ContractCardCoreDeps,
  type OfferProjectionPort,
  type SendContractCardInput,
  type SendContractCardResult,
} from "./contract-card-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECOVERY_COPY: Record<string, string> = {
  STALE_STATE: "This lead changed. Open the lead to check it.",
  FORBIDDEN: "You cannot act on this contract.",
  NOT_FOUND: "That contract could not be found.",
  PROJECTION_NOT_LOGGED: "The offer could not be logged, so nothing was changed.",
  PENDING_OFFER_EXISTS: "This lead still has a pending offer.",
  DNC_LOCKED: "This lead is do-not-contact.",
  STALE_ASSIGNMENT: "This lead is assigned to someone else.",
};

const projectionPort: OfferProjectionPort = {
  resolveIntent: async (viewer, sendIntentId) => {
    const v = await myLeadsViewer();
    return resolveOfferIntent({ userId: viewer.userId, orgId: viewer.orgId, client: v.client }, sendIntentId);
  },
  precheck: async (viewer, propertyId) => {
    const v = await myLeadsViewer();
    const r = await precheckOffer({ userId: viewer.userId, orgId: viewer.orgId, client: v.client }, propertyId);
    return r.ok ? { ok: true, motivationRecorded: r.motivationRecorded } : { ok: false, code: r.code, message: r.message };
  },
  createIntent: (input) => createOfferIntent(input),
  projectNow: (projectionId) => projectOfferNow(projectionId),
  abandon: (projectionId) => abandonOfferIntent(projectionId),
};

export async function loadContractCard(propertyId: string): Promise<ContractCardState> {
  const off = (reason: string): ContractCardState => ({ enabled: false, reason });
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) return off("That lead could not be found.");
  try {
    const viewer = await myLeadsViewer();
    if (!(await getMyLeadsFlag(viewer.orgId, "contract_card")) || !(await schemaReady("offer_projection"))) {
      return off("Send contract is not available yet.");
    }
    const owned = await getMyLeadsQueueRow({ memberId: viewer.userId, propertyId });
    if (owned.status !== "found") return off("That lead could not be found.");
    const loaded = await loadContractCardData(viewer, propertyId);
    if (!("state" in loaded)) return off(loaded.reason);
    return {
      ...loaded.state,
      projection: await loadProjectionView(viewer.orgId, propertyId),
      motivationRecorded: owned.row.motivationKind != null,
    };
  } catch (error) {
    if (error instanceof MyLeadsReadError) return off(error.message);
    reportError(error instanceof Error ? error : new Error("contract card load failed"), { tags: { surface: "contract_card", operation: "load" } });
    return off("The contract card could not load.");
  }
}

export async function sendContractCardAction(input: SendContractCardInput): Promise<SendContractCardResult> {
  try {
    const deps: ContractCardCoreDeps = {
      viewer: async () => {
        // Signed-in membership and the eSign actor must agree (the core re-authenticates too).
        const viewer = await myLeadsViewer();
        const actor = await authenticateLeadEsignActor();
        if (!actor || actor.orgId !== viewer.orgId || actor.userId !== viewer.userId) {
          throw new MyLeadsReadError("FORBIDDEN", "You cannot send contracts.");
        }
        return { userId: viewer.userId, orgId: viewer.orgId, isOwner: viewer.isOwner };
      },
      flagOn: (orgId) => getMyLeadsFlag(orgId, "contract_card"),
      projectionReady: () => schemaReady("offer_projection"),
      ownsLead: async (viewer, propertyId) =>
        (await getMyLeadsQueueRow({ memberId: viewer.userId, propertyId })).status === "found",
      loadContext: async (viewer, propertyId, templateId) => {
        const v = await myLeadsViewer();
        const loaded = await loadContractCardData({ ...viewer, client: v.client }, propertyId, templateId);
        return "ctx" in loaded ? loaded.ctx : null;
      },
      projection: projectionPort,
      saveTitleCompany: async (viewer, t) => {
        // Same gate as the contract-defaults settings: only the org owner may write (RLS enforces it too).
        if (!viewer.isOwner) return false;
        const v = (await myLeadsViewer()) as { client: Loose };
        const { error } = await v.client.from("acquisition_contract_title_companies").insert({
          org_id: viewer.orgId, name: t.name.trim(), closing_agent_name: t.closingAgentName.trim(),
          closing_agent_phone: t.closingAgentPhone?.trim() || null, closing_agent_address: t.closingAgentAddress?.trim() || null,
          closing_agent_email: t.closingAgentEmail?.trim() || null,
        });
        return !error;
      },
      saveBuyerEntity: async (viewer, b) => {
        if (!viewer.isOwner) return false;
        const v = (await myLeadsViewer()) as { client: Loose };
        const { error } = await v.client.from("acquisition_contract_buyer_entities").insert({
          org_id: viewer.orgId, name: b.name.trim(), phone: b.phone?.trim() || null, email: b.email?.trim() || null,
          attorney_in_fact: b.attorneyInFact?.trim() || null,
        });
        return !error;
      },
      send: (i) => createBoundLeadEsignCore().send({ ...i, mergeValues: i.mergeValues as never }),
    };
    const result = await createContractCardCore(deps).sendContractCard(input);
    if (result.status === "sent" || result.status === "unconfirmed") {
      revalidatePath("/my-leads");
      revalidatePath(`/leads/${input.propertyId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof MyLeadsReadError) return { status: "blocked", code: error.code, message: error.message };
    reportError(error instanceof Error ? error : new Error("send contract card failed"), { tags: { surface: "contract_card", operation: "send" } });
    // Only reached for failures before the send step (the core handles everything after it); the
    // client keeps the same intent id, so a retry replays idempotently.
    return { status: "failed", message: "The contract could not be sent. Please retry." };
  }
}

// ---- Offer recovery (TECH-PLAN §3.9). None of these ever calls the eSign provider's send. ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type ProjectionRow = { id: string; property_id: string; actor_user_id: string; esign_request_id: string | null; state: string };

type RecoveryContext =
  | { fail: OfferRecoveryResult; viewer?: undefined; row?: undefined }
  | { fail?: undefined; viewer: Awaited<ReturnType<typeof myLeadsViewer>> & { client: Loose }; row: ProjectionRow };

async function recoveryContext(projectionId: unknown): Promise<RecoveryContext> {
  if (typeof projectionId !== "string" || !UUID.test(projectionId)) {
    return { fail: { ok: false, code: "INVALID_INPUT", message: "That contract could not be found." } as OfferRecoveryResult };
  }
  const viewer = (await myLeadsViewer()) as Awaited<ReturnType<typeof myLeadsViewer>> & { client: Loose };
  if (!(await getMyLeadsFlag(viewer.orgId, "contract_card")) || !(await schemaReady("offer_projection"))) {
    return { fail: { ok: false, code: "FEATURE_DISABLED", message: "Send contract is not available yet." } as OfferRecoveryResult };
  }
  const found = await viewer.client
    .from("acquisition_offer_projections")
    .select("id, property_id, actor_user_id, esign_request_id, state")
    .eq("org_id", viewer.orgId)
    .eq("id", projectionId)
    .maybeSingle();
  const row = (found.error ? null : found.data) as ProjectionRow | null;
  if (!row) return { fail: { ok: false, code: "NOT_FOUND", message: RECOVERY_COPY.NOT_FOUND } as OfferRecoveryResult };
  return { viewer, row };
}

function recoveryFailure(error: { message?: string; code?: string }): OfferRecoveryResult {
  const text = error.message ?? "";
  const code = Object.keys(RECOVERY_COPY).find((c) => text.includes(c)) ?? "FAILED";
  return { ok: false, code, message: RECOVERY_COPY[code] ?? "That did not work. Nothing was changed." };
}

function recoveryDone(row: ProjectionRow, data: unknown): OfferRecoveryResult {
  const r = (data ?? {}) as { state?: string; duplicate?: boolean };
  revalidatePath("/my-leads");
  revalidatePath(`/leads/${row.property_id}`);
  return { ok: true, state: r.state ?? "logged", ...(r.duplicate ? { duplicate: true } : {}) };
}

export async function retryOfferProjectionAction(projectionId: string): Promise<OfferRecoveryResult> {
  try {
    const ctx = await recoveryContext(projectionId);
    if (ctx.fail) return ctx.fail;
    const { viewer, row } = ctx as Extract<RecoveryContext, { row: ProjectionRow }>;
    const { data, error } = await viewer.client.rpc("fn_retry_offer_projection", { p_org_id: viewer.orgId, p_projection_id: row.id });
    return error ? recoveryFailure(error) : recoveryDone(row, data);
  } catch (error) {
    reportError(error instanceof Error ? error : new Error("retry offer projection failed"), { tags: { surface: "contract_card", operation: "retry_offer" } });
    return { ok: false, code: "FAILED", message: "That did not work. Nothing was changed." };
  }
}

export async function supersedeOfferAction(projectionId: string, idempotencyKey: string): Promise<OfferRecoveryResult> {
  try {
    if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) return { ok: false, code: "INVALID_INPUT", message: "Try again." };
    const ctx = await recoveryContext(projectionId);
    if (ctx.fail) return ctx.fail;
    const { viewer, row } = ctx as Extract<RecoveryContext, { row: ProjectionRow }>;
    const { data, error } = await viewer.client.rpc("fn_supersede_offer_and_log", {
      p_org_id: viewer.orgId, p_projection_id: row.id, p_idempotency_key: idempotencyKey,
    });
    return error ? recoveryFailure(error) : recoveryDone(row, { state: "logged", duplicate: (data as { duplicate?: boolean } | null)?.duplicate });
  } catch (error) {
    reportError(error instanceof Error ? error : new Error("supersede offer failed"), { tags: { surface: "contract_card", operation: "supersede_offer" } });
    return { ok: false, code: "FAILED", message: "That did not work. Nothing was changed." };
  }
}

export async function reassignAndLogOfferAction(projectionId: string): Promise<OfferRecoveryResult> {
  try {
    const ctx = await recoveryContext(projectionId);
    if (ctx.fail) return ctx.fail;
    const { viewer, row } = ctx as Extract<RecoveryContext, { row: ProjectionRow }>;
    if (!viewer.isOwner && row.actor_user_id !== viewer.userId) return { ok: false, code: "FORBIDDEN", message: RECOVERY_COPY.FORBIDDEN };
    // Reassign to the viewer (already a no-op when they are the assignee), then log as them.
    const reassigned = await updateLeadAssignee(row.property_id, viewer.userId);
    if (!reassigned.ok) return { ok: false, code: reassigned.error.code, message: reassigned.error.message };
    const { data, error } = await viewer.client.rpc("fn_retry_offer_projection", {
      p_org_id: viewer.orgId, p_projection_id: row.id, p_resolution: "reassigned",
    });
    return error ? recoveryFailure(error) : recoveryDone(row, data);
  } catch (error) {
    reportError(error instanceof Error ? error : new Error("reassign and log offer failed"), { tags: { surface: "contract_card", operation: "reassign_offer" } });
    return { ok: false, code: "FAILED", message: "That did not work. Nothing was changed." };
  }
}

export async function cancelContractAction(requestId: string): Promise<OfferRecoveryResult> {
  try {
    if (typeof requestId !== "string" || !UUID.test(requestId)) return { ok: false, code: "INVALID_INPUT", message: "That contract could not be found." };
    const viewer = (await myLeadsViewer()) as Awaited<ReturnType<typeof myLeadsViewer>> & { client: Loose };
    if (!(await getMyLeadsFlag(viewer.orgId, "contract_card")) || !(await schemaReady("offer_projection"))) {
      return { ok: false, code: "FEATURE_DISABLED", message: "Send contract is not available yet." };
    }
    const found = await viewer.client
      .from("acquisition_offer_projections")
      .select("id, property_id, actor_user_id, esign_request_id, state")
      .eq("org_id", viewer.orgId)
      .eq("esign_request_id", requestId)
      .maybeSingle();
    const row = (found.error ? null : found.data) as ProjectionRow | null;
    if (!row) return { ok: false, code: "NOT_FOUND", message: RECOVERY_COPY.NOT_FOUND };
    if (!viewer.isOwner && row.actor_user_id !== viewer.userId) return { ok: false, code: "FORBIDDEN", message: RECOVERY_COPY.FORBIDDEN };
    const result = await voidContractAction({ requestId });
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message };
    revalidatePath("/my-leads");
    revalidatePath(`/leads/${row.property_id}`);
    return { ok: true, state: "cancelled" };
  } catch (error) {
    reportError(error instanceof Error ? error : new Error("cancel contract failed"), { tags: { surface: "contract_card", operation: "cancel_contract" } });
    return { ok: false, code: "FAILED", message: "The contract could not be cancelled. Nothing was changed." };
  }
}

/** Conflicts the signed-in rep may act on (owner: all), for the My Leads strip. */
export async function listOfferConflictsAction(): Promise<OfferConflictRow[]> {
  try {
    const viewer = (await myLeadsViewer()) as Awaited<ReturnType<typeof myLeadsViewer>> & { client: Loose };
    if (!(await getMyLeadsFlag(viewer.orgId, "contract_card")) || !(await schemaReady("offer_projection"))) return [];
    const { data, error } = await viewer.client.rpc("fn_list_offer_conflicts", { p_org_id: viewer.orgId, p_member_id: viewer.userId });
    return error || !Array.isArray(data) ? [] : (data as OfferConflictRow[]);
  } catch {
    return [];
  }
}
