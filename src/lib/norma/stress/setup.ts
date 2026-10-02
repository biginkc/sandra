import { vi } from "vitest";

/**
 * Stress-gate test setup. Nothing here may reach a real service:
 *  - reportError is captured in memory (no Sentry, no console flood);
 *  - lead-event recording done by app code outside the database is a no-op
 *    (the SQL functions write their own events, which the audit triggers see).
 */
export type CapturedReport = { message: string; surface: string | null; extra: unknown };
const reports: CapturedReport[] = [];
(globalThis as { __normaStressReports?: CapturedReport[] }).__normaStressReports = reports;

vi.mock("@/lib/errors/report", () => ({
  reportError: (err: unknown, ctx?: { tags?: Record<string, unknown>; extra?: unknown }) => {
    reports.push({
      message: err instanceof Error ? err.message : String(err),
      surface: typeof ctx?.tags?.surface === "string" ? ctx.tags.surface : null,
      extra: ctx?.extra,
    });
  },
}));

vi.mock("@/lib/events", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/events")>();
  return { ...original, recordLeadEvent: async () => undefined, recordLeadEvents: async () => undefined };
});
