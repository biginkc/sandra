import type { ErrorEvent } from "@sentry/nextjs";

// Sandra handles phone numbers, message bodies, signed URLs, and webhook secrets.
// Keep stack frames for grouping, but do not send request or application payloads.
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.contexts;
  delete event.breadcrumbs;
  delete event.transaction;
  delete event.message;
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      exception.value = "Redacted Sandra error";
      // Stack frame arguments and variables can contain customer data.
      for (const frame of exception.stacktrace?.frames ?? []) {
        delete frame.vars;
        delete frame.context_line;
        delete frame.pre_context;
        delete frame.post_context;
        delete frame.abs_path;
      }
    }
  }
  event.tags = { surface: event.tags?.surface ?? "unknown", errorClass: event.tags?.errorClass ?? "unknown" };
  return event;
}
