import type { SupabaseClient } from "@supabase/supabase-js";

import type { Result } from "@/lib/errors/result";
import type { Database } from "@/lib/supabase/types";

export const DNC_LOCKED_MESSAGE =
  "This property is permanently locked Do Not Contact and is read-only.";

export async function assertPropertyDncUnlocked(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<Result<null>> {
  const { error } = await supabase.rpc("assert_property_dnc_unlocked", {
    p_property_id: propertyId,
  });
  if (!error) return { ok: true, data: null };

  const locked = error.message.includes("DNC_LOCKED");
  return {
    ok: false,
    error: {
      code: locked ? "DNC_LOCKED" : "PROPERTY_LOCK_CHECK_FAILED",
      message: locked ? DNC_LOCKED_MESSAGE : error.message,
    },
  };
}

export async function assertAppointmentTaskPropertyDncUnlocked(
  supabase: SupabaseClient<Database>,
  taskId: string,
): Promise<Result<null>> {
  const { error } = await supabase.rpc("assert_appointment_task_dnc_unlocked", {
    p_task_id: taskId,
  });
  if (!error) return { ok: true, data: null };
  const locked = error.message.includes("DNC_LOCKED");
  return {
    ok: false,
    error: {
      code: locked ? "DNC_LOCKED" : "PROPERTY_LOCK_CHECK_FAILED",
      message: locked ? DNC_LOCKED_MESSAGE : error.message,
    },
  };
}

export async function assertContactDncUnlocked(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<Result<null>> {
  const { error } = await supabase.rpc("assert_contact_dnc_unlocked", {
    p_contact_id: contactId,
  });
  if (!error) return { ok: true, data: null };
  const locked = error.message.includes("DNC_LOCKED");
  return {
    ok: false,
    error: {
      code: locked ? "DNC_LOCKED" : "CONTACT_LOCK_CHECK_FAILED",
      message: locked ? DNC_LOCKED_MESSAGE : error.message,
    },
  };
}

export async function partitionPropertyDncLocks(
  supabase: SupabaseClient<Database>,
  propertyIds: readonly string[],
): Promise<Result<{ unlocked: string[]; locked: string[]; missing: string[] }>> {
  const uniqueIds = [...new Set(propertyIds)];
  if (uniqueIds.length === 0) {
    return { ok: true, data: { unlocked: [], locked: [], missing: [] } };
  }

  const { data, error } = await supabase
    .from("properties")
    .select("id, is_dnc_locked")
    .in("id", uniqueIds)
    .is("deleted_at", null);
  if (error) {
    return {
      ok: false,
      error: { code: "PROPERTY_LOCK_CHECK_FAILED", message: error.message },
    };
  }

  const state = new Map((data ?? []).map((row) => [row.id, row.is_dnc_locked]));
  return {
    ok: true,
    data: {
      unlocked: uniqueIds.filter((id) => state.get(id) === false),
      locked: uniqueIds.filter((id) => state.get(id) === true),
      missing: uniqueIds.filter((id) => !state.has(id)),
    },
  };
}
