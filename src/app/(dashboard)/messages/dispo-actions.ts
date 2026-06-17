"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { recordConsentEvent } from "@/lib/messaging/consent";
import { reportError } from "@/lib/errors/report";
import { dispatchTaskCalendarEvent } from "@/lib/integrations/google/dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { dispatchTaskAssigned } from "@/lib/notifications/dispatch";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import { createClient } from "@/lib/supabase/server";
import { createTask, dispoToTaskType } from "@/lib/tasks";

export type OutreachDispo =
  | "wrong_number"
  | "bad_number"
  | "not_interested"
  | "opted_out"
  | "dnc"
  | "nurture"
  | "callback_requested";

const VALID_DISPOS: ReadonlySet<string> = new Set<OutreachDispo>([
  "wrong_number",
  "bad_number",
  "not_interested",
  "opted_out",
  "dnc",
  "nurture",
  "callback_requested",
]);

/** Dispos that require follow_up_at to be set. */
const REQUIRES_FOLLOW_UP: ReadonlySet<OutreachDispo> = new Set([
  "nurture",
  "callback_requested",
]);

/** Dispos that also trigger TCPA opt-out (consent_events + sms_opted_out). */
const TRIGGERS_OPT_OUT: ReadonlySet<OutreachDispo> = new Set([
  "dnc",
  "opted_out",
]);

export type SetDispoResult =
  | { ok: true }
  | { ok: false; error: string };

export async function setOutreachDispo(
  propertyId: string,
  dispo: OutreachDispo,
  followUpAt?: string | null,
  /** Required only for REQUIRES_FOLLOW_UP dispos — the user the follow-up
   *  task is assigned to. Defaults to the acting user when omitted. */
  assigneeId?: string | null,
): Promise<SetDispoResult> {
  if (!VALID_DISPOS.has(dispo)) {
    return { ok: false, error: `Unknown dispo: ${dispo}` };
  }
  if (REQUIRES_FOLLOW_UP.has(dispo) && !followUpAt) {
    return { ok: false, error: `${dispo} requires a follow-up date` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Not signed in" };
  }

  const { data: prop, error: propErr } = await supabase
    .from("properties")
    .select("id, org_id, address, homeowner_contact_id")
    .eq("id", propertyId)
    .is("deleted_at", null)
    .maybeSingle();

  if (propErr || !prop) {
    return { ok: false, error: propErr?.message ?? "Property not found" };
  }

  const { error: updateErr } = await supabase
    .from("properties")
    .update({
      outreach_dispo: dispo,
      follow_up_at: followUpAt ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", propertyId)
    .is("deleted_at", null);

  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  // Follow-up dispos create a task row. follow_up_at on properties stays
  // for one release as a denormalized convenience for the UI; the task
  // row is the new source of truth (read by the dashboard panel).
  if (REQUIRES_FOLLOW_UP.has(dispo) && followUpAt) {
    const taskType = dispoToTaskType(dispo as "nurture" | "callback_requested");
    const resolvedAssignee = assigneeId ?? user.id;
    const taskTitle =
      taskType === "callback"
        ? `Callback ${prop.address}`
        : `Follow up on ${prop.address}`;

    const taskResult = await createTask(supabase, {
      orgId: prop.org_id,
      assigneeId: resolvedAssignee,
      relatedPropertyId: prop.id,
      type: taskType,
      title: taskTitle,
      dueAt: followUpAt,
      createdBy: user.id,
    });

    if (!taskResult.ok) {
      // Don't fail the dispo write — the dispo and follow_up_at are
      // already persisted. Log so the gap is visible.
      reportError(new Error(taskResult.error.message), {
        tags: { surface: "dispo_create_task" },
        extra: { propertyId, dispo, taskCode: taskResult.error.code },
      });
    } else if (resolvedAssignee !== user.id) {
      // Notify the assignee — never notify yourself for self-assigned tasks.
      const prefs = await loadIntegrationPrefs(supabase, resolvedAssignee);
      const deepLink = buildTaskDeepLink(prop.id);
      after(async () => {
        await Promise.allSettled([
          dispatchTaskAssigned(supabase, {
            taskId: taskResult.data.id,
            orgId: prop.org_id,
            assigneeId: resolvedAssignee,
            taskTitle,
            taskType,
            dueAt: followUpAt,
            propertyAddress: prop.address,
          }),
          dispatchTaskAssignedSlack({
            taskId: taskResult.data.id,
            assigneeId: resolvedAssignee,
            taskTitle,
            taskType,
            dueAt: followUpAt,
            propertyAddress: prop.address,
            deepLink,
            timezone: prefs.timezone,
            slackEnabled: prefs.slackEnabled,
          }),
          dispatchTaskCalendarEvent({
            taskId: taskResult.data.id,
            assigneeId: resolvedAssignee,
            taskTitle,
            propertyAddress: prop.address,
            dueAt: followUpAt,
            timezone: prefs.timezone,
            deepLink,
            calendarEnabled: prefs.calendarEnabled,
          }),
        ]);
      });
    }
  }

  // TCPA suppression — fire consent event + flip boolean + pause enrollments.
  if (TRIGGERS_OPT_OUT.has(dispo) && prop.homeowner_contact_id) {
    const contactId = prop.homeowner_contact_id;
    await recordConsentEvent(supabase, {
      contactId,
      channel: "sms",
      eventType: "opt_out",
      source: "manual_dispo",
      sourceDetail: { propertyId, dispo },
      occurredAt: new Date(),
    });
    await supabase
      .from("contacts")
      .update({
        sms_opted_out: true,
        sms_opted_out_at: new Date().toISOString(),
      })
      .eq("id", contactId);
    await pauseContactEnrollments(supabase, {
      contactId,
      reason: "consent_revoked",
      permanent: true,
    });
  }

  revalidatePath("/messages");
  revalidatePath("/properties");

  return { ok: true };
}

function buildTaskDeepLink(propertyId: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  return `${normalizedBaseUrl}/messages?property_id=${propertyId}`;
}
