import type { Configuration } from "@vercel/otel";
import { PERFORMANCE_OPERATIONS } from "./server-timing";

type Exporter = Exclude<NonNullable<Configuration["traceExporter"]>, string>;
const names = new Set<string>(PERFORMANCE_OPERATIONS);
const safeAttributes = new Set(["sandra.resource", "sandra.http_status", "sandra.response_bytes"]);

/** Export only our bounded operation vocabulary, never automatic Next/fetch
 * URLs, exception events, resource metadata, headers, or arbitrary attributes.
 * Structured runtime logs use existing retention/export plumbing; no paid
 * collector or provider tracing integration is automatically activated. */
export const performanceExporter: Exporter = {
  export(spans, done) {
    try {
      if (process.env.SANDRA_PERFORMANCE_TELEMETRY === "1") {
        for (const span of spans) {
          if (!names.has(span.name) || span.instrumentationScope.name !== "sandra.performance") continue;
          const attributes = Object.fromEntries(Object.entries(span.attributes).filter(([key, value]) =>
            safeAttributes.has(key) && (typeof value === "number" || typeof value === "string" && /^[a-z_.]{1,64}$/.test(value))));
          console.info(JSON.stringify({
            event: "sandra.performance", version: 1, operation: span.name,
            traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
            durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
            time: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString(),
            outcome: span.status.code === 2 ? "error" : "completed",
            deployment: /^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA : "local",
            region: /^[a-z]{3}\d$/.test(process.env.VERCEL_REGION ?? "") ? process.env.VERCEL_REGION : "unknown",
            ...attributes,
          }));
        }
      }
      done({ code: 0 });
    } catch {
      // Observability must not make the request fail or echo an export error.
      done({ code: 1 });
    }
  },
  async shutdown() {},
};
