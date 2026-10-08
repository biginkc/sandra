"use server";

import { revalidatePath } from "next/cache";

import { sendHumanDraft } from "@/lib/ai-responder/dispatch";
import { resolveApprovedTemplateReply } from "@/lib/ai-responder/template-reply";
import { undoJevAction as undoJevActionCore } from "@/lib/ai-responder/undo";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import type { TeamMember } from "@/lib/auth/team-member";
import { err, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { recordLeadEvent } from "@/lib/events";
import { recordStep, resumeRun } from "@/lib/pipeline-runs";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { retrySuppressionForProperty } from "../leads/[id]/ai-actions";
import { listPropertyOrgUsers, updateLeadAssignee } from "../leads/actions";
import { authorizeMessagesV2 } from "./authorize";
import type { SeenDraft } from "./hold-action-types";
import {
  assignHold,
  confirmDoNotContact,
  dismissHold,
  editAndSendHeldDraft,
  sendHeldDraft,
  takeOverHold,
  type HoldActionDeps,
} from "./hold-actions";
import { setReplyGeneration, type ReplyGeneration, type ReplyGenerationSetting } from "./reply-generation";
import type { HoldSeen } from "./types";

/**
 * Server actions behind the Messages v2 holds rail. Every action resolves the
 * caller and their org on the server (owner || acquisitions, the same gate as
 * the page); nothing about who or where comes from the client.
 */

async function authorize(): Promise<Result<HoldActionDeps>> {
  const auth = await authorizeMessagesV2();
  if (!auth.ok) return auth;
  const { orgId, userId } = auth.data;
  const admin = createAdminClient();
  return {
    ok: true,
    data: {
      admin,
      orgId,
      userId,
      suppressNumber: async ({ propertyId, contactId, phone, inboundMessageId }) => {
        try {
          // The existing human suppression path: phone-level suppression,
          // opt-out consent event, contact flag, contact enrollments ended.
          await applyPhoneLevelOptOut(admin, {
            contactId,
            fromPhone: phone,
            orgId,
            source: "human_confirmed_hostile",
            sourceDetail: { propertyId, reason: "hostile_needs_confirm", confirmedBy: userId },
            occurredAt: new Date(),
            providerId: "messages_v2",
            surface: "dnc",
            idempotencyKey: `human-hostile:${propertyId}:${contactId}`,
            leadEvent: { propertyId, actorType: "user", actorId: userId, trigger: "human_confirmed_hostile" },
          });
          await pausePropertyEnrollments(admin, {
            propertyId,
            reason: "consent_revoked",
            permanent: true,
            actor: { actorType: "user", actorId: userId },
          });
          return { ok: true, data: null };
        } catch (e) {
          reportError(e, { tags: { surface: "messages_v2_confirm_dnc_suppression" }, extra: { propertyId } });
          return err({ code: "SUPPRESSION_FAILED", message: "Suppression failed" });
        }
      },
      resolveHostileReply: async ({ propertyId, contactId }) => {
        const resolved = await resolveApprovedTemplateReply(admin, {
          orgId,
          propertyId,
          contactId,
          outcome: "hostile",
          outcomeConfidence: null,
          escalationReason: null,
        });
        return resolved.kind === "template" ? resolved.body : null;
      },
      sendHumanDraft,
      recordLeadEvent,
      resumeRun,
      recordStep,
      updateLeadAssignee,
      reportError,
    },
  };
}

const RELOAD_CODES = new Set(["DRAFT_CHANGED", "HOLD_STALE", "DRAFT_NOT_PENDING"]);

const seenDraft = (v: SeenDraft | undefined): SeenDraft => ({
  body: String(v?.body ?? ""),
  editedAt: v?.editedAt == null ? null : String(v.editedAt),
});
const seenHold = (v: HoldSeen | undefined): HoldSeen => ({
  through: v?.through == null ? null : String(v.through),
  flagReason: v?.flagReason == null ? null : String(v.flagReason),
  flagAt: v?.flagAt == null ? null : String(v.flagAt),
});

async function run<T>(action: (deps: HoldActionDeps) => Promise<Result<T>>): Promise<Result<T>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  try {
    const result = await action(auth.data);
    // A changed card is reloaded from fresh data, so the refusal revalidates too.
    if (result.ok || RELOAD_CODES.has(result.error.code)) revalidatePath("/messages-v2");
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_hold_action" } });
    return err({ code: "HOLD_ACTION_FAILED", message: "That action failed. Nothing may have been changed; refresh and check." });
  }
}

export async function sendHeldDraftAction(input: { draftId: string; seen: SeenDraft }) {
  return run((d) => sendHeldDraft(d, { draftId: String(input.draftId), seen: seenDraft(input.seen) }));
}

export async function editAndSendHeldDraftAction(input: { draftId: string; body: string; seen: SeenDraft }) {
  return run((d) =>
    editAndSendHeldDraft(d, {
      draftId: String(input.draftId),
      body: String(input.body ?? ""),
      seen: seenDraft(input.seen),
    }),
  );
}

export async function takeOverHoldAction(input: { propertyId: string; seen: HoldSeen }) {
  return run((d) => takeOverHold(d, { propertyId: String(input.propertyId), seen: seenHold(input.seen) }));
}

/**
 * "Confirm do-not-contact" on a hostile hold: sends the approved hostile reply
 * (if any), then runs the human suppression path. Dismiss leaves the number active.
 */
export async function confirmDoNotContactAction(input: { propertyId: string; seen: HoldSeen }) {
  return run((d) => confirmDoNotContact(d, { propertyId: String(input.propertyId), seen: seenHold(input.seen) }));
}

export async function dismissHoldAction(input: { propertyId: string; reason: string; seen: HoldSeen }) {
  return run((d) =>
    dismissHold(d, {
      propertyId: String(input.propertyId),
      reason: String(input.reason ?? ""),
      seen: seenHold(input.seen),
    }),
  );
}

/**
 * Retry a failed opt-out/DNC suppression from the hold card. Same action the
 * lead banner uses; here it is gated by the Messages v2 access check first.
 */
export async function retrySuppressionHoldAction(input: { propertyId: string }) {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const result = await retrySuppressionForProperty(String(input.propertyId));
  if (result.ok) revalidatePath("/messages-v2");
  return result;
}

export async function assignHoldAction(input: { propertyId: string; assigneeId: string | null }) {
  return run((d) =>
    assignHold(d, {
      propertyId: String(input.propertyId),
      assigneeId: input.assigneeId === null ? null : String(input.assigneeId),
    }),
  );
}

/** Teammates the hold can be assigned to (the existing lead-assignee list). */
export async function listHoldAssigneesAction(input: {
  propertyId: string;
}): Promise<Result<TeamMember[]>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  return listPropertyOrgUsers(String(input.propertyId));
}

/**
 * Owner-only "AI drafts" switch. The caller's own session runs the RPC (it
 * needs auth.uid()); the database re-checks active-owner for the config's org.
 */
export async function setReplyGenerationAction(input: {
  configId: string;
  mode: ReplyGeneration;
}): Promise<Result<ReplyGenerationSetting>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  try {
    const supabase = await createClient();
    const result = await setReplyGeneration(
      supabase as unknown as Parameters<typeof setReplyGeneration>[0],
      { configId: String(input.configId), mode: String(input.mode) },
    );
    if (result.ok) revalidatePath("/messages-v2");
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_reply_generation" } });
    return err({ code: "SET_FAILED", message: "Could not change AI drafts. Nothing was changed." });
  }
}

/**
 * One-click undo for an action Jev auto-applied (wrong_number, not_interested,
 * nurture): restores the disposition and follow-up date and resumes the drips
 * that action paused. Refuses if a person changed the lead since.
 */
export async function undoJevAppliedAction(undoId: string): Promise<Result<{ resumed: number }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const id = String(undoId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return err({ code: "VALIDATION", message: "Invalid undo id" });
  }
  try {
    const supabase = await createClient();
    const result = await undoJevActionCore(supabase, id);
    if (!result.ok) return err({ code: result.code, message: result.message });
    revalidatePath("/messages-v2");
    return { ok: true, data: { resumed: result.resumed } };
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_undo_jev_action" }, extra: { undoId: id } });
    return err({ code: "FAILED", message: "Could not undo. Try again." });
  }
}

/** The still-undoable record for an inbound message's Jev action, or null. */
export async function findJevUndoAction(inboundMessageId: string): Promise<string | null> {
  const auth = await authorize();
  if (!auth.ok) return null;
  const id = String(inboundMessageId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("jev_action_undo")
      .select("id")
      .eq("source_inbound_message_id", id)
      .eq("org_id", auth.data.orgId)
      .is("undone_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.id ?? null;
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_find_jev_undo" }, extra: { inboundMessageId: id } });
    return null;
  }
}
