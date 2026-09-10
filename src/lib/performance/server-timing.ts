import "server-only";
import { SpanStatusCode, trace } from "@opentelemetry/api";

export const PERFORMANCE_OPERATIONS = [
  "messages.page", "messages.detail", "messages.detail.api", "messages.inbox.api",
  "leads.page", "leads.detail", "roster.identities", "supabase.request",
] as const;
export type PerformanceOperation = typeof PERFORMANCE_OPERATIONS[number];

export async function withPerformanceSpan<T>(name: PerformanceOperation, task: () => T | PromiseLike<T>): Promise<T> {
  return trace.getTracer("sandra.performance").startActiveSpan(name, async (span) => {
    try {
      return await task();
    } catch (error) {
      // No exception text/stack: provider errors can contain customer content.
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

const RESOURCES = new Set([
  "messages", "contacts", "properties", "memberships", "organizations", "counties",
  "consent_events", "sms_phone_suppressions", "message_threads", "ai_disposition_reviews",
  "tasks", "lead_notes", "lead_events", "call_activities", "property_tags", "tags",
  "sms_inbox_thread_page_snapshot", "user_integration_prefs",
]);

/** Classify, never retain, URLs. IDs, query strings and unknown paths are dropped. */
export function classifySupabaseRequest(input: RequestInfo | URL): string {
  try {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/auth/v1/user") return "auth.user";
    if (/^\/auth\/v1\/admin\/users\/[^/]+$/.test(path)) return "auth.identity";
    const resource = path.match(/^\/rest\/v1\/(?:rpc\/)?([^/]+)$/)?.[1];
    return resource && RESOURCES.has(resource) ? resource : "other";
  } catch {
    return "other";
  }
}

/** Instrument only an explicitly measured request scope, not all app/provider
 * traffic. fetch's result measures response headers; outer spans include parse. */
export const performanceFetch: typeof fetch = async (input, init) => {
  if (!trace.getActiveSpan() || process.env.SANDRA_PERFORMANCE_TELEMETRY !== "1") {
    return fetch(input, init);
  }
  return withPerformanceSpan("supabase.request", async () => {
    const span = trace.getActiveSpan();
    span?.setAttribute("sandra.resource", classifySupabaseRequest(input));
    const response = await fetch(input, init);
    span?.setAttribute("sandra.http_status", response.status);
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length)) span?.setAttribute("sandra.response_bytes", Number(length));
    if (!response.ok) span?.setStatus({ code: SpanStatusCode.ERROR });
    return response;
  });
};
