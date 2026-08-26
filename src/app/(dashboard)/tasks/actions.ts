"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  completeTask as completeTaskLib,
  reassignTask as reassignTaskLib,
  snoozeTask as snoozeTaskLib,
  type Task,
} from "@/lib/tasks";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the dashboard's TasksPanel inline buttons. Each
 * wraps the lib helper, resolves the current user where needed, and
 * revalidates `/dashboard` so the panel reflects the new state on the
 * next render.
 *
 * Returns Result<Task> — same shape as the lib helpers — so callers can
 * branch on `result.ok` without translating error shapes.
 */

export async function completeTaskAction(
  taskId: string,
): Promise<Result<Task>> {
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

    const result = await completeTaskLib(supabase, taskId, user.id);
    if (result.ok) {
      revalidatePath("/dashboard");
    }
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "task_complete_action" },
      extra: { taskId },
    });
    return errFromUnknown(e, "TASK_COMPLETE_FAILED");
  }
}

export async function snoozeTaskAction(
  taskId: string,
  /** ISO timestamptz — the new due_at */
  snoozedUntil: string,
): Promise<Result<Task>> {
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

    const result = await snoozeTaskLib(supabase, taskId, snoozedUntil, user.id);
    if (result.ok) {
      revalidatePath("/dashboard");
    }
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "task_snooze_action" },
      extra: { taskId, snoozedUntil },
    });
    return errFromUnknown(e, "TASK_SNOOZE_FAILED");
  }
}

export async function reassignTaskAction(
  taskId: string,
  newAssigneeId: string,
): Promise<Result<Task>> {
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

    const result = await reassignTaskLib(
      supabase,
      taskId,
      newAssigneeId,
      user.id,
    );
    if (result.ok) {
      revalidatePath("/dashboard");
    }
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "task_reassign_action" },
      extra: { taskId, newAssigneeId },
    });
    return errFromUnknown(e, "TASK_REASSIGN_FAILED");
  }
}
