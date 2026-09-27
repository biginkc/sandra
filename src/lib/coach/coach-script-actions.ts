"use server";

import { assertValidScriptBundle, type ScriptBundle, type ScriptRef } from "@biginkc/coach";

import { createClient } from "@/lib/supabase/server";

type OwnedCallQuery = {
  select(columns: string): OwnedCallQuery;
  eq(column: string, value: string): OwnedCallQuery;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
};

type OwnedCallClient = { from(table: "coach_call_index"): OwnedCallQuery };

export type CoachCallScriptLoadResult =
  | { status: "bound"; binding: { ref: ScriptRef; bundle: ScriptBundle } }
  /** The async call-index write has not landed yet; this is safe to retry. */
  | { status: "pending" }
  /** The owned row exists, but it has no usable immutable script binding. */
  | { status: "unavailable" }
  /** Authentication or the index query failed; retrying cannot safely help. */
  | { status: "error" };

/**
 * Gives a rep only the exact script bound to their own call. A null binding,
 * a missing revision, or invalid cached content is unavailable — never a cue
 * to substitute the current/default revision.
 */
export async function loadCoachCallScript(clientCallId: string): Promise<CoachCallScriptLoadResult> {
  if (typeof clientCallId !== "string" || !clientCallId) return { status: "unavailable" };
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return { status: "error" };
    const calls = supabase as unknown as OwnedCallClient;
    const result = await calls.from("coach_call_index")
      .select("script_slug, script_revision, script_digest, coach_script_revisions!coach_call_index_script_binding_fkey(bundle)")
      .eq("client_call_id", clientCallId)
      .eq("operator_user_id", user.id)
      .maybeSingle();
    if (result.error) return { status: "error" };
    // jitter-server deliberately writes this row in after(). A missing row is
    // therefore an expected short-lived state, unlike an existing null binding.
    if (!result.data) return { status: "pending" };
    if (typeof result.data !== "object") return { status: "unavailable" };
    const row = result.data as {
      script_slug?: unknown; script_revision?: unknown; script_digest?: unknown; coach_script_revisions?: unknown;
    };
    const revision = Array.isArray(row.coach_script_revisions) ? row.coach_script_revisions[0] : row.coach_script_revisions;
    if (
      typeof row.script_slug !== "string" || !Number.isInteger(row.script_revision) ||
      typeof row.script_digest !== "string" || !revision || typeof revision !== "object" ||
      !("bundle" in revision)
    ) return { status: "unavailable" };
    assertValidScriptBundle((revision as { bundle: unknown }).bundle);
    return {
      status: "bound",
      binding: {
        ref: { slug: row.script_slug, revision: row.script_revision as number, digest: row.script_digest },
        bundle: (revision as { bundle: ScriptBundle }).bundle,
      },
    };
  } catch {
    return { status: "error" };
  }
}
