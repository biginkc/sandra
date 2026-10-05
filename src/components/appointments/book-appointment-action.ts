"use server";


import { loadOrgTeamMembers } from "@/lib/auth/team-roster";
export type { TeamMember } from "@/lib/auth/team-member";
import { errFromUnknown, err, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";
import { resolveBookingOrgId } from "@/lib/next-steps/org";

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
      ledger_id: string;
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

const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Looks up a teammate's authoritative reminder/calendar timezone through
 * the SECURITY DEFINER `fn_get_member_timezone` RPC — `user_integration_prefs`
 * RLS is self-only, so a direct table read from the booking user silently
 * returns nothing for anyone but themselves. The booking form displays
 * this value ("Times in Central Time (America/Chicago)") and submits it
 * back unchanged; the booking RPC re-validates it server-side.
 */
export async function getMemberTimezone(
  userId: string,
): Promise<Result<string>> {
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

export type BookingAssigneeContext = {
  /** Property this booking is linked to, if any — mirrors BookAppointmentInput. */
  propertyId?: string;
  /** Contact this booking is linked to, if any (independent of property). */
  contactId?: string;
};

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
): Promise<Result<import("@/lib/auth/team-member").TeamMember[]>> {
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

    return ok(await loadOrgTeamMembers(orgResult.data));
  } catch (e) {
    reportError(e, { tags: { surface: "list_booking_assignees" }, extra: ctx });
    return errFromUnknown(e, "TEAM_FETCH_FAILED");
  }
}
