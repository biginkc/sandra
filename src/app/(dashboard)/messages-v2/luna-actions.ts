"use server";

import { revalidatePath } from "next/cache";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { lunaSuggestionsEnabled } from "@/lib/sms-classification/luna/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { confirmJevQueueItem, correctJevQueueItem } from "../jev/actions";
import { messagesV2OrgId } from "./access";
import { applyLunaSuggestion, rejectLunaSuggestion, type LunaResolveDeps } from "./luna-resolve";

/**
 * Server actions behind the Luna suggestion on a hold card. Same gate as the
 * rest of Messages v2 (owner || acquisitions, resolved on the server). Apply
 * delegates to the existing Review Jev decision actions; nothing here writes a
 * disposition, suppression or consent state itself.
 */
async function authorize(): Promise<Result<LunaResolveDeps>> {
  if (!lunaSuggestionsEnabled()) {
    return err({ code: "LUNA_DISABLED", message: "Luna suggestions are not enabled." });
  }
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
  let orgId: string | null = null;
  try {
    const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === userId);
    orgId = messagesV2OrgId(memberships);
  } catch {
    orgId = null;
  }
  if (!orgId) return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  return {
    ok: true,
    data: {
      admin: createAdminClient(),
      orgId,
      userId,
      confirm: confirmJevQueueItem,
      correct: correctJevQueueItem,
      reportError,
    },
  };
}

const RELOAD_CODES = new Set(["LUNA_ALREADY_RESOLVED", "LUNA_NO_PENDING_ITEM", "LUNA_NOT_FOUND"]);

async function run<T>(action: (d: LunaResolveDeps) => Promise<Result<T>>): Promise<Result<T>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  try {
    const result = await action(auth.data);
    if (result.ok || RELOAD_CODES.has(result.error.code)) revalidatePath("/messages-v2");
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "messages_v2_luna_action" } });
    return err({ code: "LUNA_ACTION_FAILED", message: "That action failed. Nothing may have been changed; refresh and check." });
  }
}

export async function applyLunaSuggestionAction(input: { suggestionId: string }) {
  return run((d) => applyLunaSuggestion(d, { suggestionId: String(input.suggestionId) }));
}

export async function rejectLunaSuggestionAction(input: { suggestionId: string }) {
  return run((d) => rejectLunaSuggestion(d, { suggestionId: String(input.suggestionId) }));
}
