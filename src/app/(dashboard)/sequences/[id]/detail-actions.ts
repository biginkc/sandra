"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { requireSequenceAdmin } from "../admin";

export async function copySequenceSteps(targetId: string, sourceId: string): Promise<Result<{ copied: number }>> {
  if (!targetId || !sourceId || targetId === sourceId) return { ok: false, error: { code: "VALIDATION", message: "Choose another drip with steps." } };
  try {
    const guard = await requireSequenceAdmin();
    if (!guard.ok) return guard;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("sequence_copy_steps", { p_target: targetId, p_source: sourceId });
    if (error) return { ok: false, error: { code: "COPY_FAILED", message: error.message.includes("TARGET_NOT_EMPTY") ? "This drip already has steps." : error.message } };
    revalidatePath(`/sequences/${targetId}`);
    revalidatePath(`/sequences/${targetId}/edit`);
    revalidatePath("/sequences");
    return ok({ copied: data });
  } catch (error) {
    return errFromUnknown(error, "COPY_FAILED");
  }
}
