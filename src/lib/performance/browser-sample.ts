const flows = new Set(["messages.selection", "messages.page", "leads.page", "leads.detail"]);
const outcomes = new Set(["completed", "failed", "cancelled"]);
export function parseBrowserSample(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.flow !== "string" || !flows.has(input.flow) || input.stage !== "usable_dom" ||
    typeof input.outcome !== "string" || !outcomes.has(input.outcome) ||
    typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 300_000) return null;
  return {
    flow: input.flow, stage: "usable_dom", outcome: input.outcome, durationMs: Math.round(input.durationMs * 10) / 10,
    ...(typeof input.traceId === "string" && /^[a-f0-9]{32}$/.test(input.traceId) ? { traceId: input.traceId } : {}),
  };
}
