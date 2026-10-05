"use server";

import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { assertPropertyDncUnlocked } from "@/lib/dnc/property-lock";
import { errFromUnknown, err, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { createNextStep } from "@/lib/next-steps";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** The two next-step kinds a lead page can create: an appointment (phone by default) or a task. */
export type LeadTaskKind = "appointment" | "task";

export type LeadTaskInput = {
  kind: LeadTaskKind;
  dueAt: string;
  assigneeId: string;
  /** Required for a task; an appointment defaults to "Call <address>". */
  title?: string;
  /** Appointment only, default "phone". */
  mode?: "phone" | "in_person";
  /** In-person only (phone is fixed at 15 minutes). */
  durationMinutes?: number;
  location?: string;
  note?: string;
};

export type LeadTaskResult = {
  id: string;
  kind: LeadTaskKind;
  mode: "phone" | "in_person";
  calendarChainId: string | null;
};

/**
 * Lead-page "add a next step" action. Writes through `createNextStep` (the shared write function
 * also sends the assignment notifications; a phone appointment has no calendar event). The legacy
 * follow-up/callback writer and its deploy-before-migration fallback were retired in P1a-retire.
 */
export async function createLeadTaskAction(
  propertyId: string,
  input: LeadTaskInput,
): Promise<Result<LeadTaskResult>> {
  if (input.kind !== "appointment" && input.kind !== "task") {
    return err({ code: "INVALID_TASK_TYPE", message: "Choose appointment or task." });
  }
  if (input.kind === "task" && !input.title?.trim()) {
    return err({ code: "TITLE_REQUIRED", message: "Give the task a title." });
  }
  if (!input.dueAt || Number.isNaN(new Date(input.dueAt).getTime())) {
    return err({ code: "INVALID_DUE_AT", message: "Choose a valid due date." });
  }
  if (!input.assigneeId) {
    return err({ code: "ASSIGNEE_REQUIRED", message: "Choose who owns this task." });
  }

  try {
    const supabase = await createClient();
    await assertNotTrainingTarget(supabase, { propertyId });
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });

    const { data: property, error: propertyErr } = await supabase
      .from("properties")
      .select("id, org_id, address")
      .eq("id", propertyId)
      .maybeSingle();
    if (propertyErr) return err({ code: "LEAD_FETCH_FAILED", message: propertyErr.message });
    if (!property) return err({ code: "LEAD_NOT_FOUND", message: "Lead not found." });

    const { data: actorMembership, error: actorMembershipErr } = await supabase
      .from("memberships")
      .select("user_id, access_status, access_expires_at, deletion_prepared_at")
      .eq("org_id", property.org_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (actorMembershipErr) {
      return err({ code: "MEMBERSHIP_LOOKUP_FAILED", message: actorMembershipErr.message });
    }
    if (!actorMembership || !hasActiveSandraAccess(actorMembership)) {
      return err({
        code: "LEAD_FORBIDDEN",
        message: "You do not have access to this lead's org.",
      });
    }

    const admin = createAdminClient();
    const { data: assignee, error: assigneeErr } = await admin
      .from("memberships")
      .select("user_id, access_status, access_expires_at, deletion_prepared_at")
      .eq("org_id", property.org_id)
      .eq("user_id", input.assigneeId)
      .maybeSingle();
    if (assigneeErr) return err({ code: "ASSIGNEE_LOOKUP_FAILED", message: assigneeErr.message });
    if (!assignee || !hasActiveSandraAccess(assignee)) {
      return err({
        code: assignee ? "ASSIGNEE_NOT_ACTIVE" : "ASSIGNEE_NOT_IN_ORG",
        message: assignee
          ? "Choose an active team member in this lead's organization."
          : "Choose a team member in this lead's organization.",
      });
    }

    const title =
      input.kind === "task"
        ? input.title!.trim()
        : input.title?.trim() || `Call ${property.address}`;
    const created = await createNextStep({
      kind: input.kind,
      assigneeId: input.assigneeId,
      title,
      dueAt: input.dueAt,
      propertyId: property.id,
      mode: input.kind === "appointment" ? (input.mode ?? "phone") : undefined,
      durationMinutes: input.durationMinutes,
      location: input.location,
      note: input.note,
      origin: "app",
    });
    if (!created.ok) return created;
    return ok({
      id: created.data.taskId,
      kind: created.data.kind,
      mode: created.data.mode,
      calendarChainId: created.data.calendarChainId,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_lead_task" },
      extra: { propertyId, kind: input.kind },
    });
    return errFromUnknown(e, "TASK_CREATE_FAILED");
  }
}
