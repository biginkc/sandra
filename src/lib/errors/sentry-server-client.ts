import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./sentry-privacy";

/** Workflow steps and Vercel functions can run in a separate SDK module context. */
export function ensureSentryServerClient(): boolean {
  if (Sentry.getClient()) return true;
  if (typeof window !== "undefined" || !process.env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });
  return Boolean(Sentry.getClient());
}
