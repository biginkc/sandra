import type { ErrorClass } from "./classes";

export type ReportContext = {
  errorClass?: ErrorClass;
  tags?: Record<string, string | number | boolean>;
  user?: { id: string } | null;
  extra?: Record<string, unknown>;
};

export function reportError(err: unknown, context: ReportContext = {}): void {
  // Swap to Sentry/Axiom/BetterStack when observability vendor is picked (risk #20).
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
