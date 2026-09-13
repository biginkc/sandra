import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadInsightsDatabase } from "./insights-database.generated";
import { ingestDialpadInsights, parseDialpadTranscript } from "./insights";
function harness() {
 const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "activity" } }); const eq = vi.fn();
 const q = { select: () => q, eq, maybeSingle }; eq.mockReturnValue(q);
 const rpc = vi.fn().mockResolvedValue({ data: true });
 const client = { from: () => q, rpc } as unknown as SupabaseClient<DialpadInsightsDatabase>;
 const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ call_id: "123", lines: [{ content: "fixture", name: "Rep", time: "00:01", type: "moment", user_id: "u" }] }));
 const run = (state = "call_transcription", extra = {}) => ingestDialpadInsights({ client, orgId: "org", providerCallId: "123", state, payload: { call_id: "123", state, event_timestamp: 200, ...extra }, apiKey: "secret", fetchImpl });
 return { maybeSingle, eq, rpc, fetchImpl, run };
}
describe("post-call insights", () => {
 it("fetches matching transcript and preserves typed lines", async () => {
  const h = harness(); await h.run();
  expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_kind: "transcript", p_text: "[moment] 00:01 Rep: fixture", p_org_id: "org" });
  expect(h.fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
 });
 it("treats completed empty transcript as an explicit empty result", async () => { expect(parseDialpadTranscript({ call_id: "123", lines: [] }, "123")).toEqual({ text: "", lines: [] }); });
 it("rejects mismatched or malformed transcript", () => {
  expect(() => parseDialpadTranscript({ call_id: "456", lines: [] }, "123")).toThrow();
  expect(() => parseDialpadTranscript({ call_id: "123", lines: [{}] }, "123")).toThrow();
 });
 it("retries missing activity before provider fetch", async () => {
  const h = harness(); h.maybeSingle.mockResolvedValue({ data: null }); await expect(h.run()).rejects.toThrow("Dialpad insight unavailable"); expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
 });
 it("persists signed recap without transcript fetch", async () => {
  const h = harness(); await h.run("recap_summary", { recap_summary: "summary fixture" });
  expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_kind: "summary", p_text: "summary fixture" }); expect(h.fetchImpl).not.toHaveBeenCalled();
 });
 it("rejects incomplete recap instead of erasing stored data", async () => { const h = harness(); await expect(h.run("recap_summary")).rejects.toThrow(); expect(h.rpc).not.toHaveBeenCalled(); });
 it("sanitizes provider failure and does not write", async () => { const h = harness(); h.fetchImpl.mockRejectedValue(Error("secret")); await expect(h.run()).rejects.toThrow(/^Dialpad insight unavailable$/); expect(h.rpc).not.toHaveBeenCalled(); });
 it("retries database race where activity disappears", async () => { const h = harness(); h.rpc.mockResolvedValue({ data: false }); await expect(h.run()).rejects.toThrow(); });
});
