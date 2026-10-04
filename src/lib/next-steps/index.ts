import "server-only";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { kickCalendarMutationSync } from "@/lib/appointments/inline-sync-kick";
import { errFromUnknown, err, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { dispatchTaskAssigned } from "@/lib/notifications/dispatch";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  assertContactDncUnlocked,
  assertPropertyDncUnlocked,
} from "@/lib/dnc/property-lock";
import { resolveBookingOrgId } from "./org";

export type NextStepKind = "appointment" | "task";
export type NextStepMode = "phone" | "in_person";
export const PHONE_APPOINTMENT_MINUTES = 15;

const MIN_IN_PERSON_MINUTES = 15;
const MAX_IN_PERSON_MINUTES = 24 * 60;

export type CreateNextStepInput = {
  kind: NextStepKind;
  assigneeId: string;
  title: string;
  /** ISO instant, already converted server-side (never trust a client Date). */
  dueAt: string;
  propertyId?: string;
  contactId?: string;
  /** Appointment only, default "phone". */
  mode?: NextStepMode;
  /** In-person only (phone is fixed at 15 minutes). */
  durationMinutes?: number;
  location?: string;
  note?: string;
  /** UUID, one per user action. */
  idempotencyKey?: string;
  origin?: "app" | "board" | "offer";
  /** Dialer wrap-up only. */
  applyBookingEffects?: boolean;
};

export type CreateNextStepResult = {
  taskId: string;
  calendarChainId: string | null;
  ledgerId: string | null;
  duplicate: boolean;
  kind: NextStepKind;
  mode: NextStepMode;
  relatedPropertyId: string | null;
  contactId: string | null;
  /** From the RPC; false when booking effects were off or the property was a prospect. */
  alreadyQualified: boolean;
};

type NextStepRpcData = {
  task_id: string;
  calendar_chain_id: string | null;
  ledger_id: string | null;
  duplicate: boolean;
  converted?: boolean;
  kind: NextStepKind;
  mode: NextStepMode;
  related_property_id: string | null;
  contact_id: string | null;
  already_qualified?: boolean;
};

/** Hand-rolled until `types.ts` is regenerated, like `AppointmentRpcClient`. */
type NextStepRpcClient = {
  rpc(
    fn: "fn_create_next_step",
    args: {
      p_org: string;
      p_actor: string;
      p_assignee: string;
      p_kind: NextStepKind;
      p_title: string;
      p_due_at: string;
      p_property: string | null;
      p_contact: string | null;
      p_mode: NextStepMode | null;
      p_end_at: string | null;
      p_location: string | null;
      p_description: string | null;
      p_source_key: string | null;
      p_idempotency_key: string | null;
      p_lead_next_action_key: string | null;
      p_origin: string;
      p_enforce_window: boolean;
      p_apply_booking_effects: boolean;
    },
  ): PromiseLike<{
    data: NextStepRpcData | null;
    error: { message: string; code?: string } | null;
  }>;
};

function mapRpcError(error: { message: string; code?: string }) {
  const m = error.message ?? "";
  if (error.code === "42501" || m.includes("FORBIDDEN")) {
    return err({ code: "FORBIDDEN", message: "You can't create this next step." });
  }
  if (m.includes("DNC_LOCKED")) {
    return err({ code: "DNC_LOCKED", message: m });
  }
  if (m.includes("TRAINING_PROTECTED")) {
    return err({ code: "TRAINING_PROTECTED", message: m });
  }
  if (error.code === "22023") {
    return err({ code: "INVALID_INPUT", message: m });
  }
  return err({ code: "CREATE_NEXT_STEP_FAILED", message: m || "Could not create the next step." });
}

function loadDeepLink(propertyId?: string, contactId?: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const base = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  if (propertyId) return `${base}/leads/${propertyId}`;
  if (contactId) return `${base}/messages?thread=${contactId}`;
  return `${base}/dashboard`;
}

/**
 * Creates a next step (appointment or task) through the one SQL write
 * function `fn_create_next_step`. SQL writes the lead event, so this wrapper
 * never records one for the creation itself.
 */
export async function createNextStep(
  input: CreateNextStepInput,
): Promise<Result<CreateNextStepResult>> {
  if (!input.assigneeId) {
    return err({ code: "ASSIGNEE_REQUIRED", message: "Choose who this is for." });
  }
  if (!input.title.trim()) {
    return err({ code: "TITLE_REQUIRED", message: "Give it a title." });
  }
  const dueMs = Date.parse(input.dueAt);
  if (!Number.isFinite(dueMs)) {
    return err({ code: "TIME_INVALID", message: "Choose a valid date and time." });
  }
  const mode: NextStepMode =
    input.kind === "appointment" ? (input.mode ?? "phone") : "phone";
  let endAt: string | null = null;
  if (input.kind === "appointment" && mode === "in_person") {
    const d = input.durationMinutes;
    if (
      d === undefined ||
      !Number.isFinite(d) ||
      d < MIN_IN_PERSON_MINUTES ||
      d > MAX_IN_PERSON_MINUTES
    ) {
      return err({ code: "INVALID_DURATION", message: "Choose a valid duration." });
    }
    endAt = new Date(dueMs + d * 60_000).toISOString();
  }

  try {
    const supabase = await createClient();
    await assertNotTrainingTarget(supabase, {
      propertyId: input.propertyId,
      contactId: input.contactId,
    });
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
    }
    if (input.propertyId) {
      const unlocked = await assertPropertyDncUnlocked(supabase, input.propertyId);
      if (!unlocked.ok) return unlocked;
    }
    if (input.contactId) {
      const unlocked = await assertContactDncUnlocked(supabase, input.contactId);
      if (!unlocked.ok) return unlocked;
    }

    const orgResult = await resolveBookingOrgId(supabase, user, {
      propertyId: input.propertyId,
      contactId: input.contactId,
    });
    if (!orgResult.ok) return orgResult;
    const orgId = orgResult.data;

    const rpcClient = supabase as unknown as NextStepRpcClient;
    const { data, error } = await rpcClient.rpc("fn_create_next_step", {
      p_org: orgId,
      p_actor: user.id,
      p_assignee: input.assigneeId,
      p_kind: input.kind,
      p_title: input.title,
      p_due_at: new Date(dueMs).toISOString(),
      p_property: input.propertyId ?? null,
      p_contact: input.contactId ?? null,
      p_mode: input.kind === "appointment" ? mode : null,
      p_end_at: endAt,
      p_location: input.location?.trim() || null,
      p_description: input.note?.trim() || null,
      p_source_key: null,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_lead_next_action_key: null,
      p_origin: input.origin ?? "app",
      p_enforce_window: true,
      p_apply_booking_effects: input.applyBookingEffects ?? false,
    });
    if (error) return mapRpcError(error);
    if (!data) {
      return err({
        code: "CREATE_NEXT_STEP_FAILED",
        message: "Could not create the next step.",
      });
    }

    const result: CreateNextStepResult = {
      taskId: data.task_id,
      calendarChainId: data.calendar_chain_id ?? null,
      ledgerId: data.ledger_id ?? null,
      duplicate: data.duplicate,
      kind: data.kind,
      mode: data.mode,
      relatedPropertyId: data.related_property_id ?? null,
      contactId: data.contact_id ?? null,
      alreadyQualified: data.already_qualified ?? false,
    };
    const linkedPropertyId = result.relatedPropertyId ?? undefined;
    const linkedContactId = result.contactId ?? undefined;

    // (a) The ledger row is the durable calendar-create intent; advance it now.
    if (result.ledgerId) {
      try {
        await kickCalendarMutationSync(createAdminClient(), result.ledgerId);
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_next_step_inline_sync_kick" },
          extra: { taskId: result.taskId, ledgerId: result.ledgerId },
        });
      }
    }

    // (b) Assignment notifications; never dispatchTaskCalendarEvent (the ledger is the only calendar creator).
    if (input.assigneeId !== user.id && !result.duplicate) {
      try {
        const admin = createAdminClient();
        const prefs = await loadIntegrationPrefs(admin, input.assigneeId);
        const taskType = input.kind === "appointment" ? "appointment" : "custom";
        let subjectLabel = input.title;
        if (linkedPropertyId) {
          const { data: prop } = await supabase
            .from("properties")
            .select("address")
            .eq("id", linkedPropertyId)
            .maybeSingle();
          subjectLabel = prop?.address ?? "Appointment";
        }
        const deepLink = loadDeepLink(linkedPropertyId, linkedContactId);
        after(async () => {
          await Promise.allSettled([
            dispatchTaskAssigned(supabase, {
              taskId: result.taskId,
              orgId,
              assigneeId: input.assigneeId,
              taskTitle: input.title,
              taskType,
              dueAt: input.dueAt,
              propertyAddress: linkedPropertyId ? subjectLabel : null,
            }),
            dispatchTaskAssignedSlack({
              taskId: result.taskId,
              assigneeId: input.assigneeId,
              taskTitle: input.title,
              taskType,
              dueAt: input.dueAt,
              propertyAddress: subjectLabel,
              deepLink,
              timezone: prefs.timezone,
              slackEnabled: prefs.slackEnabled,
            }),
          ]);
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_next_step_notify" },
          extra: { taskId: result.taskId },
        });
      }
    }

    // (c) Dialer wrap-up booking effects.
    if (input.applyBookingEffects && linkedPropertyId) {
      if (!result.alreadyQualified && !result.duplicate) {
        try {
          await recordLeadEvents([
            {
              propertyId: linkedPropertyId,
              actorType: "user" as const,
              actorId: user.id,
              eventType: LEAD_EVENT_TYPES.QUALIFIED,
              payload: { from: "prospect", to: "new_lead" },
              sourceType: "appointments.qualified",
              sourceId: result.ledgerId ?? result.taskId,
            },
          ]);
        } catch (e) {
          reportError(e, {
            tags: { surface: "create_next_step_qualified_event" },
            extra: { propertyId: linkedPropertyId },
          });
        }
      }
      try {
        await pausePropertyEnrollments(supabase, {
          propertyId: linkedPropertyId,
          reason: "appointment_booked",
          permanent: false,
          actor: { actorType: "user", actorId: user.id },
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_next_step_pause_enrollments" },
          extra: { propertyId: linkedPropertyId },
        });
      }
    }

    // (d) Cache invalidation is best-effort after commit.
    try {
      if (linkedPropertyId) revalidatePath(`/leads/${linkedPropertyId}`);
      revalidatePath("/my-leads");
      revalidatePath("/messages");
      revalidatePath("/dashboard");
      revalidatePath("/calendar");
    } catch (e) {
      reportError(e, {
        tags: { surface: "create_next_step_revalidate" },
        extra: { taskId: result.taskId },
      });
    }

    return ok(result);
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_next_step" },
      extra: { propertyId: input.propertyId, contactId: input.contactId },
    });
    return errFromUnknown(e, "CREATE_NEXT_STEP_FAILED");
  }
}
