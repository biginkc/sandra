import type { ErrorEvent } from "@sentry/nextjs";

const SAFE_TAGS = new Set(["surface", "operation", "kind", "phase", "outcome", "errorClass", "code", "httpStatus"]);
const SAFE_TOKEN = /^[a-zA-Z][a-zA-Z0-9_:-]{0,79}$/;
const SAFE_CODE = /^[a-zA-Z][a-zA-Z0-9_:-]{0,39}$/;

export function safeDiagnosticToken(value: unknown, code = false): string | undefined {
  if (typeof value !== "string" || !(code ? SAFE_CODE : SAFE_TOKEN).test(value)) return undefined;
  // Reject common opaque record IDs even when they happen to match the token
  // grammar. Tags are for classifications, never correlation to a business row.
  if (/\d{8,}|[a-f0-9]{16,}/i.test(value)) return undefined;
  return value;
}

export function safeSentryTags(tags: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!SAFE_TAGS.has(key)) continue;
    const safe = key === "httpStatus"
      ? (Number.isInteger(Number(value)) && Number(value) >= 100 && Number(value) <= 599 ? String(value) : undefined)
      : safeDiagnosticToken(value, key === "code");
    if (safe) result[key] = safe;
  }
  return result;
}

// Static source locations retain symbolication; dynamic routes, queries, and
// fragments can carry business IDs or credentials and must not leave Sandra.
function safeFrameLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value.split(/[?#]/, 1)[0];
  if (stripped.length > 400 || !/\.(?:js|mjs|cjs|jsx|ts|tsx)$/.test(stripped)) return undefined;
  if (/^(?:https?:\/\/[^/]+)?\/_next\/static\/[a-zA-Z0-9_./-]+$/.test(stripped)) return stripped;
  if (/^app:\/\/\/_next\/[a-zA-Z0-9_./-]+$/.test(stripped)) return stripped;
  if (/^(?:webpack-internal:\/\/\/)?(?:\.?\/?(?:src\/)?)[a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|jsx|ts|tsx)$/.test(stripped)) return stripped;
  return undefined;
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  // Construct an allowlisted envelope: integrations can put customer data in
  // fields beyond request, user, extra, contexts, and breadcrumbs.
  const tags = safeSentryTags(event.tags ?? {});
  const result: ErrorEvent = {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    dist: event.dist,
    tags: { surface: tags.surface ?? "unknown", errorClass: tags.errorClass ?? "unknown", ...tags },
  };
  if (tags.kind === "state" && tags.operation && tags.outcome) {
    // Stable, low-cardinality grouping. Never copy a caller-supplied
    // fingerprint: it may contain a customer or business-record ID.
    result.fingerprint = ["sandra-state", tags.operation, tags.outcome];
  } else if (tags.kind && tags.operation) {
    result.fingerprint = ["sandra-diagnostic", tags.surface ?? "unknown", tags.operation, tags.kind, tags.code ?? "unclassified"];
  }
  const images = event.debug_meta?.images?.flatMap((image) =>
    image.type === "sourcemap" && /^[a-f0-9-]{36}$/i.test(image.debug_id)
      && safeFrameLocation(image.code_file)
      ? [{ type: "sourcemap" as const, debug_id: image.debug_id, code_file: safeFrameLocation(image.code_file)! }]
      : [],
  );
  if (images?.length) result.debug_meta = { images };
  if (event.sdk?.name === "sentry.javascript.nextjs" && typeof event.sdk.version === "string"
    && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(event.sdk.version)) {
    result.sdk = { name: event.sdk.name, version: event.sdk.version };
  }
  if (event.contexts?.trace) {
    const { trace_id, span_id } = event.contexts.trace;
    if (typeof trace_id === "string" && /^[a-f0-9]{32}$/i.test(trace_id)
      && typeof span_id === "string" && /^[a-f0-9]{16}$/i.test(span_id)) {
      result.contexts = { trace: { trace_id, span_id } };
    }
  }
  if (event.exception?.values) {
    const code = tags.code ?? "unclassified";
    result.exception = { values: event.exception.values.map((exception) => ({
      type: safeDiagnosticToken(exception.type) ?? "Error",
      value: `${tags.errorClass ?? "unknown"}:${code}`,
      ...(exception.stacktrace ? { stacktrace: {
        frames: (exception.stacktrace.frames ?? []).map((frame) => ({
          ...(safeFrameLocation(frame.filename) ? { filename: safeFrameLocation(frame.filename) } : {}),
          ...(safeFrameLocation(frame.abs_path) ? { abs_path: safeFrameLocation(frame.abs_path) } : {}),
          ...(Number.isInteger(frame.lineno) ? { lineno: frame.lineno } : {}),
          ...(Number.isInteger(frame.colno) ? { colno: frame.colno } : {}),
          ...(safeDiagnosticToken(frame.function) ? { function: frame.function } : {}),
          ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
        })),
      } } : {}),
    })) };
  }
  return result;
}
