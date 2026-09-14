import * as Sentry from "@sentry/nextjs";
import { ensureSentryServerClient } from "./lib/errors/sentry-server-client";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) => {
  if (!ensureSentryServerClient()) return;
  Sentry.withScope((scope) => {
    scope.setTag("surface", "server_request");
    scope.setTag("routePattern", context.routePath);
    scope.setTag("routeType", context.routeType);
    Sentry.captureRequestError(error, request, context);
  });
};
