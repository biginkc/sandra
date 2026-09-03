import { ProviderError } from "@/lib/errors/classes";

export type ProviderFailureOutcome =
  | "ambiguous"
  | "definitive_failure"
  | "provider_plan_required";

export type SafeProviderFailure = {
  outcome: ProviderFailureOutcome;
  code: string;
  message: string;
};

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

/**
 * Return the only error shape that a provider-facing script may print.
 * Provider response bodies and exception messages can contain credentials or
 * document data, so callers must not serialize the original error.
 */
export function safeProviderFailure(error: unknown): SafeProviderFailure {
  const outcome = classifyProviderFailure(error);
  const code = safeCode(error);
  const message =
    outcome === "provider_plan_required"
      ? "Dropbox Sign requires a plan capable of exporting templates."
      : outcome === "definitive_failure"
        ? "Dropbox Sign rejected the template export."
        : "The template export could not be confirmed.";
  return { outcome, code, message };
}

function safeCode(error: unknown): string {
  if (error instanceof ProviderError) {
    const providerCode = error.details?.providerCode;
    if (typeof providerCode === "string" && /^[a-z0-9_]{1,64}$/i.test(providerCode)) {
      return providerCode.toUpperCase();
    }
    return "PROVIDER_ERROR";
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  return "EXPORT_FAILED";
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
