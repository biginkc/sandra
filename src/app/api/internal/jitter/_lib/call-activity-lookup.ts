const SOFTPHONE_PROVIDER = "sandra_softphone";

function quotePostgrestFilterValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Provider/session predicate shared by the attempt-scoped artifact routes.
 * Jitter rows require the requested session; a softphone row may still have
 * its session unset during the handoff, or may already have the same scope.
 */
export function callActivityAttemptProviderFilter(scopeId: string): string {
  const quotedScopeId = quotePostgrestFilterValue(scopeId);
  return [
    `and(provider.eq.jitter,jitter_session_id.eq.${quotedScopeId})`,
    `and(provider.eq.${SOFTPHONE_PROVIDER},jitter_session_id.is.null)`,
    `and(provider.eq.${SOFTPHONE_PROVIDER},jitter_session_id.eq.${quotedScopeId})`,
  ].join(",");
}
