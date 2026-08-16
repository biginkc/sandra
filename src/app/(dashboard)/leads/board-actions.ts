"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getDayBoundsInZone } from "@/lib/time/zoned";
import { STATUS_ORDER } from "./board-config";
import {
  fetchLeadBoardData,
  type LeadBoardCursor,
  type LeadBoardData,
  type LeadBoardFilters,
} from "./board-query";
import type { PropertyStatus } from "./actions";

export type LoadLeadBoardInput = {
  filters: LeadBoardFilters;
  cursor?: LeadBoardCursor | null;
  status?: PropertyStatus;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MOTIVATIONS = new Set(["all", "hot", "warm", "cold", "unset"]);
const URGENCIES = new Set(["all", "overdue", "today", "scheduled", "none"]);

function validFilters(filters: LeadBoardFilters): boolean {
  return (
    typeof filters.search === "string" &&
    filters.search.length <= 200 &&
    MOTIVATIONS.has(filters.motivation) &&
    URGENCIES.has(filters.urgency) &&
    (filters.ownership === "all" ||
      filters.ownership === "mine" ||
      filters.ownership === "unassigned" ||
      UUID.test(filters.ownership)) &&
    (filters.attention === null || filters.attention === "stale" || filters.attention === "sequence_ended") &&
    typeof filters.hotOnly === "boolean" &&
    typeof filters.noActiveSequence === "boolean" &&
    (filters.skipTraced === null || typeof filters.skipTraced === "boolean")
  );
}

export async function loadLeadBoardAction(
  input: LoadLeadBoardInput,
): Promise<Result<LeadBoardData>> {
  if (!validFilters(input.filters)) {
    return { ok: false, error: { code: "INVALID_LEAD_FILTER", message: "Choose valid lead filters." } };
  }
  if (input.status && !STATUS_ORDER.includes(input.status)) {
    return { ok: false, error: { code: "INVALID_LEAD_STAGE", message: "Choose a valid lead stage." } };
  }
  if (
    input.cursor &&
    (!UUID.test(input.cursor.id) ||
      (input.cursor.dueAt !== null && Number.isNaN(Date.parse(input.cursor.dueAt))))
  ) {
    return { ok: false, error: { code: "INVALID_LEAD_CURSOR", message: "Reload this lead column and try again." } };
  }
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };

    let assigneeId: string | null = null;
    let unassigned = false;
    if (input.filters.ownership === "mine") assigneeId = user.id;
    else if (input.filters.ownership === "unassigned") unassigned = true;
    else if (input.filters.ownership !== "all") {
      if (!UUID.test(input.filters.ownership)) {
        return { ok: false, error: { code: "INVALID_ASSIGNEE", message: "Choose a valid teammate." } };
      }
      const { data: actorMemberships, error: actorError } = await supabase
        .from("memberships").select("org_id").eq("user_id", user.id);
      if (actorError) throw actorError;
      const orgIds = (actorMemberships ?? []).map((row) => row.org_id);
      if (orgIds.length === 0) {
        return { ok: false, error: { code: "INVALID_ASSIGNEE", message: "Choose a teammate in your organization." } };
      }
      // memberships_self_select prevents ordinary members from reading a
      // teammate's membership through the cookie client. The admin lookup is
      // bounded to the actor's already-RLS-scoped org ids, matching the
      // existing listOrgUsers contract without weakening member behavior.
      const admin = createAdminClient();
      const { data: teammate, error: teammateError } = await admin
        .from("memberships")
        .select("user_id")
        .eq("user_id", input.filters.ownership)
        .in("org_id", orgIds)
        .limit(1)
        .maybeSingle();
      if (teammateError) throw teammateError;
      if (!teammate) {
        return { ok: false, error: { code: "INVALID_ASSIGNEE", message: "Choose a teammate in your organization." } };
      }
      assigneeId = teammate.user_id;
    }

    const { dayStart, dayEnd } = getDayBoundsInZone(new Date(), "America/Chicago");
    const statuses = input.status ? [input.status] : STATUS_ORDER;
    const cursors = input.status && input.cursor ? { [input.status]: input.cursor } : {};
    return ok(await fetchLeadBoardData(supabase, input.filters, {
      currentUserId: user.id,
      assigneeId,
      unassigned,
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString(),
    }, cursors, statuses));
  } catch (error) {
    reportError(error, { tags: { surface: "leads_board_page" } });
    return errFromUnknown(error, "LEADS_LOAD_FAILED");
  }
}

export async function setLeadNextActionAction(input: {
  propertyId: string;
  dueAt: string;
  idempotencyKey: string;
}): Promise<Result<{ id: string; title: string; dueAt: string; created: boolean }>> {
  if (!UUID.test(input.propertyId) || !UUID.test(input.idempotencyKey)) {
    return { ok: false, error: { code: "INVALID_NEXT_ACTION", message: "This next action request is invalid." } };
  }
  if (!input.dueAt || Number.isNaN(Date.parse(input.dueAt))) {
    return { ok: false, error: { code: "INVALID_DUE_AT", message: "Choose a valid due date." } };
  }
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_lead_next_action", {
      p_property_id: input.propertyId,
      p_due_at: input.dueAt,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      if (error.message?.startsWith("DNC_LOCKED:")) {
        return { ok: false, error: { code: "DNC_LOCKED", message: "This lead is permanently read-only." } };
      }
      return { ok: false, error: { code: error.code ?? "NEXT_ACTION_FAILED", message: error.message } };
    }
    const task = data?.[0];
    if (!task) {
      return { ok: false, error: { code: "NEXT_ACTION_NOT_SAVED", message: "The next action was not saved. Try again." } };
    }
    revalidatePath("/leads");
    revalidatePath(`/leads/${input.propertyId}`);
    revalidatePath("/dashboard");
    return ok({ id: task.id, title: task.title, dueAt: task.due_at, created: task.was_created });
  } catch (error) {
    reportError(error, { tags: { surface: "set_lead_next_action" }, extra: { propertyId: input.propertyId } });
    return errFromUnknown(error, "NEXT_ACTION_FAILED");
  }
}
