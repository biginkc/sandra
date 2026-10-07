"use server";

import { revalidatePath } from "next/cache";

import { sendHumanDraft } from "@/lib/ai-responder/dispatch";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import type { TeamMember } from "@/lib/auth/team-member";
import { err, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { recordLeadEvent } from "@/lib/events";
import { recordStep, resumeRun } from "@/lib/pipeline-runs";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { listPropertyOrgUsers, updateLeadAssignee } from "../leads/actions";
import { messagesV2OrgId } from "./access";
import {
  assignHold,
  dismissHold,
  editAndSendHeldDraft,
  sendHeldDraft,
  takeOverHold,
  type HoldActionDeps,
} from "./hold-actions";

/**
 * Server actions behind the Messages v2 holds rail. Every action resolves the
 * caller and their org on the server (owner || acquisitions, the same gate as
 * the page); nothing about who or where comes from the client.
 */

async function authorize(): Promise<Result<HoldActionDeps>> {
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) {
    return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
  }
  let orgId: string | null = null;
  try {
    // Only this user's own memberships count.
    const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === userId);
    orgId = messagesV2OrgId(memberships);
  } catch {
    orgId = null;
  }
  if (!orgId) {
    return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  }
  return {
    ok: true,
    data: {
      admin: createAdminClient(),
      orgId,
      userId,
      sendHumanDraft,
      recordLeadEvent,
      resumeRun,
      recordStep,
      updateLeadAssignee,
      reportError,
    },
  };
}

async function run<T>(action: (deps: HoldActionDeps) => Promise<Result<T>>): Promise<Result<T>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  try {
    const result = await action(auth.data);
    if (result.ok) revalidatePath("/messages-v2");
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_hold_action" } });
    return err({ code: "HOLD_ACTION_FAILED", message: "That action failed. Nothing may have been changed; refresh and check." });
  }
}

export async function sendHeldDraftAction(input: { draftId: string }) {
  return run((d) => sendHeldDraft(d, { draftId: String(input.draftId) }));
}

export async function editAndSendHeldDraftAction(input: { draftId: string; body: string }) {
  return run((d) => editAndSendHeldDraft(d, { draftId: String(input.draftId), body: String(input.body ?? "") }));
}

export async function takeOverHoldAction(input: { propertyId: string }) {
  return run((d) => takeOverHold(d, { propertyId: String(input.propertyId) }));
}

export async function dismissHoldAction(input: { propertyId: string; reason: string }) {
  return run((d) => dismissHold(d, { propertyId: String(input.propertyId), reason: String(input.reason ?? "") }));
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
