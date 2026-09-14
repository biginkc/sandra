import * as Sentry from "@sentry/nextjs";
import { ensureSentryServerClient } from "./lib/errors/sentry-server-client";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = async (
  error: Parameters<typeof Sentry.captureRequestError>[0],
  request: Parameters<typeof Sentry.captureRequestError>[1],
  context: Parameters<typeof Sentry.captureRequestError>[2],
) => {
  if (!ensureSentryServerClient()) return;
  Sentry.withScope((scope) => {
    scope.setTag("surface", "server_request");
    scope.setTag("routePattern", context.routePath);
    scope.setTag("routeType", context.routeType);
    Sentry.captureRequestError(error, request, context);
  });
  await Sentry.flush(2_000);
};
