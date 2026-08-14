"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import {
  requireOrgMembership,
  requireOrgMembershipByResource,
} from "@/lib/auth/require-org-membership";
import { errFromUnknown, err, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { dispatchTaskCalendarEvent } from "@/lib/integrations/google/dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { dispatchTaskAssigned } from "@/lib/notifications/dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { wallTimeToUtc } from "@/lib/time/zoned";

export type BookAppointmentInput = {
  /** Property this appointment is linked to, if any. */
  propertyId?: string;
  /** Contact this appointment is linked to, if any — independent of
   *  property; a Messages thread with no linked property can still book. */
  contactId?: string;
  assigneeId: string;
  /** YYYY-MM-DD, wall-clock date in `timeZone`. */
  date: string;
  /** HH:mm, wall-clock time in `timeZone`. */
  time: string;
  /** IANA zone — MUST be the value `getMemberTimezone` returned for
   *  `assigneeId`; the RPC rejects a caller-supplied zone that disagrees
   *  with the assignee's authoritative preference. */
  timeZone: string;
  durationMinutes: number;
  title: string;
  note?: string;
  /** One UUID minted per popover open (crypto.randomUUID), reused across
   *  every submit attempt for that same booking so a retry after a
   *  dropped response can't create a second appointment — the RPC
   *  recognizes the repeat key and returns the original booking with
   *  `duplicate: true` instead of inserting again. Optional: callers that
   *  don't supply one simply get no idempotency protection. */
  idempotencyKey?: string;
};

export type BookAppointmentResult = {
  taskId: string;
  alreadyQualified: boolean;
  chainId: string;
  /** True when this call resolved to an existing booking (same
   *  idempotency key as a prior successful call) rather than creating a
   *  new task — a same-key retry, not a fresh booking. */
  duplicate: boolean;
};

/**
 * Hand-rolled RPC surface for the two appointment functions, same pattern
 * as `CampaignCadenceRpcClient` in `campaigns/actions.ts`. Both functions
 * are migrated by a separate lane (PR2's RPC track, `supabase/migrations/**`
 * — not owned here); the generated `Database["public"]["Functions"]` union
 * won't include them until that migration lands and types regenerate, so
 * the call surface is typed locally instead of widening the shared
 * generated file out from under that lane.
 */
type AppointmentRpcClient = {
  rpc(
    fn: "fn_book_appointment",
    args: {
      p_org: string;
      p_assignee: string;
      p_start: string;
      p_end: string;
      p_timezone: string;
      p_contact: string | null;
      p_property: string | null;
      p_title: string;
      p_description: string | null;
      p_idempotency_key: string | null;
    },
  ): PromiseLike<{
    data: {
      task_id: string;
      already_qualified: boolean;
      calendar_chain_id: string;
      duplicate: boolean;
    } | null;
    error: { message: string; code?: string } | null;
  }>;
  rpc(
    fn: "fn_get_member_timezone",
    args: { p_user: string },
  ): PromiseLike<{ data: string | null; error: { message: string } | null }>;
};

const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 24 * 60;
const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Looks up a teammate's authoritative reminder/calendar timezone through
 * the SECURITY DEFINER `fn_get_member_timezone` RPC — `user_integration_prefs`
 * RLS is self-only, so a direct table read from the booking user silently
 * returns nothing for anyone but themselves. The booking form displays
 * this value ("Times in Central Time (America/Chicago)") and submits it
 * back unchanged; the booking RPC re-validates it server-side.
 */
export async function getMemberTimezone(userId: string): Promise<Result<string>> {
  try {
    const supabase = (await createClient()) as unknown as AppointmentRpcClient;
    const { data, error } = await supabase.rpc("fn_get_member_timezone", {
      p_user: userId,
    });
    if (error) {
      return err({ code: "TIMEZONE_LOOKUP_FAILED", message: error.message });
    }
    return ok(data ?? DEFAULT_TIMEZONE);
  } catch (e) {
    reportError(e, {
      tags: { surface: "get_member_timezone" },
      extra: { userId },
    });
    return errFromUnknown(e, "TIMEZONE_LOOKUP_FAILED");
  }
}

/**
 * Soft double-book check (locked product decision #7 — warn, never block).
 * Reads through `idx_tasks_appointment_overlap`
 * (org, assignee, due_at WHERE type='appointment' AND status='open');
 * membership RLS already scopes rows to orgs the caller belongs to, so no
 * explicit org filter is needed here.
 */
export async function checkAppointmentOverlap(
  assigneeId: string,
  startUtc: string,
  endUtc: string,
): Promise<Result<{ hasOverlap: boolean; conflictStartAt: string | null }>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tasks")
      .select("due_at")
      .eq("assignee_id", assigneeId)
      .eq("type", "appointment")
      .eq("status", "open")
      .lt("due_at", endUtc)
      .gt("end_at", startUtc)
      .limit(1)
      .maybeSingle();
    if (error) {
      return err({ code: "OVERLAP_CHECK_FAILED", message: error.message });
    }
    return ok({
      hasOverlap: Boolean(data),
      conflictStartAt: data?.due_at ?? null,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "check_appointment_overlap" },
      extra: { assigneeId },
    });
    return errFromUnknown(e, "OVERLAP_CHECK_FAILED");
  }
}

/**
 * Books an appointment: converts the submitted wall time server-side
 * (never trusts a client-computed Date — R2-7/R3-5), resolves the booking
 * org from the linked resource (or the caller's single active membership
 * for a personal block), calls the atomic `fn_book_appointment` RPC, and
 * fires the same best-effort assignment side effects as
 * `createLeadTaskAction` (leads/actions.ts:1337+) — admin-loaded prefs so a
 * cross-user assignment doesn't fall back to Chicago/all-channels under
 * self-only prefs RLS, dispatched in `after()` so a Slack/Google hiccup
 * never rolls back the booking itself.
 */
export async function bookAppointment(
  input: BookAppointmentInput,
): Promise<Result<BookAppointmentResult>> {
  if (!input.assigneeId) {
    return err({
      code: "ASSIGNEE_REQUIRED",
      message: "Choose who this appointment is for.",
    });
  }
  if (!input.title.trim()) {
    return err({ code: "TITLE_REQUIRED", message: "Give the appointment a title." });
  }
  if (
    !Number.isFinite(input.durationMinutes) ||
    input.durationMinutes < MIN_DURATION_MINUTES ||
    input.durationMinutes > MAX_DURATION_MINUTES
  ) {
    return err({ code: "INVALID_DURATION", message: "Choose a valid duration." });
  }

  const converted = wallTimeToUtc({
    date: input.date,
    time: input.time,
    timeZone: input.timeZone,
  });
  if (!converted.ok) {
    return err({
      code: converted.reason === "nonexistent" ? "TIME_NONEXISTENT" : "TIME_INVALID",
      message:
        converted.reason === "nonexistent"
          ? "That time doesn't exist in this timezone because of a daylight-saving change — pick another."
          : "Choose a valid date and time.",
    });
  }
  const startUtc = converted.utc;
  const endUtc = new Date(startUtc.getTime() + input.durationMinutes * 60_000);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
    }

    // Org resolution (R2-2): linked bookings derive org from the resource;
    // a personal block (no property, no contact — locked decision #5)
    // falls back to the caller's own single active membership, erroring
    // explicitly on zero or multiple memberships rather than guessing.
    let orgId: string;
    if (input.propertyId) {
      orgId = (
        await requireOrgMembershipByResource("properties", input.propertyId)
      ).orgId;
    } else if (input.contactId) {
      orgId = (
        await requireOrgMembershipByResource("contacts", input.contactId)
      ).orgId;
    } else {
      // Active-only (R2-2 hardening, Codex round 1): a stale/suspended
      // membership row must not count toward "which org do I book into" —
      // without this filter, a caller who is active in one org and merely
      // has HISTORY (suspended, expired, deletion-prepared) in another
      // would see two rows and get a spurious AMBIGUOUS_ORG, or worse,
      // could resolve into an org they no longer have access to. Same
      // active-membership predicates as hasActiveSandraAccess /
      // getCallerMemberships, expressed as PostgREST filters (mirrors
      // updateMembershipRole in admin/users/actions.ts).
      const activeAt = new Date().toISOString();
      const { data: memberships, error: membershipErr } = await supabase
        .from("memberships")
        .select("org_id")
        .eq("user_id", user.id)
        .eq("access_status", "active")
        .is("deletion_prepared_at", null)
        .or(`access_expires_at.is.null,access_expires_at.gt.${activeAt}`);
      if (membershipErr) {
        return err({
          code: "MEMBERSHIP_LOOKUP_FAILED",
          message: membershipErr.message,
        });
      }
      if (!memberships || memberships.length !== 1) {
        return err({
          code: "AMBIGUOUS_ORG",
          message:
            memberships && memberships.length > 1
              ? "You belong to more than one org — book from a linked lead or contact instead."
              : "You don't belong to an org.",
        });
      }
      orgId = (await requireOrgMembership(memberships[0].org_id)).orgId;
    }

    const rpcClient = supabase as unknown as AppointmentRpcClient;
    const { data, error } = await rpcClient.rpc("fn_book_appointment", {
      p_org: orgId,
      p_assignee: input.assigneeId,
      p_start: startUtc.toISOString(),
      p_end: endUtc.toISOString(),
      p_timezone: input.timeZone,
      p_contact: input.contactId ?? null,
      p_property: input.propertyId ?? null,
      p_title: input.title,
      p_description: input.note?.trim() || null,
      p_idempotency_key: input.idempotencyKey ?? null,
    });
    if (error || !data) {
      return err({
        code: "BOOK_APPOINTMENT_FAILED",
        message: error?.message ?? "Could not book the appointment.",
      });
    }

    // A duplicate (same idempotency key as a prior successful call) is a
    // SUCCESS, not an error — it's the RPC recognizing a retry and handing
    // back the original booking rather than a fresh one. Treated exactly
    // like a fresh booking below, except the assignment side effects
    // (notification/Slack/calendar-event dispatch) are skipped: those
    // already fired for the original call, and a retry re-dispatching them
    // would double-notify the assignee for one appointment.
    const result: BookAppointmentResult = {
      taskId: data.task_id,
      alreadyQualified: data.already_qualified,
      chainId: data.calendar_chain_id,
      duplicate: data.duplicate,
    };

    if (input.assigneeId !== user.id && !result.duplicate) {
      const admin = createAdminClient();
      const prefs = await loadIntegrationPrefs(admin, input.assigneeId);
      const subjectLabel = input.propertyId
        ? await loadPropertyAddress(supabase, input.propertyId)
        : input.title;
      const deepLink = buildAppointmentDeepLink(input.propertyId, input.contactId);
      after(async () => {
        await Promise.allSettled([
          dispatchTaskAssigned(supabase, {
            taskId: result.taskId,
            orgId,
            assigneeId: input.assigneeId,
            taskTitle: input.title,
            taskType: "appointment",
            dueAt: startUtc.toISOString(),
            propertyAddress: input.propertyId ? subjectLabel : null,
          }),
          dispatchTaskAssignedSlack({
            taskId: result.taskId,
            assigneeId: input.assigneeId,
            taskTitle: input.title,
            taskType: "appointment",
            dueAt: startUtc.toISOString(),
            propertyAddress: subjectLabel,
            deepLink,
            timezone: prefs.timezone,
            slackEnabled: prefs.slackEnabled,
          }),
          dispatchTaskCalendarEvent({
            taskId: result.taskId,
            assigneeId: input.assigneeId,
            taskTitle: input.title,
            propertyAddress: subjectLabel,
            dueAt: startUtc.toISOString(),
            endAt: endUtc.toISOString(),
            timezone: prefs.timezone,
            deepLink,
            calendarEnabled: prefs.calendarEnabled,
          }),
        ]);
      });
    }

    if (input.propertyId) revalidatePath(`/leads/${input.propertyId}`);
    revalidatePath("/messages");
    revalidatePath("/dashboard");

    return ok(result);
  } catch (e) {
    reportError(e, {
      tags: { surface: "book_appointment" },
      extra: { propertyId: input.propertyId, contactId: input.contactId },
    });
    return errFromUnknown(e, "BOOK_APPOINTMENT_FAILED");
  }
}

async function loadPropertyAddress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
): Promise<string> {
  const { data } = await supabase
    .from("properties")
    .select("address")
    .eq("id", propertyId)
    .maybeSingle();
  return data?.address ?? "Appointment";
}

function buildAppointmentDeepLink(propertyId?: string, contactId?: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  if (propertyId) return `${normalizedBaseUrl}/leads/${propertyId}`;
  if (contactId) return `${normalizedBaseUrl}/messages?thread=${contactId}`;
  return `${normalizedBaseUrl}/dashboard`;
}
