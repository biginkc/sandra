import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/errors/sentry-privacy";
import { ensureSentryServerClient } from "./src/lib/errors/sentry-server-client";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubSentryEvent });
  }
  if (process.env.NEXT_RUNTIME === "edge" && process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubSentryEvent });
  }
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
