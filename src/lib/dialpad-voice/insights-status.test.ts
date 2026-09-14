import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { DialpadInsightsDatabase } from "./insights-database.generated";
import { resolveDialpadInsightStatus } from "./insights-status";

function harness(status: string | null, failed = false) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
    failed ? { message: "private database diagnostic" } : status ? { status } : null,
    { status: failed ? 500 : 200 },
  ));
  const client = createClient<DialpadInsightsDatabase>("https://fixture.supabase.co", "fixture-key", {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, fetcher };
}
describe("Dialpad insight processing status", () => {
  it("reports exhausted and quarantined jobs as failed with scoped metadata-only reads", async () => {
    for (const state of ["failed", "quarantined"]) {
      const h = harness(state);
      expect(await resolveDialpadInsightStatus(h.client, "org", "123", "call_transcription", null)).toBe("failed");
      const url = new URL(String(h.fetcher.mock.calls[0][0]));
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        select: "status", org_id: "eq.org", "payload->>call_id": "eq.123",
        "payload->>state": "eq.call_transcription", limit: "1", order: "received_at.desc,id.desc",
      });
    }
  });
  it("preserves completed results even when refresh has failed", async () => {
    const h = harness("failed");
    for (const status of ["available", "none"]) expect(await resolveDialpadInsightStatus(h.client, "org", "123", "recap_summary", status)).toBe(status);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("keeps active and absent jobs pending", async () => {
    for (const status of [null, "pending", "processing", "retry"]) {
      const h = harness(status);
      expect(await resolveDialpadInsightStatus(h.client, "org", "123", "recap_summary", null)).toBe("pending");
    }
  });
  it("does not turn a database outage into a pending or failed artifact", async () => {
    const h = harness(null, true);
    await expect(resolveDialpadInsightStatus(h.client, "org", "123", "recap_summary", null)).rejects.toThrow("Insight processing status unavailable");
  });
});
