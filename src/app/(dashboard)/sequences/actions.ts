"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import {
  enrollLead,
  resumeEnrollment,
  retrySequenceStep,
} from "@/lib/sequences/enrollment";
import { getSequenceImpact } from "@/lib/sequences/impact";
import { DRIP_BUCKET_LABELS } from "@/lib/sequences/drip-status";
import { NEEDS_PERSON_PAGE_SIZE } from "./overview-model";
import { enrollmentReason, previewFirstSend, startFollowUpDrip, type DripResult } from "@/lib/sequences/start-drip";

import { requireSequenceAdmin } from "./admin";

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
  waiting?: number;
  replied?: number;
  finished_no_reply?: number;
  couldnt_send?: number;
  stopped?: number;
  last_sent?: string | null;
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
    template_id: string | null;
    template_category: string | null;
    target_status: string | null;
  }>;
};

export type SequenceStepInput = Omit<SequenceWithSteps["steps"][number], "id"> & { id?: string };

export async function replaceSequenceSteps(input: {
  sequenceId: string;
  name: string;
  description: string | null;
  steps: SequenceStepInput[];
}): Promise<Result<string[]>> {
  const name = input.name.trim();
  if (!name || name.length > 120 || input.steps.length > 100 || input.steps.some((step, index) =>
    step.step_index !== index || !Number.isInteger(step.delay_after_previous_minutes) ||
    step.delay_after_previous_minutes < 0 ||
    (step.action_type === "send_sms" && (
      Number(Boolean(step.template_body?.trim())) + Number(Boolean(step.template_id)) +
      Number(Boolean(step.template_category?.trim())) !== 1 || Boolean(step.target_status)
    )) ||
    (step.action_type === "change_status" && (
      !step.target_status?.trim() || Boolean(step.template_body?.trim()) ||
      Boolean(step.template_id) || Boolean(step.template_category?.trim())
    )) || !["send_sms", "change_status"].includes(step.action_type)
  )) return { ok: false, error: { code: "VALIDATION", message: "Check the drip name and every step before saving." } };
  try {
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return { ok: false, error: guard.error };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("sequence_replace_steps", {
      p_sequence: input.sequenceId,
      p_name: name,
      p_description: input.description,
      p_steps: input.steps,
    });
    if (error) return { ok: false, error: { code: "STEP_REPLACE_FAILED", message: error.message } };
    revalidatePath("/sequences");
    revalidatePath(`/sequences/${input.sequenceId}`);
    revalidatePath(`/sequences/${input.sequenceId}/edit`);
    if (!Array.isArray(data) || data.length !== input.steps.length || !data.every((id) => typeof id === "string"))
      return { ok: false, error: { code: "STEP_REPLACE_RESPONSE", message: "Drip saved, but saved step IDs could not be read. Reload before editing again." } };
    return ok(data as string[]);
  } catch (error) {
    reportError(error, { tags: { surface: "replace_sequence_steps" }, extra: { sequenceId: input.sequenceId } });
    return errFromUnknown(error, "STEP_REPLACE_FAILED");
  }
}

export type NeedsPersonRow = {
  property_id: string;
  sequence_id: string | null;
  bucket: "finished_no_reply" | "couldnt_send" | "needs_sequence";
  reason: string;
};
export type NeedsPersonBucket = NeedsPersonRow["bucket"];
export type NeedsPersonCounts = Record<NeedsPersonBucket, number>;

async function activeOrgId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data, error } = await supabase.from("memberships").select("org_id")
    .eq("user_id", userId).eq("access_status", "active")
    .is("deletion_prepared_at", null).limit(1).maybeSingle();
  if (error) throw error;
  return data?.org_id ?? null;
}

export async function listSequenceNeedsPersonCounts(): Promise<Result<NeedsPersonCounts>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const orgId = await activeOrgId(supabase, user.id);
    if (!orgId) return ok({ finished_no_reply: 0, couldnt_send: 0, needs_sequence: 0 });
    const { data, error } = await supabase.rpc("sequence_needs_person_counts", {
      p_org: orgId, p_exclude_created_by: process.env.SEQUENCE_CANARY_USER_ID || null,
    });
    if (error) return { ok: false, error: { code: "SEQ_STATS_UNAVAILABLE", message: error.code === "PGRST202" ? "Drip stats are being prepared." : error.message } };
    const counts = data?.[0];
    return ok({ finished_no_reply: Number(counts?.finished_no_reply ?? 0), couldnt_send: Number(counts?.couldnt_send ?? 0), needs_sequence: Number(counts?.needs_sequence ?? 0) });
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_needs_person_counts" } });
    return errFromUnknown(error, "SEQ_STATS_FAILED");
  }
}

export async function listSequenceNeedsPersonPage(bucket: NeedsPersonBucket, page: number): Promise<Result<NeedsPersonRow[]>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const orgId = await activeOrgId(supabase, user.id);
    if (!orgId) return ok([]);
    const { data, error } = await supabase.rpc("sequence_needs_person_page", {
      p_org: orgId, p_bucket: bucket, p_offset: (page - 1) * NEEDS_PERSON_PAGE_SIZE,
      p_limit: NEEDS_PERSON_PAGE_SIZE, p_exclude_created_by: process.env.SEQUENCE_CANARY_USER_ID || null,
    });
    if (error) return { ok: false, error: { code: "SEQ_STATS_UNAVAILABLE", message: error.code === "PGRST202" ? "Drip stats are being prepared." : error.message } };
    return ok((data ?? []).map((row) => ({
        property_id: row.property_id,
        sequence_id: row.sequence_id,
        bucket: row.bucket as NeedsPersonRow["bucket"],
        reason: row.bucket === "needs_sequence" ? "Needs a drip" :
          DRIP_BUCKET_LABELS[row.bucket as "finished_no_reply" | "couldnt_send"],
      })));
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_needs_person_page" } });
    return errFromUnknown(error, "SEQ_STATS_FAILED");
  }
}

export type DripChoice = { id: string; name: string; textCount: number; days: number; firstSend: string | null };

export async function listDripChoices(): Promise<Result<DripChoice[]>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const { data: sequences, error } = await supabase.from("sequences")
      .select("id, name, created_by").eq("active", true).is("archived_at", null).order("name");
    if (error) return { ok: false, error: { code: "SEQ_LIST_FAILED", message: error.message } };
    const visibleSequences = (sequences ?? []).filter((sequence) =>
      !process.env.SEQUENCE_CANARY_USER_ID || sequence.created_by !== process.env.SEQUENCE_CANARY_USER_ID);
    if (!visibleSequences.length) return ok([]);
    const { data: steps, error: stepError } = await supabase.from("sequence_steps")
      .select("sequence_id, step_index, delay_after_previous_minutes, action_type")
      .in("sequence_id", visibleSequences.map((sequence) => sequence.id)).order("step_index");
    if (stepError) return { ok: false, error: { code: "SEQ_LIST_FAILED", message: stepError.message } };
    return ok(visibleSequences.flatMap((sequence) => {
      const own = (steps ?? []).filter((step) => step.sequence_id === sequence.id);
      if (!own.length || own[0].step_index !== 0) return [];
      const firstSmsIndex = own.findIndex((step) => step.action_type === "send_sms");
      return [{
        id: sequence.id,
        name: sequence.name,
        textCount: own.filter((step) => step.action_type === "send_sms").length,
        days: Math.ceil(own.reduce((sum, step) => sum + step.delay_after_previous_minutes, 0) / 1440),
        firstSend: firstSmsIndex < 0 ? null : previewFirstSend(
          own.slice(0, firstSmsIndex + 1).reduce((sum, step) => sum + step.delay_after_previous_minutes, 0),
          "America/Chicago",
        ),
      }];
    }));
  } catch (e) {
    reportError(e, { tags: { surface: "list_drip_choices" } });
    return errFromUnknown(e, "SEQ_LIST_FAILED");
  }
}

export async function startDripForLeads(sequenceId: string, propertyIds: string[]): Promise<Result<{ results: DripResult[] }>> {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0 || propertyIds.length > 100) {
    return { ok: false, error: { code: "VALIDATION", message: "Choose between 1 and 100 leads." } };
  }
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const result = await startFollowUpDrip(supabase, { sequenceId, propertyIds, userId: user.id });
    for (const path of ["/leads", "/messages", "/properties", ...propertyIds.map((id) => `/leads/${id}`)]) revalidatePath(path);
    return ok(result);
  } catch (e) {
    reportError(e, { tags: { surface: "start_drip_for_leads" } });
    return errFromUnknown(e, "ENROLL_FAILED");
  }
}

export async function listSequences(): Promise<Result<SequenceRow[]>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const orgId = await activeOrgId(supabase, user.id);
    if (!orgId) return ok([]);
    const stats = await supabase.rpc("sequence_overview_stats", { p_org: orgId });
    if (!stats.error) return ok((stats.data ?? []).filter((row) =>
      !process.env.SEQUENCE_CANARY_USER_ID || row.created_by !== process.env.SEQUENCE_CANARY_USER_ID)
      .map((row) => ({
        id: row.id, name: row.name, description: row.description,
        active: row.active, append_opt_out: row.append_opt_out,
        archived_at: row.archived_at, created_at: row.created_at,
        step_count: row.step_count, active_enrollment_count: row.active_enrollment_count,
        waiting: row.waiting, replied: row.replied,
        finished_no_reply: row.finished_no_reply,
        couldnt_send: row.couldnt_send, stopped: row.stopped,
        last_sent: row.last_sent,
      })));
    // Deploys can precede the migration; keep the current page available.
    if (stats.error.code !== "PGRST202" && stats.error.code !== "42883") {
      return { ok: false, error: { code: "SEQ_LIST_FAILED", message: stats.error.message } };
    }
    const { data, error } = await supabase
      .from("sequences")
      .select("id, name, description, active, append_opt_out, archived_at, created_at, created_by")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (error) {
      return {
        ok: false,
        error: { code: "SEQ_LIST_FAILED", message: error.message },
      };
    }
    const visible = (data ?? []).filter((row) =>
      !process.env.SEQUENCE_CANARY_USER_ID || row.created_by !== process.env.SEQUENCE_CANARY_USER_ID);
    if (!visible.length) return ok([]);

    // Batch fetch step + enrollment counts so the index doesn't N+1.
    const seqIds = visible.map((s) => s.id);
    const [stepResult, enrollmentResult] = await Promise.all([
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

    if (stepResult.error || enrollmentResult.error) return {
      ok: false,
      error: { code: "SEQ_LIST_FAILED", message: (stepResult.error ?? enrollmentResult.error)!.message },
    };
    const stepTally = new Map<string, number>();
    for (const r of stepResult.data ?? []) {
      stepTally.set(r.sequence_id, (stepTally.get(r.sequence_id) ?? 0) + 1);
    }
    const enrTally = new Map<string, number>();
    for (const r of enrollmentResult.data ?? []) {
      enrTally.set(r.sequence_id, (enrTally.get(r.sequence_id) ?? 0) + 1);
    }

    return ok(
      visible.map((s) => ({
        id: s.id, name: s.name, description: s.description, active: s.active,
        append_opt_out: s.append_opt_out, archived_at: s.archived_at, created_at: s.created_at,
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
      .select("id, name, description, active, append_opt_out, archived_at")
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
        "id, step_index, delay_after_previous_minutes, action_type, template_body, template_id, template_category, target_status",
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
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return { ok: false, error: guard.error };

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
            message: `A drip named "${name}" already exists.`,
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
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return { ok: false, error: guard.error };

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
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return { ok: false, error: guard.error };

    const supabase = await createClient();
    const { error } = await supabase
      .from("sequences")
      .update({
        archived_at: new Date().toISOString(),
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

export async function restoreSequence(sequenceId: string): Promise<Result<null>> {
  try {
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return { ok: false, error: guard.error };
    const supabase = await createClient();
    const { error } = await supabase.from("sequences")
      .update({ archived_at: null, updated_at: new Date().toISOString() })
      .eq("id", sequenceId);
    if (error) return { ok: false, error: { code: "SEQ_RESTORE_FAILED", message: error.message } };
    revalidatePath("/sequences");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "restore_sequence" }, extra: { sequenceId } });
    return errFromUnknown(error, "SEQ_RESTORE_FAILED");
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
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }

    const outcome = await enrollLead(supabase, {
      sequenceId,
      propertyId,
      enrolledByUserId: user.id,
    });

    switch (outcome.status) {
      case "enrolled":
        revalidatePath(`/leads/${propertyId}`);
        return ok({ enrollmentId: outcome.enrollmentId });
      case "duplicate_active":
        return ok({ duplicate: true });
      case "already_in_drip":
      case "no_phone":
      case "landline_phone":
      case "no_consent":
      case "suppressed":
      case "sequence_not_found":
      case "sequence_inactive":
      case "property_not_found":
      case "no_steps":
        return {
          ok: false,
          error: {
            code: outcome.status.toUpperCase(),
            message: enrollmentReason(outcome),
          },
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

export async function cancelEnrollment(
  enrollmentId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }

    const { data, error } = await supabase.rpc(
      "cancel_sequence_enrollment",
      {
        p_enrollment_id: enrollmentId,
        p_actor_user_id: user.id,
      },
    );
    if (error) {
      return {
        ok: false,
        error: { code: "CANCEL_FAILED", message: error.message },
      };
    }

    const result = data?.[0];
    if (!result || result.outcome === "not_found" || result.outcome === "not_active") {
      return ok(null);
    }
    if (result.outcome !== "canceled") {
      return {
        ok: false,
        error: {
          code: "CANCEL_FAILED",
          message: "Enrollment could not be canceled.",
        },
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

export async function pauseEnrollmentAction(enrollmentId: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const { data, error } = await supabase.from("sequence_enrollments")
      .update({ status: "paused", pause_reason: "manual", updated_at: new Date().toISOString() })
      .eq("id", enrollmentId).eq("status", "active")
      .select("property_id, sequence_id");
    if (error) return { ok: false, error: { code: "PAUSE_FAILED", message: error.message } };
    if (!data?.length) return { ok: false, error: { code: "NOT_ACTIVE", message: "Enrollment is no longer active." } };
    await recordLeadEvent({ propertyId: data[0].property_id, actorType: "user", actorId: user.id,
      eventType: LEAD_EVENT_TYPES.SEQUENCE_PAUSED,
      payload: { enrollment_id: enrollmentId, sequence_id: data[0].sequence_id, reason: "manual" } });
    revalidatePath(`/leads/${data[0].property_id}`);
    revalidatePath("/sequences");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "pause_enrollment" }, extra: { enrollmentId } });
    return errFromUnknown(e, "PAUSE_FAILED");
  }
}

/** Stop the old enrollment before invoking the normal guarded enrollment path. */
export async function changeDripAction(enrollmentId: string, sequenceId: string): Promise<Result<DripResult>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const { data: old, error: loadError } = await supabase.from("sequence_enrollments")
      .select("property_id, sequence_id, status").eq("id", enrollmentId).maybeSingle();
    if (loadError) return { ok: false, error: { code: "CHANGE_FAILED", message: loadError.message } };
    if (!old || !["active", "paused"].includes(old.status)) return { ok: false, error: { code: "NOT_ACTIVE", message: "Enrollment is no longer active." } };
    if (old.sequence_id === sequenceId) return { ok: false, error: { code: "SAME_DRIP", message: "Choose a different drip." } };
    const { data: canceled, error: cancelError } = await supabase.rpc("cancel_sequence_enrollment", {
      p_enrollment_id: enrollmentId, p_actor_user_id: user.id,
    });
    if (cancelError || canceled?.[0]?.outcome !== "canceled") return { ok: false, error: { code: "CANCEL_FAILED", message: cancelError?.message ?? "Enrollment could not be canceled." } };
    let result: DripResult;
    try {
      const outcome = await enrollLead(supabase, { propertyId: old.property_id, sequenceId, enrolledByUserId: user.id });
      result = { propertyId: old.property_id,
        status: outcome.status === "enrolled" ? "enrolled" : ["duplicate_active", "already_in_drip", "no_phone", "landline_phone", "no_consent", "suppressed"].includes(outcome.status) ? "skipped" : "failed",
        reason: outcome.status === "enrolled" ? enrollmentReason(outcome) : `Previous drip stopped. ${enrollmentReason(outcome)}` };
    } catch (error) {
      reportError(error, { tags: { surface: "change_drip_enroll" }, extra: { enrollmentId, sequenceId } });
      result = { propertyId: old.property_id, status: "failed", reason: "Previous drip stopped. Could not enroll this lead." };
    }
    revalidatePath(`/leads/${old.property_id}`);
    revalidatePath("/sequences");
    return ok(result);
  } catch (e) {
    reportError(e, { tags: { surface: "change_drip" }, extra: { enrollmentId, sequenceId } });
    return errFromUnknown(e, "CHANGE_FAILED");
  }
}

export async function resumeEnrollmentAction(
  enrollmentId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    const outcome = await resumeEnrollment(supabase, enrollmentId, {
      actorType: "user",
      actorId: user.id,
    });
    if (outcome.status === "failed") {
      return {
        ok: false,
        error: { code: "RESUME_FAILED", message: outcome.message },
      };
    }
    if (outcome.status === "reconciliation_required") {
      return {
        ok: false,
        error: {
          code: "RECONCILIATION_REQUIRED",
          message:
            "This step may have reached the provider. Reconcile its delivery before resuming.",
        },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "resume_enrollment" } });
    return errFromUnknown(e, "RESUME_FAILED");
  }
}

/** Retry a provider step only when the durable claim proves no provider
 * attempt occurred or the adapter definitively rejected it. */
export async function retrySequenceStepAction(
  enrollmentId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    const outcome = await retrySequenceStep(supabase, enrollmentId, {
      actorType: "user",
      actorId: user.id,
    });
    if (outcome.status === "failed") {
      return {
        ok: false,
        error: { code: "RETRY_FAILED", message: outcome.message },
      };
    }
    if (outcome.status !== "retried") {
      return {
        ok: false,
        error: {
          code: "RECONCILIATION_REQUIRED",
          message:
            "This provider attempt cannot be retried safely until delivery is reconciled.",
        },
      };
    }
    revalidatePath("/sequences");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "retry_sequence_step" } });
    return errFromUnknown(e, "RETRY_FAILED");
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
