import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/errors/sentry-privacy";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
