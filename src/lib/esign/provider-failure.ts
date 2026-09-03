import { ProviderError } from "@/lib/errors/classes";

export type ProviderFailureOutcome =
  | "ambiguous"
  | "definitive_failure"
  | "provider_plan_required";

export function classifyProviderFailure(
  error: unknown,
): ProviderFailureOutcome {
  if (error instanceof ProviderError) {
    const status =
      typeof error.details?.statusCode === "number"
        ? error.details.statusCode
        : 0;
    if (status === 402) return "provider_plan_required";
    if (
      error.details?.retryable === true ||
      status === 408 ||
      status === 429
    ) {
      return "ambiguous";
    }
    if (status >= 400 && status < 500) return "definitive_failure";
  }
  return "ambiguous";
}

export function isRestartableDraftEditorFailure(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.provider !== "dropbox_sign") {
    return false;
  }
  return (
    error.details?.statusCode === 404 &&
    error.details?.providerCode === "not_found" &&
    error.details?.retryable !== true
  );
}
