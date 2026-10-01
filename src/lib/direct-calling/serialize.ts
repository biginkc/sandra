import type { CleanupSpec } from "./transitions";

/**
 * Wire shape of one cleanup obligation as direct_call_apply (SQL) reads it from p_cleanups. This is the one
 * serializer: the store sends it, and the migration integration test drives the SQL with its output.
 */
export type CleanupSpecJson =
  | { kind: "leg"; leg_id: string }
  | { kind: "unresolved_dial"; role: "browser" | "seller"; timeout_secs: number; time_limit_secs: number };

export function cleanupSpecToJson(spec: CleanupSpec): CleanupSpecJson {
  if (spec.kind === "leg") return { kind: "leg", leg_id: spec.legId };
  return { kind: "unresolved_dial", role: spec.role, timeout_secs: spec.timeoutSecs, time_limit_secs: spec.timeLimitSecs };
}
