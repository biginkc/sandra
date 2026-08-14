"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import {
  requireOrgMembership,
  requireOrgMembershipByResource,
} from "@/lib/auth/require-org-membership";
import { errFromUnknown, err, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { dispatchTaskAssigned } from "@/lib/notifications/dispatch";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
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
      /** Round 9: the PERSISTED linkage of the booked (or replayed-and-
       *  matched) task, straight from the RPC — never derived from the
       *  request. Every post-booking effect below must read these fields,
       *  not `input.propertyId`/`input.contactId`, so a duplicate response
       *  (even a legitimate one) can never be steered at a different
       *  record than the one the RPC actually booked/matched. */
      related_property_id: string | null;
      contact_id: string | null;
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
 * Org resolution shared by `bookAppointment` and `listBookingAssignees`
 * (Codex round 2, assignee-picker scoping): linked bookings derive org
 * from the resource; a personal block (no property, no contact — locked
 * decision #5) falls back to the caller's own single ACTIVE membership,
 * erroring explicitly on zero or multiple memberships rather than
 * guessing. Active-only (R2-2 hardening, Codex round 1): a stale/suspended
 * membership row must not count toward "which org" — without this filter,
 * a caller who is active in one org and merely has HISTORY (suspended,
 * expired, deletion-prepared) in another would see two rows and get a
 * spurious AMBIGUOUS_ORG, or worse, could resolve into an org they no
 * longer have access to. Same active-membership predicates as
 * hasActiveSandraAccess / getCallerMemberships, expressed as PostgREST
 * filters (mirrors updateMembershipRole in admin/users/actions.ts).
 */
async function resolveBookingOrgId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  user: { id: string },
  ctx: { propertyId?: string; contactId?: string },
): Promise<Result<string>> {
  if (ctx.propertyId) {
    const { orgId } = await requireOrgMembershipByResource(
      "properties",
      ctx.propertyId,
    );
    return ok(orgId);
  }
  if (ctx.contactId) {
    const { orgId } = await requireOrgMembershipByResource(
      "contacts",
      ctx.contactId,
    );
    return ok(orgId);
  }

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
  const { orgId } = await requireOrgMembership(memberships[0].org_id);
  return ok(orgId);
}

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
  /** Codex round 12 (finding 5): the reschedule popover reuses this same
   *  soft-overlap check, and the appointment being rescheduled hasn't
   *  moved yet — its own row still occupies its OLD due_at/end_at, which
   *  overlaps ANY target window that keeps or partially keeps the
   *  original time. Without excluding it, the row self-matches as a false
   *  conflict on every reschedule. Because the query is `.limit(1)`, an
   *  unexcluded self-match can also HIDE a genuine second conflicting
   *  appointment (the self-row wins the one row the query returns).
   *  Omitted (the book flow) applies no exclusion. */
  excludeTaskId?: string,
): Promise<Result<{ hasOverlap: boolean; conflictStartAt: string | null }>> {
  try {
    const supabase = await createClient();
    let query = supabase
      .from("tasks")
      .select("due_at")
      .eq("assignee_id", assigneeId)
      .eq("type", "appointment")
      .eq("status", "open")
      .lt("due_at", endUtc)
      .gt("end_at", startUtc);
    if (excludeTaskId) {
      query = query.neq("id", excludeTaskId);
    }
    const { data, error } = await query.limit(1).maybeSingle();
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

    const orgResult = await resolveBookingOrgId(supabase, user, {
      propertyId: input.propertyId,
      contactId: input.contactId,
    });
    if (!orgResult.ok) return orgResult;
    const orgId = orgResult.data;

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
    // (notification/Slack dispatch) are skipped: those already fired for
    // the original call, and a retry re-dispatching them would
    // double-notify the assignee for one appointment.
    const result: BookAppointmentResult = {
      taskId: data.task_id,
      alreadyQualified: data.already_qualified,
      chainId: data.calendar_chain_id,
      duplicate: data.duplicate,
    };

    // Round 9: every post-booking effect below reads the RPC's RETURNED
    // linkage, never `input.propertyId`/`input.contactId`. The RPC now
    // rejects an idempotency-key replay whose request disagrees with the
    // original booking on property/contact/assignee/time/title, so these
    // two are structurally guaranteed to match the task that was actually
    // booked (or matched) — but deriving effects from the request anyway
    // would still be the wrong layer to trust: a future bug in that guard,
    // or any other path that reaches this branch, must not be able to
    // pause enrollments or reveal UI state for a DIFFERENT property than
    // the one the persisted task is actually linked to.
    const linkedPropertyId = data.related_property_id ?? undefined;
    const linkedContactId = data.contact_id ?? undefined;

    // Single-owner rule for Google Calendar event creation: fn_book_appointment
    // already opened the task_calendar_mutations ledger row (phase='pending')
    // in the same transaction that created the task — that ledger row IS the
    // durable intent to create the calendar event, and PR 3's provider worker
    // is the only thing that executes it. This action must NOT also call
    // dispatchTaskCalendarEvent (the legacy fire-and-forget path used by
    // plain task creation) — doing so would give the event two independent
    // creators racing each other with no shared idempotency key. Slack/bell
    // notifications have no such ledger and keep firing here.
    if (input.assigneeId !== user.id && !result.duplicate) {
      const admin = createAdminClient();
      const prefs = await loadIntegrationPrefs(admin, input.assigneeId);
      const subjectLabel = linkedPropertyId
        ? await loadPropertyAddress(supabase, linkedPropertyId)
        : input.title;
      const deepLink = buildAppointmentDeepLink(linkedPropertyId, linkedContactId);
      after(async () => {
        await Promise.allSettled([
          dispatchTaskAssigned(supabase, {
            taskId: result.taskId,
            orgId,
            assigneeId: input.assigneeId,
            taskTitle: input.title,
            taskType: "appointment",
            dueAt: startUtc.toISOString(),
            propertyAddress: linkedPropertyId ? subjectLabel : null,
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
        ]);
      });
    }

    // Outbound suppression boundary (Codex round 2, critical): a booked
    // appointment is a human-owned outcome — pause every active sequence
    // enrollment on this property so a scheduled automated touch doesn't
    // land on someone who just booked. Best-effort: booking has already
    // succeeded (task + ledger row committed), so a pause failure must
    // never surface as a booking failure. The property-level dispo write
    // (outreach_dispo='booked_appointment', done inside the RPC) already
    // blocks the AI responder and sequence-tick sends going forward — this
    // additionally stops any enrollment that's already past its dispo
    // check and just waiting on next_run_at. Property-only: a personal
    // block / contact-only booking has no property-scoped enrollments to
    // pause. Gated + scoped on `linkedPropertyId` (RPC-returned), not
    // `input.propertyId` — round 9.
    if (linkedPropertyId) {
      try {
        await pausePropertyEnrollments(supabase, {
          propertyId: linkedPropertyId,
          reason: "appointment_booked",
          permanent: false,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "book_appointment_pause_enrollments" },
          extra: { propertyId: linkedPropertyId },
        });
      }
    }

    if (linkedPropertyId) revalidatePath(`/leads/${linkedPropertyId}`);
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

export type TeamMember = { id: string; email: string };

export type BookingAssigneeContext = {
  /** Property this booking is linked to, if any — mirrors BookAppointmentInput. */
  propertyId?: string;
  /** Contact this booking is linked to, if any (independent of property). */
  contactId?: string;
};

type AuthUserPageUser = { id: string; email?: string | null };

async function listAllAuthUsers(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Result<AuthUserPageUser[]>> {
  const users: AuthUserPageUser[] = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      return err({ code: "TEAM_FETCH_FAILED", message: error.message });
    }
    users.push(...((data?.users ?? []) as AuthUserPageUser[]));
    if (!data?.nextPage || data.users.length === 0) break;
    page = data.nextPage;
  }

  return ok(users);
}

/**
 * Assignee picker for the booking popover (Codex round 2 — the popover
 * previously reused `leads/actions.ts`'s `listOrgUsers`, which unions
 * every org the caller has EVER belonged to — including stale/suspended
 * memberships — and lists every member of ALL of those orgs, including
 * inactive ones. A multi-org caller could see (and pick) a member from
 * the WRONG org, and every caller could pick an inactive teammate whose
 * membership would immediately fail `fn_book_appointment`'s own
 * assignee-membership check.
 *
 * This scopes to exactly one org — resolved the same way `bookAppointment`
 * resolves the org it books into (`resolveBookingOrgId`: linked resource,
 * or the caller's single active membership for a personal block) — and
 * returns only members with an ACTIVE, non-deletion-prepared,
 * non-expired membership in THAT org.
 */
export async function listBookingAssignees(
  ctx: BookingAssigneeContext,
): Promise<Result<TeamMember[]>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
    }

    const orgResult = await resolveBookingOrgId(supabase, user, ctx);
    if (!orgResult.ok) return orgResult;

    const admin = createAdminClient();
    const activeAt = new Date().toISOString();
    const { data: orgMemberships, error: orgMembershipsError } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgResult.data)
      .eq("access_status", "active")
      .is("deletion_prepared_at", null)
      .or(`access_expires_at.is.null,access_expires_at.gt.${activeAt}`);
    if (orgMembershipsError) {
      return err({ code: "TEAM_FETCH_FAILED", message: orgMembershipsError.message });
    }

    const memberIds = new Set((orgMemberships ?? []).map((m) => m.user_id));
    if (memberIds.size === 0) return ok([]);

    const users = await listAllAuthUsers(admin);
    if (!users.ok) return users;
    const members: TeamMember[] = users.data
      .filter((u) => memberIds.has(u.id) && !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return ok(members);
  } catch (e) {
    reportError(e, { tags: { surface: "list_booking_assignees" }, extra: ctx });
    return errFromUnknown(e, "TEAM_FETCH_FAILED");
  }
}
