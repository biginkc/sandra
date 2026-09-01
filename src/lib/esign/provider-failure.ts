import { ProviderError } from "@/lib/errors/classes";

export type ProviderFailureOutcome = "ambiguous" | "definitive_failure";

export function classifyProviderFailure(
  error: unknown,
): ProviderFailureOutcome {
  if (error instanceof ProviderError) {
    const status =
      typeof error.details?.statusCode === "number"
        ? error.details.statusCode
        : 0;
    if (
      error.details?.retryable === true ||
      status === 408 ||
      status === 429 ||
      status >= 500
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
  const message = error.message.toLowerCase();
  const identifiesUnfinishedTemplate =
    message.includes("unfinished template") ||
    message.includes("template is still a draft") ||
    message.includes("template is not yet finalized");
  return (
    error.details?.statusCode === 400 &&
    error.details?.providerCode === "bad_request" &&
    error.details?.retryable !== true &&
    identifiesUnfinishedTemplate
  );
}
