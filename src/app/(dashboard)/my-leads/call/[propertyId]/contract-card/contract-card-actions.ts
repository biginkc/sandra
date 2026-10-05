"use server";

import { revalidatePath } from "next/cache";

import { authenticateLeadEsignActor, createBoundLeadEsignCore } from "@/app/(dashboard)/leads/[id]/lead-esign-bindings";
import { reportError } from "@/lib/errors/report";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getMyLeadsQueueRow, myLeadsViewer, MyLeadsReadError } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";

import type { ContractCardState } from "../types";
import { loadContractCardData } from "./contract-card-context";
import {
  createContractCardCore,
  type ContractCardCoreDeps,
  type OfferProjectionPort,
  type SendContractCardInput,
  type SendContractCardResult,
} from "./contract-card-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Offer projection (TECH-PLAN §3.6/3.7) is a separate slice. Until it lands, `schemaReady('offer_projection')`
 * is false, the core returns FEATURE_DISABLED before this port is touched, and every method here refuses.
 */
const unavailableProjection: OfferProjectionPort = {
  resolveIntent: async () => null,
  precheck: async () => ({ ok: false, code: "FEATURE_DISABLED", message: "Offer logging is not available yet." }),
  createIntent: async () => ({ error: "FAILED" }),
  projectNow: async () => ({ state: "pending" }),
  abandon: async () => undefined,
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
    return "state" in loaded ? loaded.state : off(loaded.reason);
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
      projection: unavailableProjection,
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
