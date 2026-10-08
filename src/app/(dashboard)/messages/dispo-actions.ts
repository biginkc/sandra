"use server";

import { assertNotTrainingTarget } from "@/lib/leads/training";
import { revalidatePath } from "next/cache";

import { applySuppressionForConfirmedReview } from "@/lib/ai-responder/confirm-suppression";
import { reportError } from "@/lib/errors/report";
import {
  saveOutreachDispo,
  type OutreachDispo,
  type SetDispoResult,
} from "@/lib/leads/outreach-dispo";
import { qualifyProperty } from "@/lib/leads/qualify";
import { createClient } from "@/lib/supabase/server";

import {
  assertMessagesWorkspaceAccess,
  MessagesWorkspaceAccessError,
} from "./workspace-access";

export type { OutreachDispo, SetDispoResult };

export type ConfirmAiDispositionReviewResult =
  | { ok: true; status: "confirmed" | "superseded"; warning?: string }
  | { ok: false; error: string };

export async function confirmAiDispositionReview(
  reviewId: string,
): Promise<ConfirmAiDispositionReviewResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  try {
    await assertMessagesWorkspaceAccess();
  } catch {
    return { ok: false, error: "Messages workspace access is unavailable" };
  }

  const { data, error } = await supabase.rpc(
    "fn_confirm_ai_disposition_review",
    { p_review_id: reviewId },
  );
  if (error) return { ok: false, error: error.message };

  const status = readReviewResolutionStatus(data);
  if (!status) {
    reportError(new Error("Unexpected AI disposition confirmation response"), {
      tags: { surface: "confirm_ai_disposition_review" },
      extra: { reviewId, response: data },
    });
    return { ok: false, error: "Could not confirm Sandra's disposition" };
  }

  // The RPC only flips contacts.sms_opted_out; run full phone-level
  // suppression for a confirmed opted_out/dnc review. Idempotent, so the
  // user can retry after a warning.
  let warning: string | undefined;
  if (status === "confirmed") {
    const suppression = await applySuppressionForConfirmedReview(
      supabase as never,
      reviewId,
      user.id,
    );
    if (!suppression.ok) warning = suppression.warning;
  }

  try {
    revalidatePath("/messages");
  } catch (revalidateError) {
    reportError(revalidateError, {
      tags: { surface: "confirm_ai_disposition_review_revalidate" },
      extra: { reviewId, status },
    });
  }
  return warning ? { ok: true, status, warning } : { ok: true, status };
}

function readReviewResolutionStatus(
  value: unknown,
): "confirmed" | "superseded" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return status === "confirmed" || status === "superseded" ? status : null;
}

export async function setOutreachDispo(
  propertyId: string,
  dispo: OutreachDispo,
): Promise<SetDispoResult> {
  const denied = await denyWithoutMessagesAccess();
  if (denied) return denied;
  return saveOutreachDispo(propertyId, dispo);
}

/** Inbox and lead-page drip pickers share this guarded outcome-and-enrollment action. */
export async function setInboxDispoAndStartDrip(
  propertyId: string,
  dispo: "needs_sequence",
  sequenceId: string,
): Promise<SetDispoResult> {
  if (!sequenceId) return { ok: false, error: "Choose a follow-up drip." };
  const denied = await denyWithoutMessagesAccess();
  if (denied) return denied;
  return saveOutreachDispo(propertyId, dispo, sequenceId);
}

async function denyWithoutMessagesAccess(): Promise<SetDispoResult | null> {
  try {
    await assertMessagesWorkspaceAccess();
    return null;
  } catch (error) {
    if (!(error instanceof MessagesWorkspaceAccessError)) {
      reportError(error, { tags: { surface: "outreach_dispo_workspace_access" } });
    }
    // Fail closed with the existing access message so the client toasts
    // instead of surfacing an unhandled server-action rejection.
    return { ok: false, error: new MessagesWorkspaceAccessError().message };
  }
}

export type MoveMessageThreadToLeadResult =
  | { ok: true; alreadyQualified: boolean }
  | { ok: false; error: string };

export async function moveMessageThreadToLead(
  propertyId: string,
): Promise<MoveMessageThreadToLeadResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Not signed in" };
  }

  try {
    await assertMessagesWorkspaceAccess();
    await assertNotTrainingTarget(supabase, { propertyId });
    const outcome = await qualifyProperty(supabase, propertyId, user.id);
    switch (outcome.status) {
      case "qualified":
        revalidatePath("/messages");
        revalidatePath("/leads");
        revalidatePath(`/leads/${propertyId}`);
        revalidatePath("/properties");
        return { ok: true, alreadyQualified: false };
      case "already_qualified":
        revalidatePath("/messages");
        revalidatePath(`/leads/${propertyId}`);
        return { ok: true, alreadyQualified: true };
      case "not_found":
        return { ok: false, error: "Property not found" };
      case "failed":
        return { ok: false, error: outcome.message };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "move_message_thread_to_lead" },
      extra: { propertyId },
    });
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not move to lead",
    };
  }
}
