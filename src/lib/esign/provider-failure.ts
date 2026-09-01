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
