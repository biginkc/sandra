import { toast } from "sonner";

import type { Result } from "./result";

export type CallActionOptions = {
  /** Toast title on success. Omit to stay silent. */
  successMessage?: string;
  /** Fallback title when the action errors without a human-readable message. */
  fallbackMessage?: string;
};

/**
 * Wrap a server-action call so that any failure surfaces as a toast instead
 * of a silent rejection. Returns the original `Result` so callers can still
 * branch on `ok`. Throws are also caught and toasted — the server action
 * boundary should return typed `Result` values, but defensive wrapping here
 * protects against anything that escapes (network errors, etc.).
 */
export async function callAction<T>(
  actionPromise: Promise<Result<T>>,
  options: CallActionOptions = {},
): Promise<Result<T>> {
  try {
    const result = await actionPromise;
    if (result.ok) {
      if (options.successMessage) toast.success(options.successMessage);
    } else {
      toast.error(result.error.message || options.fallbackMessage || "Action failed", {
        description: result.error.code,
      });
    }
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    toast.error(options.fallbackMessage ?? "Unexpected error", {
      description: message,
    });
    return {
      ok: false,
      error: {
        code: "UNEXPECTED_ERROR",
        message,
      },
    };
  }
}
