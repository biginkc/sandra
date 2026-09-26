"use server";

import { assertValidScriptBundle, type ScriptBundle, type ScriptRef } from "@biginkc/coach";

import { createClient } from "@/lib/supabase/server";

type OwnedCallQuery = {
  select(columns: string): OwnedCallQuery;
  eq(column: string, value: string): OwnedCallQuery;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
};

type OwnedCallClient = { from(table: "coach_call_index"): OwnedCallQuery };

/**
 * Gives a rep only the exact script bound to their own call. A null binding,
 * a missing revision, or invalid cached content is unavailable — never a cue
 * to substitute the current/default revision.
 */
export async function loadCoachCallScript(clientCallId: string): Promise<{
  ref: ScriptRef;
  bundle: ScriptBundle;
} | null> {
  if (typeof clientCallId !== "string" || !clientCallId) return null;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return null;
  const calls = supabase as unknown as OwnedCallClient;
  const result = await calls.from("coach_call_index")
    .select("script_slug, script_revision, script_digest, coach_script_revisions!coach_call_index_script_binding_fkey(bundle)")
    .eq("client_call_id", clientCallId)
    .eq("operator_user_id", user.id)
    .maybeSingle();
  if (result.error || !result.data || typeof result.data !== "object") return null;
  const row = result.data as {
    script_slug?: unknown; script_revision?: unknown; script_digest?: unknown; coach_script_revisions?: unknown;
  };
  const revision = Array.isArray(row.coach_script_revisions) ? row.coach_script_revisions[0] : row.coach_script_revisions;
  if (
    typeof row.script_slug !== "string" || !Number.isInteger(row.script_revision) ||
    typeof row.script_digest !== "string" || !revision || typeof revision !== "object" ||
    !("bundle" in revision)
  ) return null;
  try {
    assertValidScriptBundle((revision as { bundle: unknown }).bundle);
  } catch {
    return null;
  }
  return {
    ref: { slug: row.script_slug, revision: row.script_revision as number, digest: row.script_digest },
    bundle: (revision as { bundle: ScriptBundle }).bundle,
  };
}
