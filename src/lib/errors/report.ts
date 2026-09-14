import type { ErrorClass } from "./classes";
import * as Sentry from "@sentry/nextjs";

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
  if (Sentry.getClient()) {
    Sentry.withScope((scope) => {
      if (context.errorClass) scope.setTag("errorClass", context.errorClass);
      scope.setTag("surface", "handled");
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
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
