import type { SupabaseClient } from "@supabase/supabase-js";

const SOFTPHONE_ATTEMPT_PREFIX = "sandra-";
const SOFTPHONE_SCOPE_PREFIX = "sandra-softphone-session-";

type ArtifactIdentity =
  | { kind: "jitter" }
  | { kind: "softphone"; callId: string };

export type ArtifactCallActivityResolution =
  | { ok: true; activityId: string }
  | { ok: false; reason: "not_found" | "identity_conflict" };

export function classifyArtifactIdentity(
  attemptId: string,
  scopeId: string,
): ArtifactIdentity | null {
  const softphoneAttempt = attemptId.startsWith(SOFTPHONE_ATTEMPT_PREFIX);
  const softphoneScope = scopeId.startsWith(SOFTPHONE_SCOPE_PREFIX);
  if (!softphoneAttempt && !softphoneScope) return { kind: "jitter" };
  if (!softphoneAttempt || !softphoneScope) return null;

  const callId = attemptId.slice(SOFTPHONE_ATTEMPT_PREFIX.length);
  const scopeRest = scopeId.slice(SOFTPHONE_SCOPE_PREFIX.length);
  const separator = scopeRest.indexOf(":");
  if (!callId || separator <= 0 || separator === scopeRest.length - 1) return null;
  if (scopeRest.slice(0, separator) !== callId) return null;
  return { kind: "softphone", callId };
}

export async function resolveArtifactCallActivity(
  client: SupabaseClient<any>,
  input: { orgId: string; attemptId: string; scopeId: string },
): Promise<ArtifactCallActivityResolution> {
  const identity = classifyArtifactIdentity(input.attemptId, input.scopeId);
  if (!identity) return { ok: false, reason: "identity_conflict" };

  if (identity.kind === "jitter") {
    const { data, error } = await client
      .from("call_activities")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("provider", "jitter")
      .eq("jitter_attempt_id", input.attemptId)
      .eq("jitter_session_id", input.scopeId)
      .maybeSingle();
    if (error) throw error;
    return data
      ? { ok: true, activityId: data.id as string }
      : { ok: false, reason: "not_found" };
  }

  const exactParent = () => client
    .from("call_activities")
    .select("id, jitter_session_id")
    .eq("org_id", input.orgId)
    .eq("provider", "sandra_softphone")
    .eq("jitter_attempt_id", input.attemptId)
    .maybeSingle();

  const { data: parent, error: parentError } = await exactParent();
  if (parentError) throw parentError;
  if (!parent) return { ok: false, reason: "not_found" };
  if (parent.jitter_session_id === input.scopeId) {
    return { ok: true, activityId: parent.id as string };
  }
  if (parent.jitter_session_id !== null) {
    return { ok: false, reason: "identity_conflict" };
  }

  const { data: claimed, error: claimError } = await client
    .from("call_activities")
    .update({ jitter_session_id: input.scopeId })
    .eq("id", parent.id)
    .eq("org_id", input.orgId)
    .eq("provider", "sandra_softphone")
    .eq("jitter_attempt_id", input.attemptId)
    .is("jitter_session_id", null)
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (claimed) return { ok: true, activityId: claimed.id as string };

  const { data: racedParent, error: racedError } = await exactParent();
  if (racedError) throw racedError;
  if (!racedParent) return { ok: false, reason: "not_found" };
  return racedParent.jitter_session_id === input.scopeId
    ? { ok: true, activityId: racedParent.id as string }
    : { ok: false, reason: "identity_conflict" };
}
