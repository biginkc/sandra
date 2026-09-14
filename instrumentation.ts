import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/errors/sentry-privacy";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubSentryEvent });
  }
  if (process.env.NEXT_RUNTIME === "edge" && process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubSentryEvent });
  }
}

export const onRequestError = Sentry.captureRequestError;
