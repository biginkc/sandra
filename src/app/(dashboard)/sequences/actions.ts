"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  enrollLead,
  pausePropertyEnrollments,
  resumeEnrollment,
} from "@/lib/sequences/enrollment";
import { getSequenceImpact } from "@/lib/sequences/impact";

export type SequenceRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  append_opt_out: boolean;
  archived_at: string | null;
  step_count: number;
  active_enrollment_count: number;
  created_at: string;
};

export type SequenceWithSteps = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  append_opt_out: boolean;
  archived_at: string | null;
  steps: Array<{
    id: string;
    step_index: number;
    delay_after_previous_minutes: number;
    action_type: "send_sms" | "change_status";
    template_body: string | null;
    target_status: string | null;
  }>;
};

export async function listSequences(): Promise<Result<SequenceRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sequences")
      .select("id, name, description, active, append_opt_out, archived_at, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      return {
        ok: false,
        error: { code: "SEQ_LIST_FAILED", message: error.message },
      };
    }
    if (!data || data.length === 0) return ok([]);

    // Batch fetch step + enrollment counts so the index doesn't N+1.
    const seqIds = data.map((s) => s.id);
    const [{ data: stepCounts }, { data: enrCounts }] = await Promise.all([
      supabase
        .from("sequence_steps")
        .select("sequence_id")
        .in("sequence_id", seqIds),
      supabase
        .from("sequence_enrollments")
        .select("sequence_id")
        .in("sequence_id", seqIds)
        .in("status", ["active", "paused"]),
    ]);

    const stepTally = new Map<string, number>();
    for (const r of stepCounts ?? []) {
      stepTally.set(r.sequence_id, (stepTally.get(r.sequence_id) ?? 0) + 1);
    }
    const enrTally = new Map<string, number>();
    for (const r of enrCounts ?? []) {
      enrTally.set(r.sequence_id, (enrTally.get(r.sequence_id) ?? 0) + 1);
    }

    return ok(
      data.map((s) => ({
        ...s,
        step_count: stepTally.get(s.id) ?? 0,
        active_enrollment_count: enrTally.get(s.id) ?? 0,
      })),
    );
  } catch (e) {
    reportError(e, { tags: { surface: "list_sequences" } });
    return errFromUnknown(e, "SEQ_LIST_FAILED");
  }
}

export async function getSequenceWithSteps(
  sequenceId: string,
): Promise<Result<SequenceWithSteps | null>> {
  try {
    const supabase = await createClient();
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .select(
        "id, name, description, active, append_opt_out, archived_at",
      )
      .eq("id", sequenceId)
      .maybeSingle();
    if (seqErr) {
      return {
        ok: false,
        error: { code: "SEQ_GET_FAILED", message: seqErr.message },
      };
    }
    if (!seq) return ok(null);

    const { data: steps, error: stepErr } = await supabase
      .from("sequence_steps")
      .select(
        "id, step_index, delay_after_previous_minutes, action_type, template_body, target_status",
      )
      .eq("sequence_id", sequenceId)
      .order("step_index", { ascending: true });
    if (stepErr) {
      return {
        ok: false,
        error: { code: "SEQ_GET_FAILED", message: stepErr.message },
      };
    }
    return ok({
      ...seq,
      steps: (steps ?? []).map((s) => ({
        ...s,
        action_type: s.action_type as "send_sms" | "change_status",
      })),
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "get_sequence_with_steps" },
      extra: { sequenceId },
    });
    return errFromUnknown(e, "SEQ_GET_FAILED");
  }
}

export async function createSequence(input: {
  name: string;
  description?: string | null;
  append_opt_out?: boolean;
}): Promise<Result<{ id: string }>> {
  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Name is required." },
    };
  }
  if (name.length > 120) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${name.length} characters — cap is 120.`,
      },
    };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Resolve an org_id for the NOT-NULL constraint. Use the user's
    // first organization membership; with a single-org setup today,
    // this is always `organizations[0]`.
    const { data: firstOrg } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!firstOrg) {
      return {
        ok: false,
        error: { code: "NO_ORG", message: "No organization found." },
      };
    }

    const { data: inserted, error } = await supabase
      .from("sequences")
      .insert({
        org_id: firstOrg.id,
        name,
        description: input.description ?? null,
        append_opt_out: input.append_opt_out ?? true,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          error: {
            code: "DUPLICATE_NAME",
            message: `A sequence named "${name}" already exists.`,
          },
        };
      }
      return {
        ok: false,
        error: { code: "SEQ_CREATE_FAILED", message: error.message },
      };
    }
    revalidatePath("/sequences");
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_sequence" } });
    return errFromUnknown(e, "SEQ_CREATE_FAILED");
  }
}

export async function updateSequence(
  sequenceId: string,
  patch: {
    name?: string;
    description?: string | null;
    append_opt_out?: boolean;
    active?: boolean;
  },
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const update: {
      name?: string;
      description?: string | null;
      append_opt_out?: boolean;
      active?: boolean;
      updated_at: string;
    } = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) update.name = patch.name.trim();
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.append_opt_out !== undefined)
      update.append_opt_out = patch.append_opt_out;
    if (patch.active !== undefined) update.active = patch.active;

    const { error } = await supabase
      .from("sequences")
      .update(update)
      .eq("id", sequenceId);
    if (error) {
      return {
        ok: false,
        error: { code: "SEQ_UPDATE_FAILED", message: error.message },
      };
    }
    revalidatePath("/sequences");
    revalidatePath(`/sequences/${sequenceId}/edit`);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_sequence" },
      extra: { sequenceId },
    });
    return errFromUnknown(e, "SEQ_UPDATE_FAILED");
  }
}

export async function archiveSequence(
  sequenceId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("sequences")
      .update({
        archived_at: new Date().toISOString(),
        active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sequenceId);
    if (error) {
      return {
        ok: false,
        error: { code: "SEQ_ARCHIVE_FAILED", message: error.message },
      };
    }
    revalidatePath("/sequences");
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "archive_sequence" },
      extra: { sequenceId },
    });
    return errFromUnknown(e, "SEQ_ARCHIVE_FAILED");
  }
}

export async function upsertSequenceStep(input: {
  id?: string;
  sequence_id: string;
  step_index: number;
  delay_after_previous_minutes: number;
  action_type: "send_sms" | "change_status";
  template_body?: string | null;
  target_status?: string | null;
}): Promise<Result<{ id: string }>> {
  if (input.delay_after_previous_minutes < 0) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Delay must be non-negative." },
    };
  }
  if (input.action_type === "send_sms" && !input.template_body?.trim()) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "send_sms steps need a non-empty template body.",
      },
    };
  }
  if (input.action_type === "change_status" && !input.target_status) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "change_status steps need a target_status.",
      },
    };
  }

  try {
    const supabase = await createClient();
    if (input.id) {
      const { error } = await supabase
        .from("sequence_steps")
        .update({
          step_index: input.step_index,
          delay_after_previous_minutes: input.delay_after_previous_minutes,
          action_type: input.action_type,
          template_body: input.template_body ?? null,
          target_status: input.target_status ?? null,
        })
        .eq("id", input.id);
      if (error) {
        return {
          ok: false,
          error: { code: "STEP_UPDATE_FAILED", message: error.message },
        };
      }
      revalidatePath(`/sequences/${input.sequence_id}/edit`);
      return ok({ id: input.id });
    }
    const { data, error } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: input.sequence_id,
        step_index: input.step_index,
        delay_after_previous_minutes: input.delay_after_previous_minutes,
        action_type: input.action_type,
        template_body: input.template_body ?? null,
        target_status: input.target_status ?? null,
      })
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "STEP_CREATE_FAILED", message: error.message },
      };
    }
    revalidatePath(`/sequences/${input.sequence_id}/edit`);
    return ok({ id: data.id });
  } catch (e) {
    reportError(e, { tags: { surface: "upsert_sequence_step" } });
    return errFromUnknown(e, "STEP_UPSERT_FAILED");
  }
}

export async function deleteSequenceStep(
  stepId: string,
  sequenceId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("sequence_steps")
      .delete()
      .eq("id", stepId);
    if (error) {
      return {
        ok: false,
        error: { code: "STEP_DELETE_FAILED", message: error.message },
      };
    }
    revalidatePath(`/sequences/${sequenceId}/edit`);
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "delete_sequence_step" } });
    return errFromUnknown(e, "STEP_DELETE_FAILED");
  }
}

export async function enrollLeadInSequence(
  sequenceId: string,
  propertyId: string,
): Promise<Result<{ enrollmentId: string } | { duplicate: true }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const outcome = await enrollLead(supabase, {
      sequenceId,
      propertyId,
      enrolledByUserId: user?.id ?? null,
    });

    switch (outcome.status) {
      case "enrolled":
        revalidatePath(`/leads/${propertyId}`);
        return ok({ enrollmentId: outcome.enrollmentId });
      case "duplicate_active":
        return ok({ duplicate: true });
      case "no_phone":
      case "no_consent":
      case "sequence_not_found":
      case "sequence_inactive":
      case "property_not_found":
      case "no_steps":
        return {
          ok: false,
          error: { code: outcome.status.toUpperCase(), message: formatEnrollError(outcome.status) },
        };
      case "failed":
        return {
          ok: false,
          error: { code: "ENROLL_FAILED", message: outcome.message },
        };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "enroll_lead_in_sequence" },
      extra: { sequenceId, propertyId },
    });
    return errFromUnknown(e, "ENROLL_FAILED");
  }
}

function formatEnrollError(status: string): string {
  switch (status) {
    case "no_phone":
      return "Lead has no phone number.";
    case "no_consent":
      return "Contact has opted out of SMS.";
    case "sequence_not_found":
      return "Sequence not found.";
    case "sequence_inactive":
      return "Sequence is inactive or archived.";
    case "property_not_found":
      return "Lead not found.";
    case "no_steps":
      return "Sequence has no steps. Add one before enrolling.";
    default:
      return "Enrollment failed.";
  }
}

export async function cancelEnrollment(
  enrollmentId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollmentId);
    if (error) {
      return {
        ok: false,
        error: { code: "CANCEL_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "cancel_enrollment" },
      extra: { enrollmentId },
    });
    return errFromUnknown(e, "CANCEL_FAILED");
  }
}

export async function resumeEnrollmentAction(
  enrollmentId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const outcome = await resumeEnrollment(supabase, enrollmentId);
    if (outcome.status === "failed") {
      return {
        ok: false,
        error: { code: "RESUME_FAILED", message: outcome.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "resume_enrollment" } });
    return errFromUnknown(e, "RESUME_FAILED");
  }
}

export async function getImpactAction(
  sequenceId: string,
): Promise<Result<{ total_enrolled: number; scheduled_next_7d: number }>> {
  try {
    const supabase = await createClient();
    const impact = await getSequenceImpact(supabase, sequenceId);
    return ok(impact);
  } catch (e) {
    reportError(e, { tags: { surface: "get_impact" } });
    return errFromUnknown(e, "IMPACT_FAILED");
  }
}

/**
 * Listed sequences for a given property's lead detail page — the drip
 * chip + "Sequences" panel need both names and enrollment states.
 */
export async function listPropertyEnrollments(
  propertyId: string,
): Promise<
  Result<
    Array<{
      id: string;
      status: string;
      pause_reason: string | null;
      current_step_index: number;
      next_run_at: string | null;
      sequence: { id: string; name: string };
    }>
  >
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sequence_enrollments")
      .select(
        `id, status, pause_reason, current_step_index, next_run_at,
         sequence:sequences(id, name)`,
      )
      .eq("property_id", propertyId)
      .order("enrolled_at", { ascending: false });
    if (error) {
      return {
        ok: false,
        error: { code: "LIST_ENROLL_FAILED", message: error.message },
      };
    }
    return ok(
      (data ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        pause_reason: row.pause_reason,
        current_step_index: row.current_step_index,
        next_run_at: row.next_run_at,
        sequence: row.sequence as { id: string; name: string },
      })),
    );
  } catch (e) {
    reportError(e, {
      tags: { surface: "list_property_enrollments" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LIST_ENROLL_FAILED");
  }
}
