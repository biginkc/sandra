import * as Sentry from "@sentry/nextjs";
import { ensureSentryServerClient } from "./src/lib/errors/sentry-server-client";

export async function register() {
  if (process.env.VERCEL_ENV === "preview") console.info("[sentry-instrumentation] register", process.env.NEXT_RUNTIME);
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) => {
  if (process.env.VERCEL_ENV === "preview") console.info("[sentry-instrumentation] request-error");
  if (!ensureSentryServerClient()) return;
  Sentry.withScope((scope) => {
    scope.setTag("surface", "server_request");
    scope.setTag("routePattern", context.routePath);
    scope.setTag("routeType", context.routeType);
    Sentry.captureRequestError(error, request, context);
  });
};
