/** A linked provider call updates its original attempt, regardless of the UI source label. */
export function finalizesExistingAttempt(input: { source?: unknown; callActivityId?: unknown }): boolean {
  return input.source === "sandra" || (input.source === "dialpad" &&
    typeof input.callActivityId === "string" && input.callActivityId.trim().length > 0)
}
