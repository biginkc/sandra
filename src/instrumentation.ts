import * as Sentry from "@sentry/nextjs";
import { ensureSentryServerClient } from "./lib/errors/sentry-server-client";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = async (error: unknown, _request: unknown, context: { routePath: string; routeType: string }) => {
  const active = ensureSentryServerClient();
  if (!active) return;
  Sentry.withScope((scope) => {
    scope.setTag("surface", "server_request");
    scope.setTag("errorClass", "unexpected");
    scope.setTag("routePattern", context.routePath);
    scope.setTag("routeType", context.routeType);
    Sentry.captureException(error, {
      mechanism: { handled: false, type: "auto.function.nextjs.on_request_error" },
    });
  });
  await Sentry.flush(2_000);
};
