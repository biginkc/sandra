import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/errors/sentry-privacy";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });
}
