import type { ErrorClass } from "./classes";
import * as Sentry from "@sentry/nextjs";
import { safeDiagnosticToken, safeSentryTags } from "./sentry-privacy";
import { ensureSentryServerClient } from "./sentry-server-client";

export type ReportContext = {
  errorClass?: ErrorClass;
  tags?: Record<string, string | number | boolean>;
  user?: { id: string } | null;
  extra?: Record<string, unknown>;
};

export function reportError(err: unknown, context: ReportContext = {}): void {
  const payload = {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : "Unknown",
    stack: err instanceof Error ? err.stack : undefined,
    errorClass: context.errorClass,
    tags: context.tags,
    user: context.user,
    extra: context.extra,
  };
  console.error("[reportError]", payload);
  if (ensureSentryServerClient()) {
    const fields = err !== null && typeof err === "object" ? err as Record<string, unknown> : {};
    const code = safeDiagnosticToken(fields.code, true)
      ?? safeDiagnosticToken(fields.name)
      ?? (err instanceof Error ? safeDiagnosticToken(err.name) : undefined);
    const httpStatus = typeof fields.status === "number" ? fields.status : fields.statusCode;
    const safeTags = safeSentryTags({ ...context.tags,
      ...(context.errorClass ? { errorClass: context.errorClass } : {}),
      ...(code ? { code } : {}),
      ...(httpStatus != null ? { httpStatus } : {}),
    });
    const normalized = err instanceof Error ? err : new Error(
      `${context.errorClass ?? "unknown"}:${code ?? "unclassified"}`,
    );
    if (!(err instanceof Error)) normalized.name = "StructuredError";
    Sentry.withScope((scope) => {
      scope.setTag("surface", safeTags.surface ?? "handled");
      for (const [key, value] of Object.entries(safeTags)) scope.setTag(key, value);
      Sentry.captureException(normalized);
    });
  }
}

export function reportInfo(message: string, context: ReportContext = {}): void {
  const payload = {
    message,
    tags: context.tags,
    user: context.user,
    extra: context.extra,
  };
  console.info("[reportInfo]", payload);
}
